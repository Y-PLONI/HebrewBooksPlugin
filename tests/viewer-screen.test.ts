// @vitest-environment jsdom

/// מסך ה-PDF של התוסף. מציג המסמך מוחלף בכפיל, כדי לבדוק את הסרגלים,
/// חלוניות הצד והקיצורים בלי לרנדר קובץ אמיתי.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface OutlineEntry {
  readonly title: string;
  readonly level: number;
  readonly pageNumber: number | null;
}

const view = vi.hoisted(() => ({
  opened: [] as Array<{ url: string; page: number }>,
  openError: null as Error | null,
  outline: [] as OutlineEntry[],
  goTo: [] as number[],
  zooms: [] as number[],
  thumbnails: [] as number[],
  scrolls: [] as number[],
  nextPages: 0,
  previousPages: 0,
  resets: 0,
  closes: 0,
  pageCount: 0,
  currentPage: 1,
  notifyChanged: null as ((page: number, count: number, zoom: number) => void) | null,
}));

vi.mock('../src/viewer/pdf-document-view', () => ({
  PdfDocumentView: class {
    onChanged: ((page: number, count: number, zoom: number) => void) | null = null;
    onScrolled: (() => void) | null = null;
    verticalScrollMetrics = { offset: 0, visible: 0, total: 0 };
    horizontalScrollMetrics = { offset: 0, visible: 0, total: 0 };

    constructor() {
      view.notifyChanged = (page, count, zoom) => this.onChanged?.(page, count, zoom);
    }

    get pageCount(): number {
      return view.pageCount;
    }

    get currentPage(): number {
      return view.currentPage;
    }

    async open(url: string, page: number): Promise<void> {
      view.opened.push({ url, page });
      if (view.openError) throw view.openError;
      view.currentPage = page;
    }

    close(): Promise<void> {
      view.closes += 1;
      return Promise.resolve();
    }

    outlineEntries(): OutlineEntry[] {
      return view.outline;
    }

    outline(): Promise<OutlineEntry[]> {
      return Promise.resolve(view.outline);
    }

    renderThumbnail(page: number): Promise<void> {
      view.thumbnails.push(page);
      return Promise.resolve();
    }

    goToPage(page: number): void {
      view.goTo.push(page);
      view.currentPage = page;
    }

    goNextPage(): void {
      view.nextPages += 1;
    }

    goPreviousPage(): void {
      view.previousPages += 1;
    }

    zoomBy(factor: number): void {
      view.zooms.push(factor);
    }

    resetZoom(): void {
      view.resets += 1;
    }

    handleResize(): void {}
    scrollBy(delta: number): void {
      view.scrolls.push(delta);
    }
    scrollVerticalTo(): void {}
    scrollHorizontalTo(): void {}
  },
}));

const { ViewerScreen } = await import('../src/screens/viewer-screen');

interface Handlers {
  onBack: ReturnType<typeof vi.fn>;
  onOpenTextEdition: ReturnType<typeof vi.fn>;
  onOpenWebsite: ReturnType<typeof vi.fn>;
  onInBookSearch: ReturnType<typeof vi.fn>;
}

function createScreen(): { screen: InstanceType<typeof ViewerScreen>; handlers: Handlers } {
  const handlers: Handlers = {
    onBack: vi.fn(),
    onOpenTextEdition: vi.fn(),
    onOpenWebsite: vi.fn(),
    onInBookSearch: vi.fn(),
  };
  const screen = new ViewerScreen(handlers, 'vendor/pdf.worker.min.mjs');
  document.body.append(screen.root);
  return { screen, handlers };
}

class RecordingIntersectionObserver {
  static instances: RecordingIntersectionObserver[] = [];
  readonly targets: Element[] = [];

