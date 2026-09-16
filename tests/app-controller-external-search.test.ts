// @vitest-environment jsdom

/// המסלול המרכזי בייצור: אוצריא פותחת טאב חיפוש מובנה, והתוסף עונה כספק
/// תוצאות חיצוני — הזרמה, דפדוף לפי מזהים, אינדקס קטגוריות וגזירי טקסט.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({
  opens: [] as string[],
  text: 'פתיחה ארוכה של העמוד ואז ברכת המזון בשלוש ברכות ואחר כך המשך הטקסט',
  blocked: false,
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (options: { url: string }) => {
    pdf.opens.push(options.url);
    const promise = (async () => {
      if (pdf.blocked) await new Promise(() => undefined);
      return {
        numPages: 40,
        getPage: () =>
          Promise.resolve({
            getTextContent: () =>
              Promise.resolve({ items: pdf.text.split(' ').map((str) => ({ str })) }),
          }),
        destroy: () => Promise.resolve(),
      };
    })();
    return { promise };
  },
}));

const { AppController } = await import('../src/app-controller');
const { bootPayload, createMockHost, hebrewBooksNdjson, hebrewBooksRow } = await import(
  './helpers/mock-host'
);

type MockHost = ReturnType<typeof createMockHost>;
type MockHostConfig = import('./helpers/mock-host').MockHostConfig;

async function bootController(config: MockHostConfig = {}): Promise<MockHost> {
  const host = createMockHost(config);
  const controller = new AppController(host.bridge, document.createElement('div'));
  await controller.boot(bootPayload());
  await Promise.resolve();
  return host;
}

function externalRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'xs-1',
    provider: 'hebrewbooks',
    query: 'ברכת המזון',
    mode: 'exact',
    distance: 2,
    offset: 0,
    limit: 20,
    ...overrides,
  };
}

function responsesFor(host: MockHost, requestId: string): Array<Record<string, unknown>> {
  return host
    .payloadsOf('reader.respondExternalSearch')
    .filter((payload): payload is Record<string, unknown> => payload?.requestId === requestId);
}

async function finalResponse(host: MockHost, requestId = 'xs-1'): Promise<Record<string, unknown>> {
  await vi.waitFor(
    () =>
      expect(
        responsesFor(host, requestId).some((payload) => payload.done === undefined),
      ).toBe(true),
    { timeout: 5_000 },
  );
  const final = responsesFor(host, requestId).at(-1);
  if (!final) throw new Error('לא נשלחה תשובה סופית');
  return final;
}

function resultsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return (payload.results ?? []) as Array<Record<string, unknown>>;
}

/// כמה פעמים נשלחה בקשת חיפוש לשירות (בניגוד ל-/inbook או /health).
function searchRequests(host: MockHost): number {
  return host
    .payloadsOf('network.fetchStream')
    .filter((payload) => String(payload?.url).endsWith('/search')).length;
}

/// מריק את תור המיקרוטסקים — הזרימה כולה מבוססת הבטחות, ולכן די בכך כדי
/// להגיע לנקודה שבה נקבע הטיימר שנבדק.
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 200; index += 1) await Promise.resolve();
}

const singleRowNetwork: MockHostConfig['network'] = {
  '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow()]) }),
};

beforeEach(() => {
  pdf.opens.length = 0;
  pdf.text = 'פתיחה ארוכה של העמוד ואז ברכת המזון בשלוש ברכות ואחר כך המשך הטקסט';
  pdf.blocked = false;
  vi.useRealTimers();
});

