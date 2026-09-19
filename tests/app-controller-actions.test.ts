// @vitest-environment jsdom

/// המסלולים שהמשתמש מפעיל במסכי התוסף: דיאלוג החיפוש, מסך
/// התוצאות של התוסף, פתיחת תוצאה והפעולות שבכרטיס התוצאה.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: Promise.reject(new Error('אין קובץ בבדיקה')) }),
}));

const { AppController } = await import('../src/app-controller');
const { ViewerScreen } = await import('../src/screens/viewer-screen');
const { bootPayload, createMockHost, hebrewBooksNdjson, hebrewBooksRow } = await import(
  './helpers/mock-host'
);
const { requiredServiceVersion } = await import('../src/utils/service-version');
const { defaultSearchOptions } = await import('../src/models');

type SearchOptions = import('../src/models').SearchOptions;

type MockHost = ReturnType<typeof createMockHost>;
type MockHostConfig = import('./helpers/mock-host').MockHostConfig;

interface Harness {
  readonly host: MockHost;
  readonly shell: HTMLElement;
  readonly controller: InstanceType<typeof AppController>;
}

async function bootHarness(config: MockHostConfig = {}): Promise<Harness> {
  const host = createMockHost(config);
  const shell = document.createElement('div');
  document.body.append(shell);
  const controller = new AppController(host.bridge, shell);
  await controller.boot(bootPayload());
  await Promise.resolve();
  return { host, shell, controller };
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

const emptyMapping: MockHostConfig['methods'] = {
  'database.batchQuery': () => ({ results: [{ rows: [] }] }),
};

const v2Event = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;

/// שירות v2 שמגלה ספר אחד ואז נופל באמצע — בדיוק המצב שעליו דיווח המשתמש:
/// "בהתחלה היו תוצאות, ואז לאחר מכן — התוצאות נעלמו והיה כתוב שאין תוצאות".
const discoveryThenStreamFailure: MockHostConfig['network'] = {
  '/health': () => ({ body: JSON.stringify({
    ok: true,
    service: 'hbsearch',
    apiVersion: 2,
    capabilities: ['pdf-range', 'search-stream-v2'],
  }) }),
  '/search': () => ({
    bodies: [
      v2Event({ type: 'start', streamVersion: 2, streamId: 'a'.repeat(64) })
        + v2Event({ type: 'provisional', result: JSON.parse(hebrewBooksRow({ firstHitPage: undefined })) }),
      v2Event({ type: 'error', message: 'dtSearch failed' }),
    ],
    bodyDelaysMs: [0, 20],
  }),
};

/// מחכה לרגע שבו מסך התוצאות הגיע למצב סופי — רשימה, אזהרה או הודעה.
async function settledResults(harness: Harness): Promise<void> {
  await vi.waitFor(() =>
    expect(
      harness.shell.querySelector('.informative-state, .source-warning-banner'),
    ).not.toBeNull(),
  );
}

/// מארח בלי טאב חיפוש מובנה — המסלול היחיד שבו התוסף מציג
/// תוצאות במסך שלו.
function pluginSearchConfig(overrides: MockHostConfig = {}): MockHostConfig {
  return {
    methods: {
      ...emptyMapping,
      'reader.openSearchTab': () => {
        throw new Error('unknown method');
      },
      ...overrides.methods,
    },
    network: {
      '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow({ firstHitPage: undefined })]) }),
      '/inbook': () => ({
        body: JSON.stringify({ hitCount: 2, pages: [5, 3], matchedTerms: ['ברכת'] }),
      }),
      ...overrides.network,
    },
  };
}

async function runPluginSearch(
  harness: Harness,
  query = 'ברכת המזון',
  options: Partial<SearchOptions> = {},
): Promise<void> {
  void (
    harness.controller as unknown as {
      performSearch(query: string, options: SearchOptions): Promise<void>;
    }
  ).performSearch(query, { ...defaultSearchOptions, ...options });
  await vi.waitFor(() =>
    expect(harness.shell.querySelectorAll('.result-card').length).toBeGreaterThan(0),
  );
}

function cardTitles(shell: HTMLElement): string[] {
  return [...shell.querySelectorAll('.result-title')].map((node) => node.textContent ?? '');
}

function inBookBodies(harness: Harness): Array<Record<string, unknown>> {
  return harness.host
    .payloadsOf('network.fetchStream')
    .filter((payload) => String(payload?.url).endsWith('/inbook'))
    .map((payload) => JSON.parse(String(payload?.body)) as Record<string, unknown>);
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
    // ה-proximity שנבחר (ברירת המחדל 30) עובר ב-settings ביחידות של אוצריא —
    // אחרת הטאב נפתח במרווח 0 והמדור החיצוני מחפש בהגדרה המחמירה ביותר.
    expect(harness.host.lastPayload('reader.openSearchTab')).toEqual({
      query: 'ברכת המזון',
      selectItems: ['include-hebrewbooks'],
      settings: { mode: 'exact', distance: 29 },
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

  /// זרם שנפל אחרי שכבר הציג ספרים אינו מאפס את המסך: מחיקת התוצאות הותירה
  /// את המשתמש בלי כלום, ואילו שורת אזהרה מעליהן אומרת מה קרה ומשאירה לו את
  /// מה שכן נמצא.
  it('כשל בזרם אחרי גילוי משאיר את התוצאות במסך התוסף עם אזהרה', async () => {
    const harness = await bootHarness({
      methods: {
        'reader.openSearchTab': () => {
          throw new Error('unknown method');
        },
      },
      network: discoveryThenStreamFailure,
    });
    await submitFromDialog(harness, 'ברכת המזון');
    await settledResults(harness);
    expect(cardTitles(harness.shell)).toEqual(['קובץ שיטות קמאי']);
    expect(harness.shell.querySelector('.source-warning-banner')?.textContent).toContain(
      'dtSearch failed',
    );
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

  it('בחירת מקור שאוצריא אינה פותחת משאירה את החיפוש במסך התוסף, עם הסבר', async () => {
    const harness = await bootHarness(pluginSearchConfig({ methods: emptyMapping }));
    await submitFromDialog(harness, 'ברכת המזון', () => {
      const personalRow = [...dialogRoot().querySelectorAll<HTMLLabelElement>('.checkbox-row')].find(
        (row) => row.textContent?.includes('אוסף אישי'),
      );
      personalRow?.querySelector<HTMLInputElement>('input')?.click();
    });
    await vi.waitFor(() => expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(1));
    // הטאב לא נפתח כלל, והמשתמש קיבל את הסיבה במקום בחירה שנבלעת בשקט.
    expect(harness.host.countOf('reader.openSearchTab')).toBe(0);
    expect(String(harness.host.lastPayload('ui.showMessage')?.message)).toContain('אוסף אישי');
  });

  it('חיפוש מקורב נשאר במסך התוסף — שורת ההיברובוקס מוסתרת בטאב', async () => {
    const harness = await bootHarness(pluginSearchConfig({ methods: emptyMapping }));
    await submitFromDialog(harness, 'ברכת המזון', () => {
      buttonByText(dialogRoot().querySelector('.mode-selector')!, 'מקורב').click();
    });
    await vi.waitFor(() => expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(1));
    expect(harness.host.countOf('reader.openSearchTab')).toBe(0);
    expect(String(harness.host.lastPayload('ui.showMessage')?.message)).toContain('מקורב');
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

  it('תוצאה מהאוסף האישי נפתחת במציג של התוסף ולא דרך הקורא של אוצריא', async () => {
    const openBook = vi.spyOn(ViewerScreen.prototype, 'openBook').mockResolvedValue(undefined);
    try {
      const harness = await bootHarness(
        pluginSearchConfig({
          methods: emptyMapping,
          network: {
            '/search': () => ({
              body: hebrewBooksNdjson([
                hebrewBooksRow({ fileId: '1000000000042', sourceType: 'Personal' }),
              ]),
            }),
          },
        }),
      );
      await submitFromDialog(harness, 'ברכת המזון', () => {
        const personalRow = [
          ...dialogRoot().querySelectorAll<HTMLLabelElement>('.checkbox-row'),
        ].find((row) => row.textContent?.includes('אוסף אישי'));
        personalRow?.querySelector<HTMLInputElement>('input')?.click();
      });
      await vi.waitFor(() => expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(1));
      harness.shell.querySelector<HTMLElement>('.result-card-body')?.click();
      await vi.waitFor(() => expect(openBook).toHaveBeenCalledTimes(1));
      // הקורא של אוצריא אינו יודע לפתוח מזהה אישי סינתטי — לא פונים אליו.
      expect(harness.host.countOf('reader.openBook')).toBe(0);
      expect(String(openBook.mock.calls[0]?.[1])).toContain('/pdf/1000000000042');
    } finally {
      openBook.mockRestore();
    }
  });

  it('שרת ישן בלי מזהה מספרי לספר אישי נכשל בהודעה ברורה', async () => {
    const harness = await bootHarness(
      pluginSearchConfig({
        methods: emptyMapping,
        network: {
          '/search': () => ({
            body: hebrewBooksNdjson([
              hebrewBooksRow({ fileId: 'אא רמב"ם\א מדע.pdf', sourceType: 'Personal' }),
            ]),
          }),
        },
      }),
    );
    await submitFromDialog(harness, 'ברכת המזון', () => {
      const personalRow = [...dialogRoot().querySelectorAll<HTMLLabelElement>('.checkbox-row')].find(
        (row) => row.textContent?.includes('אוסף אישי'),
      );
      personalRow?.querySelector<HTMLInputElement>('input')?.click();
    });
    await vi.waitFor(() => expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(1));
    harness.shell.querySelector<HTMLElement>('.result-card-body')?.click();
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(String(harness.host.lastPayload('ui.showError')?.message)).toContain('אוסף אישי');
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

  it('הקורא הישן משתמש במיקום ברירת המחדל כשחיפוש הדוק אינו מחזיר עמודים', async () => {
    const openBook = vi.spyOn(ViewerScreen.prototype, 'openBook').mockResolvedValue(undefined);
    try {
      const harness = await bootHarness({
        methods: {
          'reader.openSearchTab': () => {
            throw new Error('unknown method');
          },
        },
        network: {
          '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow()]) }),
          '/inbook': (payload) => {
            const body = JSON.parse(String(payload.body)) as Record<string, unknown>;
            return {
              body: JSON.stringify(
                body.proximity === 1
                  ? { hitCount: 0, pages: [], matchedTerms: [] }
                  : { hitCount: 2, pages: [8, 12], matchedTerms: ['ברכת', 'המזון'] },
              ),
            };
          },
        },
      });
      await submitFromDialog(harness, 'ברכת המזון', () => {
        const proximity = dialogRoot().querySelector<HTMLInputElement>('[aria-label="מרחק בין מילים"]')!;
        proximity.value = '1';
        proximity.dispatchEvent(new Event('change'));
      });
      await vi.waitFor(() => expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(1));
      await (harness.controller as unknown as {
        openBook(result: { fileId: string; bookName: string }): Promise<void>;
      }).openBook({ fileId: '43558', bookName: 'קובץ שיטות קמאי' });

      expect(openBook).toHaveBeenCalledTimes(1);
      expect(inBookBodies(harness)).toEqual([
        expect.objectContaining({ proximity: 1, requireWordOrder: true }),
        expect.objectContaining({ proximity: 30, requireWordOrder: false }),
      ]);
      expect(openBook).toHaveBeenCalledWith(
        'קובץ שיטות קמאי',
        expect.stringMatching(/\/pdf\/43558$/),
        [8, 12],
        8,
      );
    } finally {
      openBook.mockRestore();
    }
  });
});

describe('מסך התוצאות של התוסף', () => {
  it('מציג את תוצאות ההיברובוקס עם הספירה, ומאפשר לערוך את החיפוש', async () => {
    const harness = await bootHarness(pluginSearchConfig());
    await runPluginSearch(harness);
    expect(cardTitles(harness.shell)).toEqual(['קובץ שיטות קמאי']);
    expect(harness.shell.querySelector('.top-bar-trailing .top-bar-count')?.textContent).toContain(
      '1 פריטים מוצגים',
    );
    // החיפוש רץ בתוסף עצמו, ולכן ניתן לערוך אותו מהמסך.
    expect(harness.shell.querySelector('[aria-label="ערוך חיפוש"]')).not.toBeNull();
  });

  /// שורת הדיאלוג include-hebrewbooks מצהירה resultsProvider, ואוצריא
  /// מנתבת אותה לחוזה הספק החיצוני — search.requested נשלח רק לשורה
  /// שמצהירה openPluginOnSubmit, שסותר את resultsProvider.
  it('אירוע search.requested אינו מפעיל דבר — אין לו מאזין', async () => {
    const harness = await bootHarness(pluginSearchConfig());
    harness.host.emit('search.requested', {
      itemId: 'tab-1',
      request: { query: 'ברכות', mode: 'exact' },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(
      harness.host
        .payloadsOf('network.fetchStream')
        .some((payload) => String(payload?.url).endsWith('/search')),
    ).toBe(false);
    expect(harness.shell.querySelector('.library-screen')?.classList.contains('hidden')).toBe(false);
    expect(harness.shell.querySelector('.results-screen')?.classList.contains('hidden')).toBe(true);
    expect(harness.host.countOf('ui.showError')).toBe(0);
  });

  it('כשל החיפוש מוצג כשגיאה במסך התוצאות', async () => {
    const harness = await bootHarness(
      pluginSearchConfig({
        network: {
          '/search': () => ({ status: 500, ok: false, body: JSON.stringify({ error: 'השרת נפל' }) }),
        },
      }),
    );
    void (
      harness.controller as unknown as {
        performSearch(query: string, options: SearchOptions): Promise<void>;
      }
    ).performSearch('ברכות', defaultSearchOptions);
    await vi.waitFor(() =>
      expect(harness.shell.querySelector('.informative-state h3')?.textContent).toBe(
        'לא ניתן להשלים את החיפוש',
      ),
    );
    expect(harness.shell.querySelector('.informative-state p')?.textContent ?? '').toContain(
      'השרת נפל',
    );
  });

  it('חיפוש שהושלם בלי אף התאמה עדיין מוצג כ"אין תוצאות"', async () => {
    const harness = await bootHarness(
      pluginSearchConfig({ network: { '/search': () => ({ body: '' }) } }),
    );
    void (
      harness.controller as unknown as {
        performSearch(query: string, options: SearchOptions): Promise<void>;
      }
    ).performSearch('ברכת המזון', defaultSearchOptions);
    await vi.waitFor(() =>
      expect(harness.shell.querySelector('.informative-state h3')?.textContent).toBe('אין תוצאות'),
    );
  });

  /// הדפדוף היה שייך לחיפוש המאוחד: התוסף שואל את שירות
  /// ההיברובוקס פעם אחת ומקבל את כל התוצאות, ואין מה לטעון.
  it('אינו מציג כפתור "טען עוד תוצאות"', async () => {
    const harness = await bootHarness(pluginSearchConfig());
    await runPluginSearch(harness);
    expect(harness.shell.querySelector('.load-more-row')).toBeNull();
  });
});

describe('פתיחת תוצאה', () => {
  it('פתיחה שהתעכבה באיתור עמוד אינה פותחת ספר מהחיפוש הקודם', async () => {
    let releaseInBook!: (reply: { body: string }) => void;
    const harness = await bootHarness(
      pluginSearchConfig({
        network: {
          '/inbook': () => new Promise((resolve) => { releaseInBook = resolve; }),
        },
      }),
    );
    await runPluginSearch(harness);
    [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')].at(-1)?.click();
    await vi.waitFor(() => expect(inBookBodies(harness)).toHaveLength(1));

    // המשתמש מריץ חיפוש חדש עוד לפני שתשובת /inbook של הכרטיס הקודם הגיעה.
    await runPluginSearch(harness, 'תפילה');
    await vi.waitFor(() =>
      expect(harness.shell.querySelector('.search-terms')?.textContent).toContain('תפילה'),
    );
    releaseInBook({
      body: JSON.stringify({ hitCount: 1, pages: [3], matchedTerms: ['ברכת'] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(harness.host.countOf('reader.openBook')).toBe(0);
    expect(harness.shell.querySelector('.results-screen')?.classList.contains('hidden')).toBe(false);
    expect(harness.shell.querySelector('.search-terms')?.textContent).toContain('תפילה');
    expect(harness.host.countOf('ui.showError')).toBe(0);
  });

  it('פתיחה בקורא הישן שהתעכבה אינה מחזירה את הקורא לאחר חזרה לתוצאות', async () => {
    let releaseInBook!: (reply: { body: string }) => void;
    const openBook = vi.spyOn(ViewerScreen.prototype, 'openBook').mockResolvedValue(undefined);
    try {
      const harness = await bootHarness({
        methods: {
          'reader.openSearchTab': () => {
            throw new Error('unknown method');
          },
        },
        network: {
          '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow()]) }),
          '/inbook': () => new Promise((resolve) => { releaseInBook = resolve; }),
        },
      });
      await submitFromDialog(harness, 'ברכת המזון');
      await vi.waitFor(() => expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(1));
      void (harness.controller as unknown as {
        openBook(result: { fileId: string; bookName: string }): Promise<void>;
      }).openBook({ fileId: '43558', bookName: 'קובץ שיטות קמאי' });
      await vi.waitFor(() => expect(inBookBodies(harness)).toHaveLength(1));

      harness.shell.querySelector<HTMLButtonElement>('[aria-label="חזרה לתוצאות החיפוש"]')?.click();
      expect(harness.shell.querySelector('.results-screen')?.classList.contains('hidden')).toBe(false);
      releaseInBook({
        body: JSON.stringify({ hitCount: 1, pages: [3], matchedTerms: ['ברכת'] }),
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(openBook).not.toHaveBeenCalled();
      expect(harness.shell.querySelector('.results-screen')?.classList.contains('hidden')).toBe(false);
      expect(harness.shell.querySelector('.viewer-screen')?.classList.contains('hidden')).toBe(true);
      expect(harness.host.countOf('ui.showError')).toBe(0);
    } finally {
      openBook.mockRestore();
    }
  });

  it('לחיצה שנייה על תוצאה מחליפה פתיחה ראשונה שעדיין ממתינה ל-/inbook', async () => {
    const releases = new Map<string, (reply: { body: string }) => void>();
    const harness = await bootHarness(
      pluginSearchConfig({
        network: {
          '/search': () => ({
            body: hebrewBooksNdjson([
              hebrewBooksRow({ fileId: '43558', bookName: 'ספר ראשון' }),
              hebrewBooksRow({ fileId: '43559', bookName: 'ספר שני' }),
            ]),
          }),
          '/inbook': (payload) => new Promise((resolve) => {
            const body = JSON.parse(String(payload.body)) as { fileName: string };
            releases.set(body.fileName, resolve);
          }),
        },
      }),
    );
    await runPluginSearch(harness);
    await vi.waitFor(() => expect(harness.shell.querySelectorAll('.result-card')).toHaveLength(2));
    const cards = [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')];
    expect(cards.at(-2)?.textContent).toContain('ספר ראשון');
    expect(cards.at(-1)?.textContent).toContain('ספר שני');
    cards.at(-2)?.click();
    await vi.waitFor(() => expect(releases.has('43558')).toBe(true));
    cards.at(-1)?.click();
    await vi.waitFor(() => expect(releases.has('43559')).toBe(true));

    releases.get('43558')?.({
      body: JSON.stringify({ hitCount: 1, pages: [3], matchedTerms: ['ברכת'] }),
    });
    releases.get('43559')?.({
      body: JSON.stringify({ hitCount: 1, pages: [7], matchedTerms: ['המזון'] }),
    });
    await vi.waitFor(() => expect(harness.host.countOf('reader.openBook')).toBe(1));

    expect(harness.host.lastPayload('reader.openBook')).toMatchObject({
      external: { provider: 'hebrewbooks', id: 43559 },
      index: 7,
    });
  });

  it('כשל פתיחה ישן אינו מוצג אחרי חיפוש חדש', async () => {
    let resolveOpen!: (opened: boolean) => void;
    const harness = await bootHarness(
      pluginSearchConfig({
        methods: {
          'reader.openBook': () => new Promise((resolve) => { resolveOpen = resolve; }),
        },
      }),
    );
    await runPluginSearch(harness);
    harness.shell.querySelector<HTMLElement>('.result-card-body')?.click();
    await vi.waitFor(() => expect(harness.host.countOf('reader.openBook')).toBe(1));

    await runPluginSearch(harness, 'תפילה');
    await vi.waitFor(() =>
      expect(harness.shell.querySelector('.search-terms')?.textContent).toContain('תפילה'),
    );
    resolveOpen(false);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(harness.host.countOf('ui.showError')).toBe(0);
    expect(harness.shell.querySelector('.search-terms')?.textContent).toContain('תפילה');
  });

  it('פתיחת תוצאת היברובוקס בחיפוש הדוק חוזרת לברירת המחדל כשהאיתור ההדוק ריק', async () => {
    const harness = await bootHarness(
      pluginSearchConfig({
        network: {
          '/inbook': (payload) => {
            const body = JSON.parse(String(payload.body)) as Record<string, unknown>;
            return {
              body: JSON.stringify(
                body.proximity === 1
                  ? { hitCount: 0, pages: [], matchedTerms: [] }
                  : { hitCount: 2, pages: [8, 12], matchedTerms: ['ברכת', 'המזון'] },
              ),
            };
          },
        },
      }),
    );
    await runPluginSearch(harness, 'ברכת המזון', { proximity: 1, requireWordOrder: true });
    [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')].at(-1)?.click();

    await vi.waitFor(() => expect(harness.host.countOf('reader.openBook')).toBe(1));
    expect(inBookBodies(harness)).toEqual([
      expect.objectContaining({ proximity: 1, requireWordOrder: true }),
      expect.objectContaining({ proximity: 30, requireWordOrder: false }),
    ]);
    expect(harness.host.lastPayload('reader.openBook')).toMatchObject({
      index: 8,
      matchPages: [8, 12],
      matchedTerms: ['ברכת', 'המזון'],
    });
    // הפתיחה החוזרת משתמשת בשתי תוצאות האיתור שכבר הגיעו, בלי שתי בקשות נוספות.
    [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')].at(-1)?.click();
    await vi.waitFor(() => expect(harness.host.countOf('reader.openBook')).toBe(2));
    expect(inBookBodies(harness)).toHaveLength(2);
  });

  it('ספר היברובוקס נפתח בקורא של אוצריא בעמוד ההתאמה הראשון', async () => {
    const harness = await bootHarness(pluginSearchConfig());
    await runPluginSearch(harness);
    [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')].at(-1)?.click();

    await vi.waitFor(() => expect(harness.host.countOf('reader.openBook')).toBe(1));
    expect(harness.host.lastPayload('reader.openBook')).toEqual({
      external: { provider: 'hebrewbooks', id: 43558 },
      index: 3,
      searchQuery: 'ברכת המזון',
      navigateToPositionIfReused: true,
      matchPages: [3, 5],
      matchedTerms: ['ברכת'],
    });
    expect(inBookBodies(harness)).toHaveLength(1);
  });

  it('העמוד הנפתח הוא מספר עמוד מבוסס-1, כמו עמודי ההתאמה שנשלחים איתו', async () => {
    // /inbook מחזיר עמודי PDF מבוססי-1, ואוצריא מוסרת את index ל-PdfBookTab
    // כ-pageNumber — גם הוא מבוסס-1. הקטנה ב-1 פתחה את הספר עמוד אחד מוקדם.
    const harness = await bootHarness(
      pluginSearchConfig({
        network: {
          '/inbook': () => ({
            body: JSON.stringify({ hitCount: 3, pages: [12, 40], matchedTerms: ['ברכת'] }),
          }),
        },
      }),
    );
    await runPluginSearch(harness);
    [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')].at(-1)?.click();

    await vi.waitFor(() => expect(harness.host.countOf('reader.openBook')).toBe(1));
    const payload = harness.host.lastPayload('reader.openBook');
    expect(payload).toMatchObject({ index: 12, matchPages: [12, 40] });
    expect(payload?.index).toBe((payload?.matchPages as number[])[0]);
  });

  it('ספר שאינו בקטלוג ההיברובוקס של אוצריא מוצג כשגיאה', async () => {
    const harness = await bootHarness(
      pluginSearchConfig({ methods: { 'reader.openBook': () => false } }),
    );
    await runPluginSearch(harness);
    [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')].at(-1)?.click();
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(harness.host.lastPayload('ui.showError')).toEqual({
      message: 'הספר לא נמצא בקטלוג היברובוקס של אוצריא',
    });
  });

  it('כשל באיתור העמודים מוצג כשגיאה', async () => {
    const harness = await bootHarness(
      pluginSearchConfig({
        network: {
          '/inbook': () => ({ status: 500, ok: false, body: JSON.stringify({ error: 'האינדקס נעול' }) }),
        },
      }),
    );
    await runPluginSearch(harness);
    [...harness.shell.querySelectorAll<HTMLElement>('.result-card-body')].at(-1)?.click();
    await vi.waitFor(() => expect(harness.host.countOf('ui.showError')).toBe(1));
    expect(harness.host.lastPayload('ui.showError')).toEqual({ message: 'האינדקס נעול' });
    expect(harness.host.countOf('reader.openBook')).toBe(0);
    expect(inBookBodies(harness)).toHaveLength(1);
  });

  it('מקש Enter על כרטיס פותח את התוצאה', async () => {
    const harness = await bootHarness(pluginSearchConfig());
    await runPluginSearch(harness);
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
    const harness = await bootHarness(pluginSearchConfig());
    await runPluginSearch(harness);
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
    const harness = await bootHarness(pluginSearchConfig());
    await runPluginSearch(harness);
    harness.shell.querySelector<HTMLButtonElement>('[aria-label="העתק את פרטי הספר"]')?.click();
    await vi.waitFor(() => expect(harness.host.countOf('ui.showMessage')).toBe(1));
    expect(writeText).toHaveBeenCalledWith('קובץ שיטות קמאי, מחבר, ירושלים, תשס"ד');
    expect(harness.host.lastPayload('ui.showMessage')).toEqual({ message: 'הטקסט הועתק' });
  });

  it('בהקשר לא מאובטח נופל למסלול execCommand', async () => {
    stubClipboard(() => Promise.reject(new Error('הקשר לא מאובטח')));
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    const harness = await bootHarness(pluginSearchConfig());
    await runPluginSearch(harness);
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
    const harness = await bootHarness(pluginSearchConfig());
    await runPluginSearch(harness);
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
    const harness = await bootHarness(pluginSearchConfig());
    await runPluginSearch(harness);
    harness.shell.querySelector<HTMLButtonElement>('[aria-label="חזרה למסך הפתיחה"]')?.click();
    expect(harness.shell.querySelector('.library-screen')?.classList.contains('hidden')).toBe(false);
    expect(harness.shell.querySelector('.results-screen')?.classList.contains('hidden')).toBe(true);
    expect(harness.shell.querySelector('.viewer-screen')?.classList.contains('hidden')).toBe(true);
  });

  it('שירות ישן מהנדרש מודיע ואינו חוסם, ונוקב בגרסאות ובדרך לתקן', async () => {
    const harness = await bootHarness(
      pluginSearchConfig({
        network: {
          '/health': () => ({
            body: JSON.stringify({
              ok: true,
              service: 'hbsearch',
              apiVersion: 2,
              capabilities: ['pdf-range'],
              serverVersion: '3.0.100',
            }),
          }),
        },
      }),
    );
    const warning = harness.shell.querySelector('.library-version-warning')?.textContent ?? '';
    expect(warning).toContain('3.0.100');
    expect(warning).toContain(requiredServiceVersion);
    expect(warning).toContain('מתקין HebrewBooks לאוצריא');
    // מודיע ואינו חוסם: המסך נשאר "מחובר", והחיפוש עצמו ממשיך להחזיר תוצאות.
    expect(harness.shell.querySelector('.library-status')?.textContent).toContain(
      'שירות החיפוש מחובר',
    );
    expect(harness.shell.querySelector('.informative-state')).toBeNull();
    await runPluginSearch(harness);
    expect(harness.shell.querySelectorAll('.result-card').length).toBeGreaterThan(0);
  });

  it('שירות חדש מהנדרש אינו מתריע', async () => {
    const harness = await bootHarness({
      network: {
        '/health': () => ({
          body: JSON.stringify({
            ok: true,
            service: 'hbsearch',
            apiVersion: 2,
            capabilities: ['pdf-range'],
            serverVersion: '99.0.0',
          }),
        }),
      },
    });
    expect(harness.shell.querySelector('.library-version-warning')).toBeNull();
  });

  it('שירות שאינו מדווח גרסה כלל מבקש עדכון באותה אזהרה, ואינו חוסם', async () => {
    const harness = await bootHarness({
      network: { '/health': () => ({ body: JSON.stringify({ ok: true, service: 'hbsearch' }) }) },
    });
    const warning = harness.shell.querySelector('.library-version-warning')?.textContent ?? '';
    expect(warning).toContain('אינו מדווח על גרסתו');
    expect(warning).toContain(requiredServiceVersion);
    expect(warning).toContain('מתקין HebrewBooks לאוצריא');
    expect(harness.shell.querySelector('.library-status')?.textContent).toBe(
      'שירות החיפוש מחובר (חיפוש בלבד)',
    );
  });
});
