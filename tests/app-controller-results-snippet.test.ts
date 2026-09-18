// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({
  opens: [] as string[],
  pages: [] as number[],
  text: 'לפני ברכת המזון ואחרי',
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: ({ url }: { url: string }) => {
    pdf.opens.push(url);
    return { promise: Promise.resolve({
      numPages: 50,
      getPage: (page: number) => {
        pdf.pages.push(page);
        return Promise.resolve({ getTextContent: () => Promise.resolve({
          items: pdf.text.split(' ').map((str) => ({ str })),
        }) });
      },
      destroy: () => Promise.resolve(),
    }) };
  },
}));

const { AppController } = await import('../src/app-controller');
const { bootPayload, createMockHost, hebrewBooksNdjson, hebrewBooksRow } = await import('./helpers/mock-host');
type MockHostConfig = import('./helpers/mock-host').MockHostConfig;

const visible: { callback?: IntersectionObserverCallback } = {};
class DeferredIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) { visible.callback = callback; }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

async function boot(config: MockHostConfig = {}) {
  const host = createMockHost({
    methods: { 'database.batchQuery': () => ({ results: [{ rows: [] }] }) },
    network: {
      '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow({ firstHitPage: undefined })]) }),
      '/inbook': () => ({ body: JSON.stringify({ hitCount: 1, pages: [12], matchedTerms: ['ברכת'] }) }),
      ...config.network,
    },
    searchQuery: () => [],
  });
  const shell = document.createElement('div');
  document.body.append(shell);
  const controller = new AppController(host.bridge, shell);
  await controller.boot(bootPayload());
  host.emit('search.requested', { itemId: 'tab-1', request: { query: 'ברכת המזון', mode: 'exact', distance: 5 } });
  await vi.waitFor(() => expect(shell.querySelector('.hebrewbooks-snippet')).not.toBeNull());
  return { host, shell };
}