describe('ספק התוצאות החיצוני — אימות הבקשה', () => {
  it('בקשה בלי requestId אינה נענית כלל', async () => {
    const host = await bootController({ network: singleRowNetwork });
    host.emit('search.external.requested', externalRequest({ requestId: undefined }));
    await Promise.resolve();
    expect(host.countOf('reader.respondExternalSearch')).toBe(0);
  });

  it('שאילתה ריקה מוחזרת כשגיאה בלי לפנות לשירות', async () => {
    const host = await bootController({ network: singleRowNetwork });
    const searchesBefore = host.countOf('network.fetchStream');
    host.emit('search.external.requested', externalRequest({ query: '   ' }));
    await vi.waitFor(() => expect(host.countOf('reader.respondExternalSearch')).toBe(1));
    expect(host.lastPayload('reader.respondExternalSearch')).toEqual({
      requestId: 'xs-1',
      error: 'בקשת החיפוש אינה תקינה',
    });
    expect(host.countOf('network.fetchStream')).toBe(searchesBefore);
  });

  it('שאילתה מעל 500 תווים נדחית', async () => {
    const host = await bootController({ network: singleRowNetwork });
    host.emit('search.external.requested', externalRequest({ query: 'א'.repeat(501) }));
    await vi.waitFor(() => expect(host.countOf('reader.respondExternalSearch')).toBe(1));
    expect(host.lastPayload('reader.respondExternalSearch')).toMatchObject({
      error: 'בקשת החיפוש אינה תקינה',
    });
  });

  it('אפשרויות מהטאב מגיעות לשירות — גם כשמקף מפצל את הטוקניזציה של אוצריא', async () => {
    const host = await bootController({ network: singleRowNetwork });
    host.emit(
      'search.external.requested',
      externalRequest({
        query: 'ברכת-המזון בזימון',
        distance: 30,
        // המפה הגלובלית מכריעה; מפתחות ה-wordOptions בטוקניזציה של אוצריא
        // ('ברכת_0','המזון_1') לא תואמים את הפירוק לפי רווחים של התוסף.
        options: { 'קידומות דקדוקיות': true, 'כתיב מלא/חסר': true },
        wordOptions: {
          'ברכת_0': { 'קידומות דקדוקיות': true, 'כתיב מלא/חסר': true },
          'המזון_1': { 'קידומות דקדוקיות': true, 'כתיב מלא/חסר': true },
          'בזימון_2': { 'קידומות דקדוקיות': true, 'כתיב מלא/חסר': true },
        },
      }),
    );
    await finalResponse(host);
    const searchBody = JSON.parse(
      String(
        host
          .payloadsOf('network.fetchStream')
          .find((payload) => String(payload?.url).endsWith('/search'))?.body,
      ),
    );
    expect(searchBody).toMatchObject({
      proximity: 30,
      hybur: true,
      spelling: true,
      aramaic: false,
      rashetevot: false,
    });
  });

  it('בלי wordOptions ההרחבות כבויות — כמו מארח ותיק', async () => {
    const host = await bootController({ network: singleRowNetwork });
    host.emit('search.external.requested', externalRequest());
    await finalResponse(host);
    const searchBody = JSON.parse(
      String(
        host
          .payloadsOf('network.fetchStream')
          .find((payload) => String(payload?.url).endsWith('/search'))?.body,
      ),
    );
    expect(searchBody).toMatchObject({ proximity: 2, hybur: false, spelling: false });
  });

  it('כשל של שירות החיפוש מוחזר כשגיאה למדור', async () => {
    const host = await bootController({
      network: {
        '/search': () => ({ status: 500, ok: false, body: JSON.stringify({ error: 'השרת עסוק' }) }),
      },
    });
    host.emit('search.external.requested', externalRequest());
    await vi.waitFor(() =>
      expect(
        responsesFor(host, 'xs-1').some((payload) => typeof payload.error === 'string'),
      ).toBe(true),
    );
    expect(responsesFor(host, 'xs-1').at(-1)).toEqual({
      requestId: 'xs-1',
      error: 'השרת עסוק',
    });
  });
});

