// @vitest-environment jsdom

/// "לפחות N מילים" בטאב החיפוש של אוצריא: המספר שהמשתמש בחר חייב להגיע עד
/// שאילתת האופרטורים שנשלחת ל-hbsearch, ולא ליפול לברירת המחדל 2.

import { describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({ promise: new Promise(() => undefined) }),
}));

const { AppController } = await import('../src/app-controller');
const { bootPayload, createMockHost, hebrewBooksNdjson, hebrewBooksRow } = await import(
  './helpers/mock-host'
);

type MockHost = ReturnType<typeof createMockHost>;

async function bootController(): Promise<MockHost> {
  const host = createMockHost({
    network: {
      '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow({ firstHitPage: undefined })]) }),
    },
  });
  const controller = new AppController(host.bridge, document.createElement('div'));
  await controller.boot(bootPayload());
  await Promise.resolve();
  return host;
}

/// השאילתה שנשלחה בפועל ל-/search.
async function sentQuery(host: MockHost): Promise<string> {
  await vi.waitFor(
    () =>
      expect(
        host.payloadsOf('network.fetchStream').some((payload) => String(payload?.url).endsWith('/search')),
      ).toBe(true),
    { timeout: 5_000 },
  );
  const search = host
    .payloadsOf('network.fetchStream')
    .find((payload) => String(payload?.url).endsWith('/search'));
  return String((JSON.parse(String(search?.body)) as { q: string }).q);
}

function request(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: 'xs-1',
    provider: 'hebrewbooks',
    query: 'אלף בית גימל דלת',
    mode: 'exact',
    distance: 2,
    offset: 0,
    limit: 20,
    ...overrides,
  };
}

/// כמה מילים יש בכל צירוף של שאילתת האופרטורים שנבנתה.
function wordsPerGroup(query: string): number[] {
  return [...query.matchAll(/\(([^)]*)\)/g)].map((group) => (group[1] ?? '').split(' w/').length);
}

describe('"לפחות N מילים" במדור התוצאות החיצוני', () => {
  it('המספר שהמארח שלח הוא שקובע, ולא ברירת המחדל 2', async () => {
    const host = await bootController();
    host.emit(
      'search.external.requested',
      request({ wordMatchMode: 'atLeast', wordMatchCount: 3 }),
    );
    const groups = wordsPerGroup(await sentQuery(host));
    expect(groups.length).toBeGreaterThan(0);
    expect(new Set(groups)).toEqual(new Set([3]));
  });

  it('בקשה ל-2 מתוך 4 עדיין בונה צירופי זוגות', async () => {
    const host = await bootController();
    host.emit(
      'search.external.requested',
      request({ wordMatchMode: 'atLeast', wordMatchCount: 2 }),
    );
    expect(new Set(wordsPerGroup(await sentQuery(host)))).toEqual(new Set([2]));
  });

  it('בלי מספר מהמארח נשארת ברירת המחדל של אוצריא', async () => {
    const host = await bootController();
    host.emit('search.external.requested', request({ wordMatchMode: 'atLeast' }));
    expect(new Set(wordsPerGroup(await sentQuery(host)))).toEqual(new Set([2]));
  });

  it('מדיניות שאין לה תרגום נענית בהודעה, ולא בחיפוש אחר בשקט', async () => {
    const host = await bootController();
    host.emit(
      'search.external.requested',
      request({ query: 'א ב ג ד ה ו ז ח ט י כ ל', wordMatchMode: 'mostWords' }),
    );

    const error = await vi.waitFor(
      () => {
        const payload = host
          .payloadsOf('reader.respondExternalSearch')
          .find((entry) => typeof entry?.error === 'string');
        expect(payload).toBeDefined();
        return String(payload?.error);
      },
      { timeout: 5_000 },
    );
    expect(error).toContain('אינו נתמך');
    expect(
      host.payloadsOf('network.fetchStream').some((payload) => String(payload?.url).endsWith('/search')),
    ).toBe(false);
  });
});
