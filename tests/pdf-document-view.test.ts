// @vitest-environment jsdom

/// גלילת הדפים הרציפה של מציג ה-PDF, מול מסמך pdf.js מדומה.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePage {
  readonly width: number;
  readonly height: number;
}

const pdf = vi.hoisted(() => ({
  workerSrc: '',
  pages: [] as FakePage[],
  outline: null as unknown,
  destinations: new Map<string, unknown[]>(),
  pageIndexOf: new Map<unknown, number>(),
  destroyed: 0,
  loadError: null as Error | null,
  loadDelay: null as Promise<void> | null,
  pageDelays: new Map<number, Promise<void>>(),
  pageErrors: new Map<number, Error>(),
  pageCalls: [] as number[],
  renderDelays: new Map<number, Promise<void>>(),
  renderCalls: [] as number[],
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {
    set workerSrc(value: string) {
      pdf.workerSrc = value;
    },
    get workerSrc(): string {
      return pdf.workerSrc;
    },
  },
  getDocument: () => ({
    promise: (async () => {
      if (pdf.loadDelay) await pdf.loadDelay;
      if (pdf.loadError) throw pdf.loadError;
      let destroyed = false;
      return {
        numPages: pdf.pages.length,
        getPage: async (pageNumber: number) => {
          pdf.pageCalls.push(pageNumber);
          await pdf.pageDelays.get(pageNumber);
          if (destroyed) throw new Error('המסמך כבר נסגר');
          const pageError = pdf.pageErrors.get(pageNumber);
          if (pageError) throw pageError;
          const size = pdf.pages[pageNumber - 1];
          if (!size) throw new Error(`אין עמוד ${pageNumber}`);
          return {
            getViewport: ({ scale }: { scale: number }) => ({
              width: size.width * scale,
              height: size.height * scale,
            }),
            render: () => {
              pdf.renderCalls.push(pageNumber);
              return { promise: pdf.renderDelays.get(pageNumber) ?? Promise.resolve(), cancel: () => undefined };
            },
          };
        },
        getOutline: () => Promise.resolve(pdf.outline),
        getDestination: (name: string) => Promise.resolve(pdf.destinations.get(name) ?? null),
        getPageIndex: (reference: unknown) => {
          const index = pdf.pageIndexOf.get(reference);
          return index === undefined
            ? Promise.reject(new Error('יעד לא מוכר'))
            : Promise.resolve(index);
        },
        destroy: () => {
          destroyed = true;
          pdf.destroyed += 1;
          return Promise.resolve();
        },
      };
    })(),
  }),
}));

const { PdfDocumentView } = await import('../src/viewer/pdf-document-view');

function createView(): {
  view: InstanceType<typeof PdfDocumentView>;
  viewport: HTMLElement;
  pages: HTMLElement;
  changes: Array<[number, number, number]>;
} {
  const viewport = document.createElement('div');
  const pages = document.createElement('div');
  viewport.append(pages);
  document.body.append(viewport);
  const view = new PdfDocumentView(viewport, pages, 'vendor/pdf.worker.min.mjs');
  const changes: Array<[number, number, number]> = [];
  view.onChanged = (page, count, zoom) => changes.push([page, count, zoom]);
  return { view, viewport, pages, changes };
}

beforeEach(() => {
  document.body.replaceChildren();
  pdf.pages = [
    { width: 400, height: 600 },
    { width: 400, height: 600 },
    { width: 800, height: 1000 },
  ];
  pdf.outline = null;
  pdf.destinations = new Map();
  pdf.pageIndexOf = new Map();
  pdf.destroyed = 0;
  pdf.loadError = null;
  pdf.loadDelay = null;
  pdf.pageDelays = new Map();
  pdf.pageErrors = new Map();
  pdf.pageCalls = [];
  pdf.renderDelays = new Map();
  pdf.renderCalls = [];
  // jsdom אינו מממש גלילה של אלמנט; הדפדפן חוסם גלילה שלילית.
  Object.defineProperty(Element.prototype, 'scrollTo', {
    value: function scrollTo(this: HTMLElement, options: { top?: number }) {
      if (typeof options?.top === 'number') this.scrollTop = Math.max(0, options.top);
    },
    configurable: true,
  });
});

