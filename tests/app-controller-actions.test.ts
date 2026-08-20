// @vitest-environment jsdom

/// המסלולים שהמשתמש מפעיל במסכי התוסף: דיאלוג החיפוש, חיפוש מאוחד מתוך
/// אוצריא, פתיחת תוצאה, טעינת עוד תוצאות והפעולות שבכרטיס התוצאה.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: Promise.reject(new Error('אין קובץ בבדיקה')) }),
}));

const { AppController } = await import('../src/app-controller');
const { bootPayload, createMockHost, hebrewBooksNdjson, hebrewBooksRow } = await import(
  './helpers/mock-host'
);

type MockHost = ReturnType<typeof createMockHost>;
type MockHostConfig = import('./helpers/mock-host').MockHostConfig;

interface Harness {
  readonly host: MockHost;
  readonly shell: HTMLElement;
}

async function bootHarness(config: MockHostConfig = {}): Promise<Harness> {
  const host = createMockHost(config);
  const shell = document.createElement('div');
  document.body.append(shell);
  const controller = new AppController(host.bridge, shell);
  await controller.boot(bootPayload());
  await Promise.resolve();
  return { host, shell };
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`אין כפתור עם הטקסט ${text}`);
  return button;
}

function dialogRoot(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('dialog.search-dialog');
  if (!dialog) throw new Error('דיאלוג החיפוש אינו פתוח');
  return dialog;
}

/// פותח את דיאלוג החיפוש מהמסך הראשי ומגיש שאילתה.
async function submitFromDialog(harness: Harness, query: string, before?: () => void): Promise<void> {
  buttonByText(harness.shell, 'חפש בהיברובוקס').click();
  const dialog = dialogRoot();
  dialog.querySelector<HTMLInputElement>('input[type="search"]')!.value = query;
  before?.();
  buttonByText(dialog.querySelector('.dialog-footer')!, 'חפש').click();
  await Promise.resolve();
}

function otzariaChunk(
  payload: Record<string, unknown> | undefined,
  hits: Array<Record<string, unknown>>,
  total: number,
): readonly unknown[] {
  return [
    {
      sequence: 0,
      results: hits,
      total,
      groupCount: null,
      truncated: false,
      limit: Number(payload?.limit ?? 1),
      offset: Number(payload?.offset ?? 0),
      facets: [],
    },
  ];
}

function otzariaHit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 77,
    bookId: 'bereshit',
    type: 'text',
    source: 'library',
    book: 'בראשית',
    categoryPath: '/תנ"ך/תורה',
    reference: 'פרק א',
    text: 'בראשית ברא',
    index: 12,
    mergedCount: 1,
    ...overrides,
  };
}

const emptyMapping: MockHostConfig['methods'] = {
  'database.batchQuery': () => ({ results: [{ rows: [] }] }),
};

function unifiedConfig(overrides: MockHostConfig = {}): MockHostConfig {
  return {
    methods: { ...emptyMapping, ...overrides.methods },
    network: {
      '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow({ firstHitPage: undefined })]) }),
      '/inbook': () => ({
        body: JSON.stringify({ hitCount: 2, pages: [5, 3], matchedTerms: ['ברכת'] }),
      }),
      ...overrides.network,
    },
    searchQuery: overrides.searchQuery ?? ((payload) => otzariaChunk(payload, [otzariaHit()], 1)),
  };
}

async function runUnifiedSearch(
  harness: Harness,
  request: Record<string, unknown> = { query: 'ברכת המזון', mode: 'exact' },
): Promise<void> {
  harness.host.emit('search.requested', { itemId: 'tab-1', request });
  await vi.waitFor(() =>
    expect(harness.shell.querySelectorAll('.result-card').length).toBeGreaterThan(0),
  );
}

function cardTitles(shell: HTMLElement): string[] {
  return [...shell.querySelectorAll('.result-title')].map((node) => node.textContent ?? '');
}

