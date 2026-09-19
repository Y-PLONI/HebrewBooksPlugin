// @vitest-environment jsdom

/// בהתאמה חלקית snapshot.query היא שאילתת אופרטורים שנבנתה עבור המנוע
/// ("א or ב"), ולא מה שהמשתמש הקליד. השאילתה הזו נבנית במסלול המדור
/// החיצוני; כל מקום שמציג שאילתה או מדגיש לפיה חייב לקרוא את displayQuery.

import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: Promise.reject(new Error('אין קובץ בבדיקה')) }),
}));

const { AppController } = await import('../src/app-controller');
const { defaultSearchOptions } = await import('../src/models');
const { bootPayload, createMockHost, hebrewBooksNdjson, hebrewBooksRow } = await import(
  './helpers/mock-host'
);

type MockHost = ReturnType<typeof createMockHost>;
type SearchOptions = import('../src/models').SearchOptions;

const userQuery = 'ברכת המזון ארוכה';

interface Harness {
  readonly host: MockHost;
  readonly shell: HTMLElement;
  readonly controller: InstanceType<typeof AppController>;
}

async function bootHarness(): Promise<Harness> {
  const host = createMockHost({
    methods: {
      'database.batchQuery': () => ({ results: [{ rows: [] }] }),
      'reader.openSearchTab': () => {
        throw new Error('unknown method');
      },
    },
    network: {
      '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow({ firstHitPage: undefined })]) }),
      '/inbook': () => ({
        body: JSON.stringify({ hitCount: 2, pages: [5], matchedTerms: ['ברכת'] }),
      }),
    },
  });
  const shell = document.createElement('div');
  document.body.append(shell);
  const controller = new AppController(host.bridge, shell);
  await controller.boot(bootPayload());
  await Promise.resolve();
  return { host, shell, controller };
}

/// בקשה למדור התוצאות החיצוני שבה אוצריא מוותרת על "כל המילים", כך שהתוסף
/// בונה שאילתת אופרטורים. זה המסלול היחיד שבו היא נבנית.
async function externalSearchWithOperators(harness: Harness): Promise<void> {
  harness.host.emit('search.external.requested', {
    requestId: 'xs-1',
    provider: 'hebrewbooks',
    query: userQuery,
    mode: 'exact',
    wordMatchMode: 'anyWord',
    offset: 0,
    limit: 20,
  });
  await vi.waitFor(() => expect(sentQuery(harness)).not.toBe(''));
}

/// חיפוש שהתוסף מריץ בעצמו ומציג במסך שלו — תמיד בטקסט של המשתמש.
async function pluginSearch(harness: Harness, options: Partial<SearchOptions> = {}): Promise<void> {
  void (
    harness.controller as unknown as {
      performSearch(query: string, options: SearchOptions): Promise<void>;
    }
  ).performSearch(userQuery, { ...defaultSearchOptions, ...options });
  await vi.waitFor(() =>
    expect(harness.shell.querySelectorAll('.result-card').length).toBeGreaterThan(0),
  );
}

function clickByTooltip(root: ParentNode, tooltip: string): void {
  const button = root.querySelector<HTMLButtonElement>(`[title="${tooltip}"], [aria-label="${tooltip}"]`);
  if (!button) throw new Error(`אין כפתור ${tooltip}`);
  button.click();
}

function sentQuery(harness: Harness): string {
  const search = harness.host
    .payloadsOf('network.fetchStream')
    .find((payload) => String(payload?.url).endsWith('/search'));
  if (!search) return '';
  return String((JSON.parse(String(search.body)) as { q: string }).q);
}

beforeAll(() => {
  // jsdom אינו מממש <dialog>.
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

describe('שאילתת אופרטורים אינה דולפת אל המשתמש', () => {
  it('המנוע אכן מקבל שאילתת אופרטורים במדור החיצוני — אחרת אין מה לבדוק', async () => {
    const harness = await bootHarness();
    await externalSearchWithOperators(harness);
    expect(sentQuery(harness)).toContain(' or ');
    expect(sentQuery(harness)).not.toBe(userQuery);
  });

  it('החיפוש שהתוסף מריץ בעצמו נשלח למנוע כטקסט המשתמש', async () => {
    const harness = await bootHarness();
    await pluginSearch(harness);
    expect(sentQuery(harness)).toBe(userQuery);
  });

  it('דיאלוג חיפוש חדש נפתח עם טקסט המשתמש', async () => {
    const harness = await bootHarness();
    await pluginSearch(harness);
    clickByTooltip(harness.shell, 'ערוך חיפוש');
    const dialog = document.querySelector<HTMLElement>('dialog.search-dialog');
    expect(dialog?.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe(userQuery);
  });

  it('פתיחת ספר מעבירה לקורא של אוצריא את טקסט המשתמש להדגשה', async () => {
    const harness = await bootHarness();
    await pluginSearch(harness);
    harness.shell.querySelector<HTMLElement>('.result-card-body')?.click();
    await vi.waitFor(() => expect(harness.host.countOf('reader.openBook')).toBe(1));
    expect(harness.host.lastPayload('reader.openBook')).toMatchObject({ searchQuery: userQuery });
  });
});