describe('PdfDocumentView — פתיחה ופריסה', () => {
  it('מגדיר את ה-worker של pdf.js מהכתובת שנמסרה', () => {
    createView();
    expect(pdf.workerSrc).toBe('vendor/pdf.worker.min.mjs');
  });

  it('בונה מקום לכל דף לפי מידות המסמך', async () => {
    const { view, pages } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);

    const slots = [...pages.querySelectorAll<HTMLElement>('.pdf-page')];
    expect(slots).toHaveLength(3);
    expect(slots.map((slot) => slot.dataset.page)).toEqual(['1', '2', '3']);
    // יחס הגובה לרוחב נשמר, והדף הרחב קובע את קנה המידה.
    const first = slots[0]!;
    const widest = slots[2]!;
    await vi.waitFor(() => {
      expect(Number.parseInt(widest.style.width, 10)).toBeGreaterThan(
        Number.parseInt(first.style.width, 10),
      );
    });
    expect(view.pageCount).toBe(3);
    expect(view.zoom).toBe(1);
  });

  it('עמוד פתיחה מחוץ לטווח נחסם לגבולות הספר', async () => {
    const { view, changes } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 99);
    expect(view.currentPage).toBe(3);
    expect(changes.at(-1)).toEqual([3, 3, 1]);

    await view.open('http://127.0.0.1:8080/pdf/1', -4);
    expect(view.currentPage).toBe(1);
  });

  it('פתיחה חוזרת סוגרת את המסמך הקודם', async () => {
    const { view } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);
    expect(pdf.destroyed).toBe(0);
    await view.open('http://127.0.0.1:8080/pdf/2', 1);
    expect(pdf.destroyed).toBe(1);
  });

  it('סגירה מנקה את הדפים ואת המסמך', async () => {
    const { view, pages } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);
    await view.close();
    expect(pages.childElementCount).toBe(0);
    expect(view.pageCount).toBe(0);
    expect(pdf.destroyed).toBe(1);
  });

  it('כישלון בטעינה מועבר לקורא', async () => {
    const { view } = createView();
    pdf.loadError = new Error('הקובץ אינו זמין');
    await expect(view.open('http://127.0.0.1:8080/pdf/1', 1)).rejects.toThrow('הקובץ אינו זמין');
    expect(view.pageCount).toBe(0);
  });

  it('מסמך שהוחלף בזמן הטעינה מושמד ואינו מוצג', async () => {
    const { view, pages } = createView();
    let release!: () => void;
    pdf.loadDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = view.open('http://127.0.0.1:8080/pdf/1', 1);
    pdf.loadDelay = null;
    const fresh = view.open('http://127.0.0.1:8080/pdf/2', 2);
    release();
    await Promise.all([stale, fresh]);

    expect(pages.querySelectorAll('.pdf-page')).toHaveLength(3);
    expect(view.currentPage).toBe(2);
  });

  it.each([1, 3])('כישלון בטעינת עמוד %i סוגר את המסמך החלקי', async (pageNumber) => {
    const { view, pages } = createView();
    pdf.pageErrors.set(pageNumber, new Error('העמוד פגום'));
    await expect(view.open('http://127.0.0.1:8080/pdf/1', pageNumber)).rejects.toThrow('העמוד פגום');
    expect(view.pageCount).toBe(0);
    expect(pages.childElementCount).toBe(0);
    expect(pdf.destroyed).toBe(1);
  });

  it('מציג את עמוד הפתיחה לפני שעמוד אחר ומרוחק סיים להיטען', async () => {
    const { view, pages } = createView();
    let release!: () => void;
    pdf.pageDelays.set(2, new Promise<void>((resolve) => { release = resolve; }));
    const opened = view.open('http://127.0.0.1:8080/pdf/1', 3);
    await expect(opened).resolves.toBeUndefined();
    expect(view.currentPage).toBe(3);
    expect(pages.querySelectorAll('.pdf-page')).toHaveLength(3);
    expect(pages.querySelector<HTMLElement>('[data-page="3"]')?.style.height).not.toBe('');
    release();
  });

  it('מתחיל לטעון את עמוד היעד במקביל לעמוד הראשון', async () => {
    const { view } = createView();
    let release!: () => void;
    pdf.pageDelays.set(1, new Promise<void>((resolve) => { release = resolve; }));
    const opened = view.open('http://127.0.0.1:8080/pdf/1', 3);
    try {
      await vi.waitFor(() => expect(pdf.pageCalls).toContain(1));
      expect(pdf.pageCalls).toContain(3);
    } finally {
      release();
      await opened;
    }
  });

  it('מתקן גדלים שונים ברקע אחרי הצגת העמוד הראשון', async () => {
    const { view, pages } = createView();
    let release!: () => void;
    pdf.pageDelays.set(2, new Promise<void>((resolve) => { release = resolve; }));
    const opened = view.open('http://127.0.0.1:8080/pdf/1', 1);
    await expect(opened).resolves.toBeUndefined();
    const slots = [...pages.querySelectorAll<HTMLElement>('.pdf-page')];
    expect(slots[0]?.style.width).toBe(slots[2]?.style.width);
    release();
    await vi.waitFor(() => {
      expect(Number.parseInt(slots[2]!.style.width, 10)).toBeGreaterThan(
        Number.parseInt(slots[0]!.style.width, 10),
      );
    });
  });

  it('סגירה בזמן טעינת מסמך מונעת ממנו להופיע לאחר מכן', async () => {
    const { view, pages } = createView();
    let release!: () => void;
    pdf.loadDelay = new Promise<void>((resolve) => { release = resolve; });
    const opened = view.open('http://127.0.0.1:8080/pdf/1', 1);
    await Promise.resolve();
    await view.close();
    release();
    await opened;
    expect(pages.childElementCount).toBe(0);
    expect(view.pageCount).toBe(0);
    expect(pdf.destroyed).toBe(1);
  });

  it('סגירה בזמן טעינת העמוד הראשון אינה מציגה שגיאת מסמך סגור', async () => {
    const { view, pages } = createView();
    let release!: () => void;
    pdf.pageDelays.set(1, new Promise<void>((resolve) => { release = resolve; }));
    const opened = view.open('http://127.0.0.1:8080/pdf/1', 3);
    await vi.waitFor(() => expect(pdf.pageCalls).toContain(1));
    await view.close();
    release();
    await expect(opened).resolves.toBeUndefined();
    expect(pages.childElementCount).toBe(0);
  });

  it('שומר את עמוד העוגן בזמן שגובה דף קודם מתעדכן', async () => {
    pdf.pages = [
      { width: 400, height: 600 },
      { width: 400, height: 900 },
      { width: 400, height: 600 },
    ];
    const { view, viewport, pages } = createView();
    Object.defineProperty(viewport, 'clientWidth', { value: 800 });
    Object.defineProperty(viewport, 'clientHeight', { value: 700 });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: () => null, configurable: true });
    let release!: () => void;
    pdf.pageDelays.set(2, new Promise<void>((resolve) => { release = resolve; }));
    await view.open('http://127.0.0.1:8080/pdf/1', 3);
    const slots = [...pages.querySelectorAll<HTMLElement>('.pdf-page')];
    for (let index = 0; index < slots.length; index += 1) {
      Object.defineProperty(slots[index], 'offsetTop', {
        get: () => slots.slice(0, index).reduce((sum, slot) => sum + Number.parseInt(slot.style.height, 10), 0),
      });
      Object.defineProperty(slots[index], 'offsetHeight', {
        get: () => Number.parseInt(slots[index]!.style.height, 10),
      });
    }
    view.goToPage(3);
    const before = viewport.scrollTop;
    release();
    await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(before));
    expect(viewport.scrollTop).toBe(slots[2]!.offsetTop - 8);
    expect(view.currentPage).toBe(3);
  });

  it('מפסיק בקשות מטא־נתונים נוספות לאחר סגירת ספר ארוך', async () => {
    pdf.pages = Array.from({ length: 30 }, () => ({ width: 400, height: 600 }));
    const { view, pages } = createView();
    let release!: () => void;
    pdf.pageDelays.set(2, new Promise<void>((resolve) => { release = resolve; }));
    await view.open('http://127.0.0.1:8080/pdf/1', 1);
    await vi.waitFor(() => expect(pdf.pageCalls).toContain(2));
    await view.close();
    release();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    expect(Math.max(...pdf.pageCalls)).toBeLessThanOrEqual(9);
    expect(pages.childElementCount).toBe(0);
  });

  it('מרנדר מחדש עמוד גלוי אם קנה המידה השתנה בזמן שהרינדור הקודם המתין', async () => {
    const { view, viewport } = createView();
    Object.defineProperty(viewport, 'clientWidth', { value: 800 });
    Object.defineProperty(viewport, 'clientHeight', { value: 700 });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: () => ({}), configurable: true });
    let releasePage!: () => void;
    let releaseRender!: () => void;
    pdf.pageDelays.set(2, new Promise<void>((resolve) => { releasePage = resolve; }));
    pdf.renderDelays.set(1, new Promise<void>((resolve) => { releaseRender = resolve; }));
    await view.open('http://127.0.0.1:8080/pdf/1', 1);
    for (const slot of viewport.querySelectorAll<HTMLElement>('.pdf-page')) {
      Object.defineProperty(slot, 'offsetHeight', { get: () => Number.parseInt(slot.style.height, 10) });
    }
    view.setZoom(1.1);
    await vi.waitFor(() => expect(pdf.renderCalls).toContain(1));
    const page = viewport.querySelector<HTMLElement>('[data-page="1"]')!;
    const widthBefore = Number.parseInt(page.style.width, 10);
    releasePage();
    await vi.waitFor(() => expect(Number.parseInt(page.style.width, 10)).toBeLessThan(widthBefore));
    pdf.renderDelays.delete(1);
    releaseRender();
    await vi.waitFor(() => expect(pdf.renderCalls.filter((page) => page === 1).length).toBeGreaterThan(1));
  });
});

