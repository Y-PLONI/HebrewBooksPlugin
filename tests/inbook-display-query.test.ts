// @vitest-environment jsdom

/// שדה displayQuery של /inbook אמור לשאת את טקסט המשתמש. בהתאמה חלקית
/// snapshot.query היא שאילתת אופרטורים, והשדה נשא אותה — כלומר לא את מה
/// ששמו אומר.

import { describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: Promise.reject(new Error('אין קובץ בבדיקה')) }),
}));

const { HebrewBooksRepository } = await import('../src/repositories/hebrewbooks-repository');
const { AppController } = await import('../src/app-controller');
const { defaultSearchOptions } = await import('../src/models');
const { bootPayload, createMockHost, hebrewBooksNdjson, hebrewBooksRow } = await import(
  './helpers/mock-host'
);

type MockHost = ReturnType<typeof createMockHost>;
type SearchSnapshot = import('../src/models').SearchSnapshot;

const inBookReply = {
  body: JSON.stringify({ hitCount: 2, pages: [5], matchedTerms: ['ברכת'] }),
};

function inBookBodies(host: MockHost): Array<Record<string, unknown>> {
  return host
    .payloadsOf('network.fetchStream')
    .filter((payload) => String(payload?.url).endsWith('/inbook'))
    .map((payload) => JSON.parse(String(payload?.body)) as Record<string, unknown>);
}

describe('/inbook — displayQuery', () => {
  it('נושא את טקסט המשתמש כששאילתת המנוע היא אופרטורים', async () => {
    const host = createMockHost({ network: { '/inbook': () => inBookReply } });
    const repository = new HebrewBooksRepository(host.bridge);
    const snapshot: SearchSnapshot = {
      query: 'ברכת or המזון',
      displayQuery: 'ברכת המזון',
      options: defaultSearchOptions,
      fingerprint: 'f',
    };
    await repository.inBook(snapshot, '43558');
    expect(inBookBodies(host)[0]).toMatchObject({
      q: 'ברכת or המזון',
      displayQuery: 'ברכת המזון',
    });
  });

  it('בחיפוש רגיל הוא זהה לשאילתה, כפי שהיה', async () => {
    const host = createMockHost({ network: { '/inbook': () => inBookReply } });
    const repository = new HebrewBooksRepository(host.bridge);
    const snapshot: SearchSnapshot = {
      query: 'ברכת המזון',
      options: defaultSearchOptions,
      fingerprint: 'f',
    };
    await repository.inBook(snapshot, '43558');
    expect(inBookBodies(host)[0]).toMatchObject({
      q: 'ברכת המזון',
      displayQuery: 'ברכת המזון',
    });
  });

  it('גם ניסיון הפתיחה החוזר בהגדרות ברירת המחדל שומר עליו', async () => {
    const host = createMockHost({
      methods: {
        'database.batchQuery': () => ({ results: [{ rows: [] }] }),
        'reader.openSearchTab': () => {
          throw new Error('unknown method');
        },
      },
      network: {
        '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow({ firstHitPage: undefined })]) }),
        // רשימת עמודים ריקה מכריחה את הניסיון החוזר בהגדרות ברירת המחדל.
        '/inbook': () => ({ body: JSON.stringify({ hitCount: 0, pages: [], matchedTerms: [] }) }),
      },
      searchQuery: () => [],
    });
    const shell = document.createElement('div');
    document.body.append(shell);
    const controller = new AppController(host.bridge, shell);
    await controller.boot(bootPayload());
    host.emit('search.requested', {
      itemId: 'tab-1',
      // limit שאינו ברירת המחדל מבדיל את הטביעה, ולכן הניסיון החוזר באמת יוצא.
      request: { query: 'ברכת המזון ארוכה', mode: 'exact', wordMatchMode: 'anyWord', limit: 5 },
    });
    await vi.waitFor(() => expect(shell.querySelectorAll('.result-card').length).toBeGreaterThan(0));
    shell.querySelector<HTMLElement>('.result-card-body')?.click();
    await vi.waitFor(() => expect(inBookBodies(host).length).toBeGreaterThan(1));

    const bodies = inBookBodies(host);
    expect(bodies.every((body) => body.displayQuery === 'ברכת המזון ארוכה')).toBe(true);
    expect(bodies.some((body) => String(body.q).includes(' or '))).toBe(true);
  });
});