function reveal(shell: HTMLElement): void {
  const target = shell.querySelector<HTMLElement>('.hebrewbooks-snippet')!;
  visible.callback?.([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
}

function inBookCalls(host: ReturnType<typeof createMockHost>) {
  return host.payloadsOf('network.fetchStream').filter((payload) => String(payload?.url).endsWith('/inbook'));
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal('IntersectionObserver', DeferredIntersectionObserver);
  pdf.opens.length = 0;
  pdf.pages.length = 0;
  pdf.text = 'לפני ברכת המזון ואחרי';
  visible.callback = undefined;
});

describe('מסך התוצאות — איתור עצלני של עמוד לגזיר', () => {
  it('אינו מבקש /inbook לפני שהכרטיס נראה, ואז משתמש באפשרויות החיפוש ובעמוד שאותר', async () => {
    const { host, shell } = await boot();
    expect(inBookCalls(host)).toHaveLength(0);
    expect(pdf.opens).toHaveLength(0);
    reveal(shell);
    await vi.waitFor(() => expect(shell.querySelector('.hebrewbooks-snippet')?.textContent).toContain('עמוד 12 ·'));
    expect(shell.querySelector('.hebrewbooks-snippet')?.textContent).toContain('ברכת המזון');
    expect(inBookCalls(host)).toHaveLength(1);
    expect(JSON.parse(String(inBookCalls(host)[0]?.body))).toMatchObject({ fileName: '43558', proximity: 6 });
    expect(pdf.pages).toEqual([12]);
  });

  it('בלי מיקום התאמה לא פותח PDF', async () => {
    const { host, shell } = await boot({ network: {
      '/inbook': () => ({ body: JSON.stringify({ hitCount: 0, pages: [] }) }),
    } });
    reveal(shell);
    await vi.waitFor(() => expect(shell.querySelector('.hebrewbooks-snippet')?.textContent).toBe('לא ניתן לאתר עמוד לגזיר הטקסט'));
    expect(inBookCalls(host)).toHaveLength(1);
    expect(pdf.opens).toHaveLength(0);
  });

  it('כשל /inbook מוצג ומאפשר ניסיון חוזר בכרטיס חדש', async () => {
    let attempts = 0;
    const { host, shell } = await boot({ network: {
      '/inbook': () => ++attempts === 1
        ? { status: 500, ok: false, body: JSON.stringify({ error: 'האינדקס נעול' }) }
        : { body: JSON.stringify({ hitCount: 1, pages: [12], matchedTerms: ['ברכת'] }) },
    } });
    reveal(shell);
    await vi.waitFor(() => expect(shell.querySelector('.hebrewbooks-snippet')?.textContent).toBe('לא ניתן היה לאתר את עמוד ההתאמה כרגע'));
    expect(inBookCalls(host)).toHaveLength(1);
    expect(pdf.opens).toHaveLength(0);
    host.emit('search.requested', { itemId: 'tab-1', request: { query: 'ברכת המזון', mode: 'exact', distance: 5 } });
    await vi.waitFor(() => expect(shell.querySelector('.hebrewbooks-snippet')?.textContent).toContain('מאתר עמוד'));
    reveal(shell);
    await vi.waitFor(() => expect(shell.querySelector('.hebrewbooks-snippet')?.textContent).toContain('עמוד 12 ·'));
    expect(inBookCalls(host)).toHaveLength(2);
  });

  it('תוצאות רבות אינן יוצרות בקשות /inbook עד שגזיר יחיד נראה', async () => {
    const rows = Array.from({ length: 200 }, (_, index) =>
      hebrewBooksRow({ fileId: String(index + 1), firstHitPage: undefined }),
    );
    const { host, shell } = await boot({ network: {
      '/search': () => ({ body: hebrewBooksNdjson(rows) }),
    } });
    // עמוד התוצאות מוגבל ל־100 כרטיסים, גם כשהשרת הזרימם יותר.
    expect(shell.querySelectorAll('.hebrewbooks-snippet')).toHaveLength(100);
    expect(inBookCalls(host)).toHaveLength(0);
    reveal(shell);
    await vi.waitFor(() => expect(inBookCalls(host)).toHaveLength(1));
  });

  it('תוצאת חיפוש ישנה אינה פותחת PDF לאחר שהחיפוש הוחלף', async () => {
    let release: ((value: { body: string }) => void) | undefined;
    const { host, shell } = await boot({ network: {
      '/inbook': () => new Promise((resolve) => { release = resolve; }),
    } });
    reveal(shell);
    await vi.waitFor(() => expect(inBookCalls(host)).toHaveLength(1));
    host.emit('search.requested', { itemId: 'tab-1', request: { query: 'מילה אחרת', mode: 'exact' } });
    await vi.waitFor(() => expect(shell.querySelector('.hebrewbooks-snippet')?.textContent).toContain('מאתר עמוד'));
    release?.({ body: JSON.stringify({ hitCount: 1, pages: [12], matchedTerms: ['ברכת'] }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(pdf.opens).toHaveLength(0);
  });

  it('עמוד שכבר הגיע מתוצאות החיפוש אינו גורר קריאת /inbook', async () => {
    const { host, shell } = await boot({ network: {
      '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow({ firstHitPage: 7 })]) }),
    } });
    reveal(shell);
    await vi.waitFor(() => expect(shell.querySelector('.hebrewbooks-snippet')?.textContent).toContain('עמוד 7 ·'));
    expect(inBookCalls(host)).toHaveLength(0);
    expect(pdf.pages).toEqual([7]);
  });

  it('PDF ללא שכבת טקסט מציג הודעה כללית לצד מספר העמוד בלי להמציא גזיר', async () => {
    pdf.text = '';
    const { shell } = await boot();
    reveal(shell);
    await vi.waitFor(() => expect(shell.querySelector('.hebrewbooks-snippet')?.textContent).toBe('עמוד 12 · אין גזיר טקסט זמין'));
  });

  it('גם שכבת טקסט שאינה מכילה את המונח אינה מוצגת כגזיר', async () => {
    pdf.text = 'טקסט אחר לחלוטין';
    const { shell } = await boot();
    reveal(shell);
    await vi.waitFor(() => expect(shell.querySelector('.hebrewbooks-snippet')?.textContent).toBe('עמוד 12 · אין גזיר טקסט זמין'));
  });
});