describe('PdfDocumentView — ניווט וזום', () => {
  it('קפיצה לעמוד נחסמת לטווח ומעגלת ערכים', async () => {
    const { view } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);

    view.goToPage(2.4);
    expect(view.currentPage).toBe(2);
    view.goToPage(100);
    expect(view.currentPage).toBe(3);
    view.goToPage(-1);
    expect(view.currentPage).toBe(1);
  });

  it('הבא והקודם נעצרים בקצוות', async () => {
    const { view } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);
    view.goPreviousPage();
    expect(view.currentPage).toBe(1);
    view.goNextPage();
    view.goNextPage();
    view.goNextPage();
    expect(view.currentPage).toBe(3);
  });

  it('ניווט בלי מסמך פתוח אינו עושה דבר', () => {
    const { view } = createView();
    view.goToPage(5);
    expect(view.currentPage).toBe(1);
    expect(view.pageCount).toBe(0);
  });

  it('הזום נחסם בטווח 0.1–20 ומתאפס ל-1', async () => {
    const { view } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);

    view.zoomBy(2);
    expect(view.zoom).toBe(2);
    view.setZoom(1_000);
    expect(view.zoom).toBe(20);
    view.setZoom(0);
    expect(view.zoom).toBe(0.1);
    view.resetZoom();
    expect(view.zoom).toBe(1);
  });

  it('שינוי זום מותח ומכווץ את גודל הדפים', async () => {
    const { view, pages } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);
    const slot = [...pages.querySelectorAll<HTMLElement>('.pdf-page')].at(-1)!;
    const height = (): number => Number.parseInt(slot.style.height, 10);

    view.setZoom(20);
    const enlarged = height();
    view.setZoom(1);
    const restored = height();
    expect(enlarged).toBeGreaterThan(restored);
    // הגדלה פי 20 מהמצב ההתחלתי, עד שגיאת עיגול לפיקסל.
    expect(Math.abs(enlarged - restored * 20)).toBeLessThanOrEqual(20);
  });

  it('גלגלת עם Ctrl מקרבת, ובלעדיו אינה משנה זום', async () => {
    const { view, viewport } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);

    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    expect(view.zoom).toBe(1);

    viewport.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true }),
    );
    expect(view.zoom).toBeCloseTo(1.1);

    viewport.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, cancelable: true }),
    );
    expect(view.zoom).toBeCloseTo(1);
  });

  it('גלילה ידנית מדווחת דרך מדדי הגלילה', async () => {
    const { view, viewport } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);
    view.scrollBy(120);
    expect(viewport.scrollTop).toBe(120);
    view.scrollVerticalTo(40);
    expect(view.verticalScrollMetrics.offset).toBe(40);
    view.scrollHorizontalTo(15);
    expect(view.horizontalScrollMetrics.offset).toBe(15);
  });
});