describe('ספק התוצאות החיצוני — עמודים וספירות', () => {
  it('מציג גילוי זמני במדור ואז מחליף אותו בתוצאות הסופיות המדורגות של v2', async () => {
    const event = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
    const host = await bootController({
      network: {
        '/health': () => ({ body: JSON.stringify({
          ok: true, service: 'hbsearch', apiVersion: 2,
          capabilities: ['pdf-range', 'search-stream-v2'],
        }) }),
        '/search': () => ({
          bodies: [
            event({ type: 'start', streamVersion: 2, streamId: 'a'.repeat(64) })
              + event({ type: 'provisional', result: JSON.parse(hebrewBooksRow({ fileId: '901', firstHitPage: 7 })) }),
            event({ type: 'reset', count: 2 })
              + event({ type: 'result', rank: 0, result: JSON.parse(hebrewBooksRow({ fileId: '903', hitCount: 9, firstHitPage: 7 })) })
              + event({ type: 'result', rank: 1, result: JSON.parse(hebrewBooksRow({ fileId: '902', hitCount: 3, firstHitPage: 7 })) })
              + event({ type: 'complete', count: 2 }),
          ],
          bodyDelaysMs: [0, 350],
        }),
      },
    });
    host.emit('search.external.requested', externalRequest());
    await vi.waitFor(() => expect(responsesFor(host, 'xs-1').some((payload) =>
      payload.done === false && resultsOf(payload)[0]?.externalId === 901,
    )).toBe(true));
    const final = await finalResponse(host);
    expect(resultsOf(final).map((result) => result.externalId)).toEqual([903, 902]);
    expect(resultsOf(final).some((result) => result.externalId === 901)).toBe(false);
    const searchBody = host.payloadsOf('network.fetchStream').find((payload) =>
      String(payload?.url).endsWith('/search'))?.body;
    expect(JSON.parse(String(searchBody))).toMatchObject({ streamVersion: 2 });
  });

  /// המשתמש דיווח: "בהתחלה היו תוצאות, ואז התוצאות נעלמו והיה כתוב שאין
  /// תוצאות". זה היה עמוד ריק שנדחף למדור לפני הודעת השגיאה. ספרים שכבר
  /// נמצאו נשארים על המסך, והשגיאה מצטרפת אליהם.
  it('שגיאת v2 אחרי הגילוי אינה מוחקת מהמדור תוצאות שכבר נשלחו', async () => {
    const event = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
    const host = await bootController({
      methods: { 'reader.respondExternalSearch': async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return true;
      } },
      network: {
        '/health': () => ({ body: JSON.stringify({
          ok: true, service: 'hbsearch', apiVersion: 2,
          capabilities: ['pdf-range', 'search-stream-v2'],
        }) }),
        '/search': () => ({
          bodies: [
            event({ type: 'start', streamVersion: 2, streamId: 'a'.repeat(64) })
              + event({ type: 'provisional', result: JSON.parse(hebrewBooksRow({ fileId: '901' })) }),
            event({ type: 'error', message: 'dtSearch failed' }),
          ],
          bodyDelaysMs: [0, 20],
        }),
      },
    });
    host.emit('search.external.requested', externalRequest());
    await vi.waitFor(() => expect(responsesFor(host, 'xs-1').some((payload) =>
      payload.error === 'dtSearch failed')).toBe(true));
    const replies = responsesFor(host, 'xs-1');
    const discoveredAt = replies.findIndex((payload) => payload.done === false
      && resultsOf(payload)[0]?.externalId === 901);
    expect(discoveredAt).toBeGreaterThan(-1);
    // אחרי הגילוי לא נשלח שום עדכון ריק — רק הודעת השגיאה עצמה.
    expect(replies.slice(discoveredAt + 1).filter((payload) => payload.error === undefined)).toEqual([]);
    expect(replies.at(-1)).toEqual({ requestId: 'xs-1', error: 'dtSearch failed' });
  });

  it('שומר על בקשת המדור פעילה גם בהמתנה של עשר שניות בלי אף תוצאה', async () => {
    const event = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
    const host = await bootController({ network: {
      '/health': () => ({ body: JSON.stringify({
        ok: true, service: 'hbsearch', apiVersion: 2,
        capabilities: ['pdf-range', 'search-stream-v2'],
      }) }),
      '/search': () => ({
        bodies: [
          event({ type: 'start', streamVersion: 2, streamId: 'a'.repeat(64) }),
          event({ type: 'heartbeat' }),
          event({ type: 'reset', count: 0 }) + event({ type: 'complete', count: 0 }),
        ],
        bodyDelaysMs: [0, 10_000, 10],
      }),
    } });
    vi.useFakeTimers();
    try {
      host.emit('search.external.requested', externalRequest());
      await vi.advanceTimersByTimeAsync(0);
      expect(responsesFor(host, 'xs-1').filter((reply) => reply.done === false)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(responsesFor(host, 'xs-1').filter((reply) => reply.done === false)).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(responsesFor(host, 'xs-1').some((reply) => reply.done === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('משמר ספר זמני בחמש פעימות keepalive לאורך חמישים שניות', async () => {
    const event = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
    const host = await bootController({ network: {
      '/health': () => ({ body: JSON.stringify({
        ok: true, service: 'hbsearch', apiVersion: 2,
        capabilities: ['pdf-range', 'search-stream-v2'],
      }) }),
      '/search': () => ({
        bodies: [
          event({ type: 'start', streamVersion: 2, streamId: 'a'.repeat(64) }),
          event({ type: 'provisional', result: JSON.parse(hebrewBooksRow({ fileId: '901' })) }),
          ...Array.from({ length: 5 }, () => event({ type: 'heartbeat' })),
          event({ type: 'reset', count: 0 }) + event({ type: 'complete', count: 0 }),
        ],
        bodyDelaysMs: [0, 0, 10_000, 10_000, 10_000, 10_000, 10_000, 10],
      }),
    } });
    vi.useFakeTimers();
    try {
      host.emit('search.external.requested', externalRequest());
      await vi.advanceTimersByTimeAsync(0);
      const provisionalReplies = () => responsesFor(host, 'xs-1').filter((reply) =>
        reply.done === false && resultsOf(reply)[0]?.externalId === 901);
      expect(provisionalReplies()).toHaveLength(1);
      for (let heartbeat = 1; heartbeat <= 5; heartbeat += 1) {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(provisionalReplies()).toHaveLength(heartbeat + 1);
        expect(responsesFor(host, 'xs-1').some((reply) => reply.done === undefined)).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(10);
      expect(responsesFor(host, 'xs-1').some((reply) => reply.done === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('מגביל את גודל העמוד ל-50 ומנרמל offset שלילי', async () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      hebrewBooksRow({ fileId: String(index + 1), hitCount: 1, firstHitPage: undefined }),
    );
    const host = await bootController({
      network: { '/search': () => ({ body: hebrewBooksNdjson(rows) }) },
    });
    host.emit('search.external.requested', externalRequest({ limit: 999, offset: -5 }));
    const final = await finalResponse(host);
    expect(resultsOf(final)).toHaveLength(50);
    expect(final).toMatchObject({ totalBooks: 60, totalHits: 60, hasMore: true });
  });

  it('עמוד המשך (offset) מוגש מהמטמון, בלי אינדקס ובלי חיפוש נוסף', async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      hebrewBooksRow({ fileId: String(index + 1), bookName: `ספר ${index + 1}`, hitCount: 1, firstHitPage: undefined }),
    );
    const host = await bootController({
      network: { '/search': () => ({ body: hebrewBooksNdjson(rows) }) },
    });

    host.emit('search.external.requested', externalRequest({ limit: 2 }));
    const first = await finalResponse(host);
    expect(resultsOf(first).map((result) => result.externalId)).toEqual([1, 2]);
    expect(first).toMatchObject({ hasMore: true });
    // האינדקס מכיל את כלל התוצאות, לא רק את העמוד.
    expect(first.index).toHaveLength(5);

    const searchesBefore = searchRequests(host);
    host.emit('search.external.requested', externalRequest({ requestId: 'xs-2', limit: 2, offset: 4 }));
    const second = await finalResponse(host, 'xs-2');
    expect(resultsOf(second).map((result) => result.externalId)).toEqual([5]);
    expect(second).toMatchObject({ hasMore: false });
    expect(second.index).toBeUndefined();
    expect(searchRequests(host)).toBe(searchesBefore);
  });

  it('שורת המטא מורכבת ממחבר, מקום ושנה — ונשמטת כשאין נתונים', async () => {
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([
            hebrewBooksRow({ fileId: '10', firstHitPage: 3 }),
            hebrewBooksRow({
              fileId: '11',
              bookName: 'ספר בלי פרטים',
              authorName: undefined,
              printPlace: undefined,
              printYear: undefined,
              firstHitPage: 4,
            }),
          ]),
        }),
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(resultsOf(final)[0]).toMatchObject({
      meta: 'מחבר · ירושלים · תשס"ד',
      firstPage: 3,
      externalId: 10,
    });
    expect(resultsOf(final)[1]?.meta).toBeUndefined();
  });
});

describe('ספק התוצאות החיצוני — דפדוף לפי מזהים', () => {
  const rowsNetwork: MockHostConfig['network'] = {
    '/search': () => ({
      bodies: [
        `${hebrewBooksRow({ fileId: '101', bookName: 'ראשון', hitCount: 4, firstHitPage: undefined })}\n`,
        `${hebrewBooksRow({ fileId: '102', bookName: 'שני', hitCount: 6, firstHitPage: undefined })}\n`,
      ],
    }),
  };

  it('מחשב את העמוד מהמזהים שאוצריא ביקשה, בסדר שלה', async () => {
    const host = await bootController({ network: rowsNetwork });
    host.emit('search.external.requested', externalRequest());
    await finalResponse(host);

    const searchesBefore = searchRequests(host);
    host.emit('search.external.requested', externalRequest({ requestId: 'xs-2', ids: [102, 101] }));
    const page = await finalResponse(host, 'xs-2');
    expect(resultsOf(page).map((result) => result.externalId)).toEqual([102, 101]);
    expect(page).toMatchObject({ totalBooks: 2, totalHits: 10, hasMore: false });
    expect(searchRequests(host)).toBe(searchesBefore);
  });

  it('מזהה שאינו קיים בתוצאות נשמט מהעמוד', async () => {
    const host = await bootController({ network: rowsNetwork });
    host.emit('search.external.requested', externalRequest());
    await finalResponse(host);
    host.emit('search.external.requested', externalRequest({ requestId: 'xs-2', ids: [999, 101] }));
    const page = await finalResponse(host, 'xs-2');
    expect(resultsOf(page).map((result) => result.externalId)).toEqual([101]);
  });

  it('מטמון קר: החיפוש רץ שוב עם עדכוני "עוד חי" ריקים, ואז מוגש העמוד', async () => {
    const host = await bootController({ network: rowsNetwork });
    host.emit('search.external.requested', externalRequest({ ids: [101] }));
    const page = await finalResponse(host);

    const keepAlives = responsesFor(host, 'xs-1').filter(
      (payload) => payload.done === false && resultsOf(payload).length === 0,
    );
    expect(keepAlives.length).toBeGreaterThan(0);
    expect(keepAlives[0]).toMatchObject({ hasMore: false, done: false });
    expect(resultsOf(page).map((result) => result.externalId)).toEqual([101]);
  });

  it('רשימת מזהים לא תקינה מתעלמת ונופלת לעמוד רגיל', async () => {
    for (const [index, ids] of [
      Array.from({ length: 51 }, (_, position) => position + 1),
      [101, '102'],
      [101, 0],
      [101.5],
      [],
    ].entries()) {
      const host = await bootController({ network: rowsNetwork });
      const requestId = `bad-${index}`;
      host.emit('search.external.requested', externalRequest({ requestId, ids }));
      const final = await finalResponse(host, requestId);
      // עמוד רגיל: כלל התוצאות ואינדקס מלא (מסלול המזהים אינו שולח אינדקס).
      expect(resultsOf(final)).toHaveLength(2);
      expect(final.index).toHaveLength(2);
    }
  });
});

describe('ספק התוצאות החיצוני — אינדקס הקטגוריות', () => {
  const twoRows: MockHostConfig['network'] = {
    '/search': () => ({
      body: hebrewBooksNdjson([
        hebrewBooksRow({ fileId: '201', categories: 'גאונים|שו"ת', hitCount: 3, firstHitPage: undefined }),
        hebrewBooksRow({ fileId: '202', categories: 'ברכות|מסכת', hitCount: 5, firstHitPage: undefined }),
      ]),
    }),
  };

  it('נופל לסיווג מתגיות הקטלוג כשמיפוי ההשוואות נכשל', async () => {
    const host = await bootController({
      network: twoRows,
      methods: {
        'database.batchQuery': () => {
          throw new Error('אין מסד השוואה');
        },
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(final.index).toEqual([
      [201, 3, '/שו"ת'],
      [202, 5, '/תלמוד בבלי'],
    ]);
  });

  it('נופל לתגיות גם כשפתרון נתיבי הקטגוריות נכשל', async () => {
    const host = await bootController({
      network: twoRows,
      methods: {
        'database.batchQuery': () => ({ results: [{ rows: [{ hb_id: 201, otzaria_id: 900 }] }] }),
        'library.resolveCategoryPaths': () => {
          throw new Error('המארח אינו מכיר את הפעולה');
        },
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(final.index).toEqual([
      [201, 3, '/שו"ת'],
      [202, 5, '/תלמוד בבלי'],
    ]);
  });

  it('ספר ממופה שאין לו נתיב בספרייה שומר על הקטגוריה מהתגיות', async () => {
    const host = await bootController({
      network: twoRows,
      methods: {
        'database.batchQuery': () => ({ results: [{ rows: [{ hb_id: 201, otzaria_id: 900 }] }] }),
        'library.resolveCategoryPaths': () => [null],
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(final.index).toEqual([
      [201, 3, '/שו"ת'],
      [202, 5, '/תלמוד בבלי'],
    ]);
  });

  it('ספר בלי תגיות ובלי מיפוי נשלח בלי קטגוריה', async () => {
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([
            hebrewBooksRow({ fileId: '301', categories: undefined, hitCount: 2, firstHitPage: undefined }),
            hebrewBooksRow({ fileId: '302', categories: 'משהו לא מוכר', hitCount: 1, firstHitPage: undefined }),
          ]),
        }),
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(final.index).toEqual([
      [301, 2],
      [302, 1],
    ]);
  });

  it('האינדקס נשלח גם בעדכון הבסיס וגם בתשובה הסופית', async () => {
    const host = await bootController({
      network: twoRows,
      methods: {
        'database.batchQuery': () => ({ results: [{ rows: [{ hb_id: 201, otzaria_id: 900 }] }] }),
        'library.resolveCategoryPaths': () => ['/הלכה/שולחן ערוך'],
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    const withIndex = responsesFor(host, 'xs-1').filter((payload) => payload.index !== undefined);
    expect(withIndex.length).toBeGreaterThanOrEqual(2);
    expect(withIndex[0]).toMatchObject({ done: false });
    expect(final.index).toEqual([
      [201, 3, '/הלכה/שולחן ערוך'],
      [202, 5, '/תלמוד בבלי'],
    ]);
  });

  it('שם הספר נשלח כאיבר רביעי רק כשהמארח ביקש זאת', async () => {
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([
            hebrewBooksRow({
              fileId: '201',
              bookName: 'שו"ת מהרש"ם',
              categories: 'גאונים|שו"ת',
              hitCount: 3,
              firstHitPage: undefined,
            }),
            hebrewBooksRow({
              fileId: '202',
              bookName: 'ספר בלי סיווג',
              categories: undefined,
              hitCount: 1,
              firstHitPage: undefined,
            }),
          ]),
        }),
      },
    });

    host.emit('search.external.requested', externalRequest({ indexTitles: true }));
    const withTitles = await finalResponse(host);
    expect(withTitles.index).toEqual([
      [201, 3, '/שו"ת', 'שו"ת מהרש"ם'],
      // בלי סיווג הקטגוריה ריקה — השם עדיין מגיע.
      [202, 1, '', 'ספר בלי סיווג'],
    ]);

    // אותו חיפוש בלי הדגל: אותו מטמון אינו מגיש רשומות בנות ארבעה איברים.
    host.emit('search.external.requested', externalRequest({ requestId: 'xs-2' }));
    const withoutTitles = await finalResponse(host, 'xs-2');
    expect(withoutTitles.index).toEqual([
      [201, 3, '/שו"ת'],
      [202, 1],
    ]);
  });

  it('שם הספר נשמר גם כשמיפוי ההשוואות מדייק את הקטגוריה', async () => {
    const host = await bootController({
      network: twoRows,
      methods: {
        'database.batchQuery': () => ({ results: [{ rows: [{ hb_id: 201, otzaria_id: 900 }] }] }),
        'library.resolveCategoryPaths': () => ['/הלכה/שולחן ערוך'],
      },
    });
    host.emit('search.external.requested', externalRequest({ indexTitles: true }));
    const final = await finalResponse(host);
    expect(final.index).toEqual([
      [201, 3, '/הלכה/שולחן ערוך', 'קובץ שיטות קמאי'],
      [202, 5, '/תלמוד בבלי', 'קובץ שיטות קמאי'],
    ]);
  });

  it('מטמון האינדקס משוחרר אחרי שמונה חיפושים שונים', async () => {
    const host = await bootController({
      network: {
        '/search': (payload) => ({
          body: hebrewBooksNdjson([
            hebrewBooksRow({
              fileId: '201',
              hitCount: 3,
              firstHitPage: undefined,
              bookName: String(JSON.parse(String(payload.body)).q),
            }),
          ]),
        }),
      },
      methods: {
        'database.batchQuery': () => ({ results: [{ rows: [{ hb_id: 201, otzaria_id: 900 }] }] }),
        'library.resolveCategoryPaths': () => ['/הלכה'],
      },
    });

    for (let index = 0; index < 9; index += 1) {
      host.emit('search.external.requested', externalRequest({ requestId: `q-${index}`, query: `שאילתה ${index}` }));
      await finalResponse(host, `q-${index}`);
    }
    const mappingsAfterFirstRound = host.countOf('database.batchQuery');
    expect(mappingsAfterFirstRound).toBe(9);

    // שאילתה 1 עדיין במטמון, שאילתה 0 נדחקה ממנו.
    host.emit('search.external.requested', externalRequest({ requestId: 'again-1', query: 'שאילתה 1' }));
    await finalResponse(host, 'again-1');
    expect(host.countOf('database.batchQuery')).toBe(mappingsAfterFirstRound);

    host.emit('search.external.requested', externalRequest({ requestId: 'again-0', query: 'שאילתה 0' }));
    await finalResponse(host, 'again-0');
    expect(host.countOf('database.batchQuery')).toBe(mappingsAfterFirstRound + 1);
  });
});

describe('ספק התוצאות החיצוני — גזירי טקסט', () => {
  it('אינו שולח לאוצריא טקסט מעמוד שאין בו מונח חיפוש', async () => {
    pdf.text = 'פתיחה ארוכה של העמוד על נושא אחר בלי מונחי החיפוש';
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([hebrewBooksRow({ fileId: '400', firstHitPage: 7 })]),
        }),
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(pdf.opens).toEqual(['http://127.0.0.1:8080/pdf/400']);
    expect(resultsOf(final)[0]?.snippet).toBeUndefined();
  });

  it('מציג גזיר כשהשאילתה עם מקף והטקסט בעמוד מופרד ברווח', async () => {
    pdf.text = 'לפני ברכת המזון אחרי';
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([hebrewBooksRow({ fileId: '406', firstHitPage: 7 })]),
        }),
      },
    });
    host.emit('search.external.requested', externalRequest({ query: 'ברכת-המזון בזימון' }));
    const final = await finalResponse(host);
    expect(resultsOf(final)[0]?.snippet).toContain('ברכת המזון');
  });

  it('מאתר את עמוד ההתאמה בברירות המחדל של /inbook ומזרים את הגזיר', async () => {
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([hebrewBooksRow({ fileId: '401', firstHitPage: undefined })]),
        }),
        '/inbook': () => ({ body: JSON.stringify({ hitCount: 3, pages: [12, 40], matchedTerms: ['ברכת'] }) }),
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);

    expect(resultsOf(final)[0]?.snippet).toContain('ברכת המזון');
    expect(pdf.opens).toEqual(['http://127.0.0.1:8080/pdf/401']);

    const inBookBody = JSON.parse(
      String(
        host
          .payloadsOf('network.fetchStream')
          .find((payload) => String(payload?.url).endsWith('/inbook'))?.body,
      ),
    );
    // ברירות המחדל: proximity מלא ובלי דרישת סדר מילים — אחרת /inbook מחזיר 0 עמודים.
    expect(inBookBody).toMatchObject({ fileName: '401', proximity: 30, requireWordOrder: false });
  });

  it('עמוד התאמה שהתקבל מהשרת נחסך מקריאת /inbook', async () => {
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([hebrewBooksRow({ fileId: '402', firstHitPage: 7 })]),
        }),
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(resultsOf(final)[0]).toMatchObject({ firstPage: 7 });
    expect(resultsOf(final)[0]?.snippet).toContain('ברכת המזון');
    expect(
      host.payloadsOf('network.fetchStream').some((payload) => String(payload?.url).endsWith('/inbook')),
    ).toBe(false);
  });

  it('אירוע כפול עם אותו requestId מטופל פעם אחת בלבד', async () => {
    // אוצריא משגרת את האירוע שוב אם אין תגובה תוך 8 שניות (boot איטי);
    // טיפול כפול היה מריץ שני חיפושים מלאים ועונה done=true פעמיים.
    let searches = 0;
    const host = await bootController({
      network: {
        '/search': () => {
          searches += 1;
          return { body: hebrewBooksNdjson([hebrewBooksRow({ fileId: '405', firstHitPage: 7 })]) };
        },
      },
    });
    host.emit('search.external.requested', externalRequest());
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(resultsOf(final)[0]).toMatchObject({ externalId: 405 });
    expect(searches).toBe(1);
    const finals = responsesFor(host, 'xs-1').filter((response) => response.done === undefined);
    expect(finals).toHaveLength(1);
  });

  it('ספר שלא נמצא בו עמוד נשלח בלי גזיר', async () => {
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([hebrewBooksRow({ fileId: '403', firstHitPage: undefined })]),
        }),
        '/inbook': () => ({ body: JSON.stringify({ hitCount: 0, pages: [] }) }),
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(resultsOf(final)[0]?.snippet).toBeUndefined();
    expect(pdf.opens).toEqual([]);
  });

  it('תקרת הזמן מבטיחה תשובה סופית גם כשחילוץ הגזירים נתקע', async () => {
    pdf.blocked = true;
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([hebrewBooksRow({ fileId: '404', firstHitPage: 5 })]),
        }),
      },
    });
    vi.useFakeTimers();
    try {
      host.emit('search.external.requested', externalRequest());
      // ההזרמה מגיעה עד ההמתנה על תקרת הזמן, ורק אז מקדמים את השעון.
      await flushMicrotasks();
      // תקרת ההזרמה היא 25 שניות — מקדמים מעבר לה.
      await vi.advanceTimersByTimeAsync(30_000);
      const final = responsesFor(host, 'xs-1').at(-1) ?? {};
      // תשובה סופית נשלחת בלי השדה done, ונושאת את מה שהספיק להיטען.
      expect(final.done).toBeUndefined();
      expect(final).toMatchObject({ totalBooks: 1, totalHits: 7 });
      expect(resultsOf(final)[0]?.snippet).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('אחרי תקרת הזמן אינו מתחיל איתור עמוד או חילוץ PDF לפריטים נוספים בתור', async () => {
    let releaseInBook!: () => void;
    const inBookGate = new Promise<void>((resolve) => { releaseInBook = resolve; });
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson(
            Array.from({ length: 6 }, (_, index) =>
              hebrewBooksRow({ fileId: String(500 + index), firstHitPage: undefined }),
            ),
          ),
        }),
        '/inbook': async () => {
          await inBookGate;
          return { body: JSON.stringify({ hitCount: 1, pages: [7] }) };
        },
      },
    });
    vi.useFakeTimers();
    try {
      host.emit('search.external.requested', externalRequest());
      await flushMicrotasks();
      const inBookCalls = () => host.payloadsOf('network.fetchStream')
        .filter((payload) => String(payload?.url).endsWith('/inbook')).length;
      expect(inBookCalls()).toBe(2);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(responsesFor(host, 'xs-1').some((payload) => payload.done === undefined)).toBe(true);
      releaseInBook();
      await flushMicrotasks();
      expect(inBookCalls()).toBe(2);
      expect(pdf.opens).toEqual([]);
    } finally {
      releaseInBook();
      vi.useRealTimers();
    }
  });

  it('בקשה שהוחלפה מתבטלת מיד בלי תגובה סופית ישנה או חילוץ PDF כשה-/inbook חוזר', async () => {
    let releaseInBook!: () => void;
    const inBookGate = new Promise<void>((resolve) => { releaseInBook = resolve; });
    const host = await bootController({
      network: {
        '/search': (payload) => ({
          body: hebrewBooksNdjson(
            String(payload.body).includes('שאילתה חדשה')
              ? []
              : Array.from({ length: 5 }, (_, index) =>
                hebrewBooksRow({ fileId: String(600 + index), firstHitPage: undefined }),
              ),
          ),
        }),
        '/inbook': async () => {
          await inBookGate;
          return { body: JSON.stringify({ hitCount: 1, pages: [7] }) };
        },
      },
    });
    vi.useFakeTimers();
    try {
      host.emit('search.external.requested', externalRequest());
      await flushMicrotasks();
      expect(host.payloadsOf('network.fetchStream').filter(
        (payload) => String(payload?.url).endsWith('/inbook'),
      )).toHaveLength(2);

      host.emit('search.external.requested', externalRequest({ requestId: 'xs-2', query: 'שאילתה חדשה' }));
      await flushMicrotasks();
      expect(responsesFor(host, 'xs-1').some((payload) => payload.done === undefined)).toBe(false);
      expect(responsesFor(host, 'xs-2').some((payload) => payload.done === undefined)).toBe(true);
      releaseInBook();
      await flushMicrotasks();
      expect(pdf.opens).toEqual([]);
      expect(host.payloadsOf('network.fetchStream').filter(
        (payload) => String(payload?.url).endsWith('/inbook'),
      )).toHaveLength(2);
    } finally {
      releaseInBook();
      vi.useRealTimers();
    }
  });

  it('גזיר שהושלם נשלח כעדכון חלקי לפני התשובה הסופית בזמן שגזיר אחר ממתין', async () => {
    let releaseInBook!: () => void;
    const inBookGate = new Promise<void>((resolve) => { releaseInBook = resolve; });
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([
            hebrewBooksRow({ fileId: '700', firstHitPage: 7 }),
            hebrewBooksRow({ fileId: '701', firstHitPage: undefined }),
          ]),
        }),
        '/inbook': async () => {
          await inBookGate;
          return { body: JSON.stringify({ hitCount: 1, pages: [7] }) };
        },
      },
    });
    vi.useFakeTimers();
    try {
      host.emit('search.external.requested', externalRequest());
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(500);
      const responses = responsesFor(host, 'xs-1');
      expect(responses.some((payload) =>
        payload.done === false && resultsOf(payload)[0]?.snippet !== undefined,
      )).toBe(true);
      expect(responses.some((payload) => payload.done === undefined)).toBe(false);
      releaseInBook();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(responsesFor(host, 'xs-1').at(-1)?.done).toBeUndefined();
    } finally {
      releaseInBook();
      vi.useRealTimers();
    }
  });
});