  constructor(private readonly callback: IntersectionObserverCallback) {
    RecordingIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(target: Element): void {
    const index = this.targets.indexOf(target);
    if (index >= 0) this.targets.splice(index, 1);
  }

  disconnect(): void {
    this.targets.length = 0;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /// מדמה כניסה של הפריטים לתחום התצוגה.
  reveal(count = this.targets.length): void {
    const entries = this.targets
      .slice(0, count)
      .map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry);
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`אין כפתור עם הטקסט ${text}`);
  return button;
}

beforeEach(() => {
  view.opened.length = 0;
  view.openError = null;
  view.outline = [];
  view.goTo.length = 0;
  view.zooms.length = 0;
  view.thumbnails.length = 0;
  view.scrolls.length = 0;
  view.nextPages = 0;
  view.previousPages = 0;
  view.resets = 0;
  view.closes = 0;
  view.pageCount = 0;
  view.currentPage = 1;
  RecordingIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', RecordingIntersectionObserver);
  // jsdom אינו מממש גלילה של אלמנט.
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: () => undefined,
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('ViewerScreen — פתיחת ספר', () => {
  it('פותח את חלונית החיפוש עם עמודי ההתאמה', async () => {
    const { screen } = createScreen();
    view.pageCount = 12;
    await screen.openBook('קובץ שיטות קמאי', 'http://127.0.0.1:8080/pdf/1', [3, 8], 3);

    expect(view.opened).toEqual([{ url: 'http://127.0.0.1:8080/pdf/1', page: 3 }]);
    expect(screen.root.querySelector('.top-bar-title')?.textContent).toBe('קובץ שיטות קמאי');
    expect(screen.root.querySelector('.reader-pane')?.classList.contains('closed')).toBe(false);
    expect(screen.root.querySelector('.pane-result-count')?.textContent).toBe('נמצאו 2 תוצאות');
    expect(
      [...screen.root.querySelectorAll('.pane-result-tile')].map((tile) => tile.textContent),
    ).toEqual(['עמוד 3', 'עמוד 8']);
  });

  it('לחיצה על עמוד שנמצא מנווטת אליו', async () => {
    const { screen } = createScreen();
    await screen.openBook('ספר', 'http://127.0.0.1:8080/pdf/1', [4, 9], 4);
    [...screen.root.querySelectorAll<HTMLButtonElement>('.pane-result-tile')].at(-1)?.click();
    expect(view.goTo).toContain(9);
  });

  it('ספר בלי עמודי התאמה נפתח עם חלונית סגורה והודעת "אין תוצאות"', async () => {
    const { screen } = createScreen();
    await screen.openBook('ספר', 'http://127.0.0.1:8080/pdf/1', [], 1);
    expect(screen.root.querySelector('.reader-pane')?.classList.contains('closed')).toBe(true);
    expect(screen.root.querySelector('.pane-empty')?.textContent).toBe('אין תוצאות');
    expect(screen.root.querySelector('.pane-result-count')?.textContent).toBe('');
  });

  it('כישלון בפתיחה מוצג כשכבת שגיאה ומועבר הלאה', async () => {
    const { screen } = createScreen();
    view.openError = new Error('קובץ ה-PDF פגום');
    await expect(
      screen.openBook('ספר', 'http://127.0.0.1:8080/pdf/1', [], 1),
    ).rejects.toThrow('קובץ ה-PDF פגום');
    expect(screen.root.querySelector('.pdf-error-overlay h3')?.textContent).toBe(
      'לא ניתן לפתוח את הספר',
    );
    expect(screen.root.querySelector('.pdf-error-overlay p')?.textContent).toBe('קובץ ה-PDF פגום');
  });

  it('עדכון עמודי ההתאמה אחרי חיפוש חדש בונה מחדש את הרשימה', async () => {
    const { screen } = createScreen();
    await screen.openBook('ספר', 'http://127.0.0.1:8080/pdf/1', [2], 2);
    screen.setMatchPages([5, 6, 7]);
    expect(screen.root.querySelector('.pane-result-count')?.textContent).toBe('נמצאו 3 תוצאות');
    expect(screen.root.querySelectorAll('.pane-result-tile')).toHaveLength(3);
  });

  it('סגירת המסך סוגרת את המסמך', async () => {
    const { screen } = createScreen();
    await screen.openBook('ספר', 'http://127.0.0.1:8080/pdf/1', [], 1);
    await screen.close();
    expect(view.closes).toBeGreaterThan(0);
  });
});

describe('ViewerScreen — חלוניות הצד', () => {
  it('תוכן העניינים מנווט, ופריט בלי יעד מושבת', async () => {
    const { screen } = createScreen();
    view.outline = [
      { title: 'שער', level: 0, pageNumber: 1 },
      { title: 'הקדמה', level: 1, pageNumber: null },
    ];
    await screen.openBook('ספר', 'http://127.0.0.1:8080/pdf/1', [], 1);

    const items = [...screen.root.querySelectorAll<HTMLButtonElement>('.outline-item')];
    expect(items.map((item) => item.textContent)).toEqual(['שער', 'הקדמה']);
    expect(items[1]?.disabled).toBe(true);
    items[0]?.click();
    expect(view.goTo).toContain(1);
  });

  it('ספר בלי תוכן עניינים מציג הודעה', async () => {
    const { screen } = createScreen();
    await screen.openBook('ספר', 'http://127.0.0.1:8080/pdf/1', [], 1);
    expect(screen.root.querySelector('.outline-empty')?.textContent).toBe('אין תוכן עניינים');
  });

  it('תמונות ממוזערות מרונדרות רק כשהן נכנסות לתצוגה', async () => {
    const { screen } = createScreen();
    view.pageCount = 3;
    await screen.openBook('ספר', 'http://127.0.0.1:8080/pdf/1', [], 1);

    expect(screen.root.querySelectorAll('.thumbnail-item')).toHaveLength(3);
    expect(view.thumbnails).toEqual([]);

    const observer = RecordingIntersectionObserver.instances.at(-1);
    observer?.reveal(2);
    expect(view.thumbnails).toEqual([1, 2]);

    // רינדור חוזר אינו מתרחש לאותו עמוד.
    observer?.reveal();
    expect(view.thumbnails).toEqual([1, 2, 3]);
  });

  it('לחיצה על תמונה ממוזערת מנווטת לעמוד', async () => {
    const { screen } = createScreen();
    view.pageCount = 3;
    await screen.openBook('ספר', 'http://127.0.0.1:8080/pdf/1', [], 1);
    [...screen.root.querySelectorAll<HTMLButtonElement>('.thumbnail-item')].at(-1)?.click();
    expect(view.goTo).toContain(3);
  });

  it('לשוניות החלונית מחליפות את התצוגה הפעילה', () => {
    const { screen } = createScreen();
    const tabs = [...screen.root.querySelectorAll<HTMLButtonElement>('.panel-tab')];
    expect(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent).toBe(
      'חיפוש',
    );
    buttonByText(screen.root, 'דפים').click();
    const active = [...screen.root.querySelectorAll<HTMLButtonElement>('.panel-tab')].find(
      (tab) => tab.getAttribute('aria-selected') === 'true',
    );
    expect(active?.textContent).toBe('דפים');
  });

  it('חיפוש בתוך הספר משוגר ב-Enter בלבד, ורק כשיש טקסט', () => {
    const { screen, handlers } = createScreen();
    const field = screen.root.querySelector<HTMLInputElement>('.otzaria-search-field input')!;
    field.value = '   ';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(handlers.onInBookSearch).not.toHaveBeenCalled();

    field.value = 'ברכת המזון';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(handlers.onInBookSearch).not.toHaveBeenCalled();

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(handlers.onInBookSearch).toHaveBeenCalledWith('ברכת המזון');
  });

  it('כפתור הניקוי מרוקן את שדה החיפוש', () => {
    const { screen } = createScreen();
    screen.setSearchQuery('ברכת המזון');
    const field = screen.root.querySelector<HTMLInputElement>('.otzaria-search-field input')!;
    expect(field.value).toBe('ברכת המזון');
    screen.root.querySelector<HTMLButtonElement>('.pane-action-button')?.click();
    expect(field.value).toBe('');
  });
});

describe('ViewerScreen — ניווט, זום וסרגל', () => {
  it('מציג "עמוד/סה״כ" ומאפשר קפיצה למספר דף', () => {
    const { screen } = createScreen();
    view.pageCount = 20;
    view.notifyChanged?.(4, 20, 1);
    const display = screen.root.querySelector('.page-number-display');
    expect(display?.textContent).toBe('4/20');

    display?.querySelector('button')?.click();
    const input = display?.querySelector<HTMLInputElement>('input');
    expect(input?.placeholder).toBe('1-20');
    input!.value = '11';
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(view.goTo).toContain(11);
  });

  it('בלי מסמך פתוח אין תצוגת מספר דף', () => {
    const { screen } = createScreen();
    view.notifyChanged?.(1, 0, 1);
    expect(screen.root.querySelector('.page-number-display')?.textContent).toBe('');
  });

  it('כפתורי הניווט קופצים לתחילת הספר ולסופו', () => {
    const { screen } = createScreen();
    view.pageCount = 30;
    screen.root.querySelector<HTMLButtonElement>('[aria-label="תחילת הספר"]')?.click();
    screen.root.querySelector<HTMLButtonElement>('[aria-label="סוף הספר"]')?.click();
    screen.root.querySelector<HTMLButtonElement>('[aria-label="הבא"]')?.click();
    screen.root.querySelector<HTMLButtonElement>('[aria-label="הקודם"]')?.click();
    expect(view.goTo).toEqual([1, 30]);
    expect(view.nextPages).toBe(1);
    expect(view.previousPages).toBe(1);
  });

  it('סרגל הזום מופיע בפעולת זום ונעלם אחרי שתי שניות', () => {
    vi.useFakeTimers();
    try {
      const { screen } = createScreen();
      const zoomBar = screen.root.querySelector('.pdf-zoom-bar')!;
      expect(zoomBar.classList.contains('hidden')).toBe(true);

      screen.root.querySelector<HTMLButtonElement>('[data-tooltip="הגדל את התצוגה"]')?.click();
      expect(zoomBar.classList.contains('hidden')).toBe(false);
      expect(view.zooms).toEqual([1.1]);

      vi.advanceTimersByTime(2_000);
      expect(zoomBar.classList.contains('hidden')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('כפתורי הסרגל הצף מקטינים ומאפסים את התצוגה', () => {
    const { screen } = createScreen();
    const card = screen.root.querySelector('.pdf-zoom-bar-card')!;
    card.querySelector<HTMLButtonElement>('[data-tooltip="הקטן את התצוגה"]')?.click();
    buttonByText(card, 'אפס').click();
    expect(view.zooms.at(-1)).toBeCloseTo(1 / 1.1);
    expect(view.resets).toBe(1);
  });

  it('מקשי החצים מנווטים בין דפים וגוללים בתוך הדף', () => {
    const { screen } = createScreen();
    const viewport = screen.root.querySelector('.pdf-viewport')!;
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'PageDown']) {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    expect(view.nextPages).toBe(1);
    expect(view.previousPages).toBe(1);
    expect(view.scrolls).toEqual([25, -25]);
  });

  it('כפתורי הסרגל העליון מפעילים את הפעולות של המסך', () => {
    const { screen, handlers } = createScreen();
    screen.root.querySelector<HTMLButtonElement>('[aria-label="פתח באתר היברובוקס"]')?.click();
    screen.root.querySelector<HTMLButtonElement>('[aria-label="פתח ספר במהדורת טקסט"]')?.click();
    screen.root.querySelector<HTMLButtonElement>('[aria-label="חזרה לתוצאות החיפוש"]')?.click();
    expect(handlers.onOpenWebsite).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenTextEdition).toHaveBeenCalledTimes(1);
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
  });

  it('בחלון צר הפעולות עוברות לתפריט הגלישה', () => {
    const { screen, handlers } = createScreen();
    const original = window.innerWidth;
    try {
      Object.defineProperty(window, 'innerWidth', { value: 300, configurable: true });
      window.dispatchEvent(new Event('resize'));
      expect(screen.root.querySelector('.overflow-anchor')).not.toBeNull();
      expect(screen.root.querySelector('[aria-label="פתח באתר היברובוקס"]')).toBeNull();

      screen.root.querySelector<HTMLButtonElement>('[aria-label="פעולות נוספות"]')?.click();
      buttonByText(screen.root.querySelector('.overflow-menu')!, 'פתח באתר היברובוקס').click();
      expect(handlers.onOpenWebsite).toHaveBeenCalledTimes(1);
      expect(screen.root.querySelector('.overflow-menu')?.classList.contains('hidden')).toBe(true);
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: original, configurable: true });
    }
  });

  it('כפתור החלונית פותח וסוגר אותה', () => {
    const { screen } = createScreen();
    const toggle = screen.root.querySelector<HTMLButtonElement>('[aria-label="חיפוש וניווט"]')!;
    toggle.click();
    expect(screen.root.querySelector('.reader-pane')?.classList.contains('closed')).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    toggle.click();
    expect(screen.root.querySelector('.reader-pane')?.classList.contains('closed')).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('לחיצה על הרקע המוצלל סוגרת את החלונית', () => {
    const { screen } = createScreen();
    screen.root.querySelector<HTMLButtonElement>('[aria-label="חיפוש וניווט"]')?.click();
    screen.root.querySelector<HTMLElement>('.reader-scrim')?.click();
    expect(screen.root.querySelector('.reader-pane')?.classList.contains('closed')).toBe(true);
  });
});