describe('PdfDocumentView — תוכן עניינים', () => {
  it('משטח את העץ לרמות ומתרגם יעדים לעמודים', async () => {
    const reference = { num: 12, gen: 0 };
    pdf.pageIndexOf.set(reference, 1);
    pdf.destinations.set('chapter-1', [reference]);
    pdf.outline = [
      {
        title: '  שער  ',
        dest: 'chapter-1',
        items: [{ title: 'פרק א', dest: [reference], items: [] }],
      },
      { title: 'בלי יעד', dest: null },
    ];

    const { view } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);
    await expect(view.outline()).resolves.toEqual([
      { title: 'שער', level: 0, pageNumber: 2 },
      { title: 'פרק א', level: 1, pageNumber: 2 },
      { title: 'בלי יעד', level: 0, pageNumber: null },
    ]);
  });

  it('יעד שאינו ניתן לפתרון מוחזר בלי מספר עמוד', async () => {
    pdf.outline = [{ title: 'פרק', dest: [{ unknown: true }] }];
    const { view } = createView();
    await view.open('http://127.0.0.1:8080/pdf/1', 1);
    await expect(view.outline()).resolves.toEqual([
      { title: 'פרק', level: 0, pageNumber: null },
    ]);
  });

  it('מסמך בלי תוכן עניינים ומסמך שלא נפתח מחזירים רשימה ריקה', async () => {
    const { view } = createView();
    await expect(view.outline()).resolves.toEqual([]);
    await view.open('http://127.0.0.1:8080/pdf/1', 1);
    await expect(view.outline()).resolves.toEqual([]);
  });
});