beforeAll(() => {
  // jsdom אינו מממש <dialog>; הדיאלוג עצמו נבדק דרך אותם כפתורים.
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

beforeEach(() => {
  document.body.replaceChildren();
});

describe('דיאלוג החיפוש של התוסף', () => {
  it('מפנה את החיפוש לטאב החיפוש המובנה עם שורת ההיברובוקס מסומנת', async () => {
    const harness = await bootHarness();
    await submitFromDialog(harness, 'ברכת המזון');
    await vi.waitFor(() => expect(harness.host.countOf('reader.openSearchTab')).toBe(1));
    // המרווח שנבחר בדיאלוג (ברירת המחדל 30) עובר לטאב — בלעדיו הטאב נפתח
    // עם מרווח 0 והמדור החיצוני מחפש בהגדרה מחמירה שהמשתמש לא ביקש.
    expect(harness.host.lastPayload('reader.openSearchTab')).toEqual({
      query: 'ברכת המזון',
      selectItems: ['include-hebrewbooks'],
      distance: 30,
    });
    // המסך המובנה מציג את התוצאות — התוסף אינו מחפש בעצמו.
    expect(
      harness.host
        .payloadsOf('network.fetchStream')
        .some((payload) => String(payload?.url).endsWith('/search')),
    ).toBe(false);
  });

  it('מארח שאינו מכיר את הטאב המובנה נופל למסך התוצאות של התוסף', async () => {
    const harness = await bootHarness({
      methods: {
        'reader.openSearchTab': () => {
          throw new Error('unknown method');
        },
      },
      network: {
        '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow()]) }),
      },
    });
    await submitFromDialog(harness, 'ברכת המזון');
    await vi.waitFor(() => expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(1));
    expect(cardTitles(harness.shell)).toEqual(['קובץ שיטות קמאי']);
    expect(harness.shell.querySelector('.results-screen')?.classList.contains('hidden')).toBe(false);
    expect(harness.shell.querySelector('.library-screen')?.classList.contains('hidden')).toBe(true);
  });

  it('שאילתה ריקה מוצגת כשגיאה למשתמש', async () => {
    const harness = await bootHarness({
      methods: {
        'reader.openSearchTab': () => {
          throw new Error('unknown method');
        },
      },
    });
    await submitFromDialog(harness, '   ');
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(harness.host.lastPayload('ui.showError')).toEqual({ message: 'יש להזין מילות חיפוש' });
  });

  it('שאילתה מעל 500 תווים נחסמת', async () => {
    const harness = await bootHarness({
      methods: {
        'reader.openSearchTab': () => {
          throw new Error('unknown method');
        },
      },
    });
    await submitFromDialog(harness, 'א'.repeat(501));
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(harness.host.lastPayload('ui.showError')).toEqual({
      message: 'החיפוש מוגבל ל־500 תווים',
    });
  });

  it('ביטול כל מקורות החיפוש נחסם', async () => {
    const harness = await bootHarness({
      methods: {
        'reader.openSearchTab': () => {
          throw new Error('unknown method');
        },
      },
    });
    await submitFromDialog(harness, 'ברכת המזון', () => {
      const pdfRow = [...dialogRoot().querySelectorAll<HTMLLabelElement>('.checkbox-row')].find(
        (row) => row.textContent?.includes('ספרים סרוקים'),
      );
      pdfRow?.querySelector<HTMLInputElement>('input')?.click();
    });
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(harness.host.lastPayload('ui.showError')).toEqual({
      message: 'יש לבחור מקור אחד לפחות',
    });
  });

  it('"ערוך חיפוש" פותח מחדש את הדיאלוג עם השאילתה הקודמת', async () => {
    const harness = await bootHarness({
      methods: {
        'reader.openSearchTab': () => {
          throw new Error('unknown method');
        },
      },
      network: { '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow()]) }) },
    });
    await submitFromDialog(harness, 'ברכת המזון');
    await vi.waitFor(() => expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(1));

    harness.shell.querySelector<HTMLButtonElement>('[aria-label="ערוך חיפוש"]')?.click();
    expect(dialogRoot().querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe(
      'ברכת המזון',
    );
  });
});

describe('חיפוש מאוחד מאוצריא', () => {
  it('מציג תוצאות משני המנועים עם הספירה הכוללת', async () => {
    const harness = await bootHarness(unifiedConfig());
    await runUnifiedSearch(harness);
    expect(cardTitles(harness.shell)).toEqual(['בראשית', 'קובץ שיטות קמאי']);
    expect(harness.shell.querySelector('.top-bar-trailing .top-bar-count')?.textContent).toContain(
      '2 פריטים מוצגים',
    );
    // חיפוש שהגיע מאוצריא אינו ניתן לעריכה במסך התוסף.
    expect(harness.shell.querySelector('[aria-label="ערוך חיפוש"]')).toBeNull();
  });

  it('בקשת חיפוש לא תקינה מוצגת כשגיאה', async () => {
    const harness = await bootHarness(unifiedConfig());
    harness.host.emit('search.requested', { itemId: 'tab-1', request: { query: '', mode: 'exact' } });
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(harness.host.lastPayload('ui.showError')).toEqual({
      message: 'בקשת החיפוש מאוצריא אינה תקינה',
    });
  });

  it('כשל בשני המנועים מוצג כשגיאה במסך התוצאות', async () => {
    const harness = await bootHarness(
      unifiedConfig({
        network: {
          '/search': () => ({ status: 500, ok: false, body: JSON.stringify({ error: 'השרת נפל' }) }),
        },
        searchQuery: () =>
          (async function* () {
            throw new Error('האינדקס אינו בנוי');
          })(),
      }),
    );
    harness.host.emit('search.requested', { itemId: 'tab-1', request: { query: 'ברכות', mode: 'exact' } });
    await vi.waitFor(() =>
      expect(harness.shell.querySelector('.informative-state h3')?.textContent).toBe(
        'לא ניתן להשלים את החיפוש',
      ),
    );
    const message = harness.shell.querySelector('.informative-state p')?.textContent ?? '';
    expect(message).toContain('האינדקס אינו בנוי');
    expect(message).toContain('השרת נפל');
  });

  it('כשל בשיוך הקטגוריות מוצג כאזהרה בלי לבטל את התוצאות', async () => {
    const harness = await bootHarness(
      unifiedConfig({
        methods: {
          'database.batchQuery': () => {
            throw new Error('אין הרשאה למסד');
          },
        },
      }),
    );
    await runUnifiedSearch(harness);
    expect(harness.shell.querySelector('.source-warning-banner')?.textContent).toContain(
      'שיוך הקטגוריות של היברובוקס נכשל',
    );
    expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(2);
  });

  it('טוען עמוד נוסף מהמנוע שלא הסתיים ומאחד בלי כפילויות', async () => {
    const harness = await bootHarness(
      unifiedConfig({
        searchQuery: (payload) => {
          const offset = Number(payload?.offset ?? 0);
          return otzariaChunk(
            payload,
            [offset === 0 ? otzariaHit() : otzariaHit({ book: 'שמות', bookId: 'shemot', index: 40 })],
            3,
          );
        },
      }),
    );
    await runUnifiedSearch(harness, { query: 'ברכת המזון', mode: 'exact', limit: 1 });
    expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(2);

    const searchesBefore = harness.host
      .payloadsOf('network.fetchStream')
      .filter((payload) => String(payload?.url).endsWith('/search')).length;
    buttonByText(harness.shell, 'טען עוד תוצאות').click();
    await vi.waitFor(() => expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(3));
    // התוצאות החדשות נוספות בסוף, מתחת לאלה שכבר מוצגות.
    expect(cardTitles(harness.shell)).toEqual(['בראשית', 'קובץ שיטות קמאי', 'שמות']);
    // היברובוקס הסתיים בעמוד הראשון — הוא אינו נשאל שוב.
    expect(
      harness.host
        .payloadsOf('network.fetchStream')
        .filter((payload) => String(payload?.url).endsWith('/search')).length,
    ).toBe(searchesBefore);
    expect(harness.host.payloadsOf('search.query').at(-1)).toMatchObject({ offset: 1, limit: 1 });
  });
});

describe('פתיחת תוצאה', () => {
  it('ספר היברובוקס נפתח בקורא של אוצריא בעמוד ההתאמה הראשון', async () => {
    const harness = await bootHarness(unifiedConfig());
    await runUnifiedSearch(harness);
    [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')].at(-1)?.click();

    await vi.waitFor(() => expect(harness.host.countOf('reader.openBook')).toBe(1));
    expect(harness.host.lastPayload('reader.openBook')).toEqual({
      external: { provider: 'hebrewbooks', id: 43558 },
      index: 2,
      searchQuery: 'ברכת המזון',
      navigateToPositionIfReused: true,
      matchPages: [3, 5],
      matchedTerms: ['ברכת'],
    });
  });

  it('תוצאת אוצריא נפתחת לפי זהות הספר והמיקום שבאינדקס', async () => {
    const harness = await bootHarness(unifiedConfig());
    await runUnifiedSearch(harness);
    harness.shell.querySelector<HTMLElement>('.result-card-body')?.click();

    await vi.waitFor(() => expect(harness.host.countOf('reader.openBook')).toBe(1));
    expect(harness.host.lastPayload('reader.openBook')).toEqual({
      id: 77,
      bookId: 'bereshit',
      type: 'text',
      source: 'library',
      index: 12,
      searchQuery: 'ברכת המזון',
      navigateToPositionIfReused: true,
    });
  });

  it('ספר שאינו בקטלוג ההיברובוקס של אוצריא מוצג כשגיאה', async () => {
    const harness = await bootHarness(
      unifiedConfig({ methods: { 'reader.openBook': () => false } }),
    );
    await runUnifiedSearch(harness);
    [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')].at(-1)?.click();
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(harness.host.lastPayload('ui.showError')).toEqual({
      message: 'הספר לא נמצא בקטלוג היברובוקס של אוצריא',
    });
  });

  it('תוצאת אוצריא שלא נפתחה מוצגת כשגיאה', async () => {
    const harness = await bootHarness(
      unifiedConfig({ methods: { 'reader.openBook': () => false } }),
    );
    await runUnifiedSearch(harness);
    harness.shell.querySelector<HTMLElement>('.result-card-body')?.click();
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(harness.host.lastPayload('ui.showError')).toEqual({
      message: 'לא ניתן היה לפתוח את הספר באוצריא',
    });
  });

  it('כשל באיתור העמודים מוצג כשגיאה', async () => {
    const harness = await bootHarness(
      unifiedConfig({
        network: {
          '/inbook': () => ({ status: 500, ok: false, body: JSON.stringify({ error: 'האינדקס נעול' }) }),
        },
      }),
    );
    await runUnifiedSearch(harness);
    [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')].at(-1)?.click();
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(harness.host.lastPayload('ui.showError')).toEqual({ message: 'האינדקס נעול' });
    expect(harness.host.countOf('reader.openBook')).toBe(0);
  });

  it('מקש Enter על כרטיס פותח את התוצאה', async () => {
    const harness = await bootHarness(unifiedConfig());
    await runUnifiedSearch(harness);
    harness.shell
      .querySelector<HTMLElement>('.result-card-body')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(harness.host.countOf('reader.openBook')).toBe(1));
  });
});

describe('פעולות בכרטיס ההיברובוקס', () => {
  function stubClipboard(writeText: () => Promise<void>): void {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  }

  it('פותח את דף הספר באתר היברובוקס', async () => {
    const harness = await bootHarness(unifiedConfig());
    await runUnifiedSearch(harness);
    harness.shell
      .querySelector<HTMLButtonElement>('[aria-label="פתח באתר היברובוקס"]')
      ?.click();
    await vi.waitFor(() => expect(harness.host.countOf('app.openUrl')).toBe(1));
    expect(harness.host.lastPayload('app.openUrl')).toEqual({
      url: 'https://hebrewbooks.org/43558',
    });
    // כפתור הפעולה אינו פותח גם את הספר.
    expect(harness.host.countOf('reader.openBook')).toBe(0);
  });

  it('מעתיק את פרטי הספר ללוח ומודיע למשתמש', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    const harness = await bootHarness(unifiedConfig());
    await runUnifiedSearch(harness);
    harness.shell.querySelector<HTMLButtonElement>('[aria-label="העתק את פרטי הספר"]')?.click();
    await vi.waitFor(() => expect(harness.host.countOf('ui.showMessage')).toBe(1));
    expect(writeText).toHaveBeenCalledWith('קובץ שיטות קמאי, מחבר, ירושלים, תשס"ד');
    expect(harness.host.lastPayload('ui.showMessage')).toEqual({ message: 'הטקסט הועתק' });
  });

  it('בהקשר לא מאובטח נופל למסלול execCommand', async () => {
    stubClipboard(() => Promise.reject(new Error('הקשר לא מאובטח')));
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    const harness = await bootHarness(unifiedConfig());
    await runUnifiedSearch(harness);
    harness.shell.querySelector<HTMLButtonElement>('[aria-label="העתק את פרטי הספר"]')?.click();
    await vi.waitFor(() => expect(harness.host.countOf('ui.showMessage')).toBe(1));
    expect(execCommand).toHaveBeenCalledWith('copy');
    // תיבת הטקסט הזמנית הוסרה מהמסמך.
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('כשל בהעתקה מוצג כשגיאה', async () => {
    stubClipboard(() => Promise.reject(new Error('הקשר לא מאובטח')));
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => false),
      configurable: true,
    });
    const harness = await bootHarness(unifiedConfig());
    await runUnifiedSearch(harness);
    harness.shell.querySelector<HTMLButtonElement>('[aria-label="העתק את פרטי הספר"]')?.click();
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(harness.host.lastPayload('ui.showError')).toEqual({
      message: 'לא ניתן היה להעתיק את הטקסט',
    });
  });
});

describe('מסך הפתיחה ומצב השירות', () => {
  it('שירות מלא מוצג עם היכולת והגרסה', async () => {
    const harness = await bootHarness({
      network: {
        '/health': () => ({
          body: JSON.stringify({
            ok: true,
            service: 'hbsearch',
            apiVersion: 2,
            capabilities: ['pdf-range'],
            serverVersion: '2.0.1',
          }),
        }),
      },
    });
    expect(harness.shell.querySelector('.library-status')?.textContent).toBe(
      'שירות החיפוש מחובר (חיפוש ועיון) · גרסה 2.0.1',
    );
  });

  it('שירות שאינו זמין מציג הסבר וכפתור בדיקה חוזרת שמצליחה', async () => {
    let healthy = false;
    const harness = await bootHarness({
      network: {
        '/health': () =>
          healthy
            ? { body: JSON.stringify({ ok: true, service: 'hbsearch' }) }
            : { status: 503, ok: false, body: 'down' },
      },
    });
    expect(harness.shell.querySelector('.informative-state h3')?.textContent).toBe(
      'שירות החיפוש אינו זמין',
    );

    healthy = true;
    buttonByText(harness.shell, 'בדוק שוב').click();
    await vi.waitFor(() =>
      expect(harness.shell.querySelector('.library-status')?.textContent).toBe(
        'שירות החיפוש מחובר (חיפוש בלבד)',
      ),
    );
  });

  it('חזרה מהתוצאות מציגה שוב את מסך הפתיחה', async () => {
    const harness = await bootHarness(unifiedConfig());
    await runUnifiedSearch(harness);
    harness.shell.querySelector<HTMLButtonElement>('[aria-label="חזרה למסך הפתיחה"]')?.click();
    expect(harness.shell.querySelector('.library-screen')?.classList.contains('hidden')).toBe(false);
    expect(harness.shell.querySelector('.results-screen')?.classList.contains('hidden')).toBe(true);
    expect(harness.shell.querySelector('.viewer-screen')?.classList.contains('hidden')).toBe(true);
  });
});
