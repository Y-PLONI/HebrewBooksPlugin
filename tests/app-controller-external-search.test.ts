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
      await vi.advanceTimersByTimeAsync(20_000);
      const final = responsesFor(host, 'xs-1').at(-1) ?? {};
      // תשובה סופית נשלחת בלי השדה done, ונושאת את מה שהספיק להיטען.
      expect(final.done).toBeUndefined();
      expect(final).toMatchObject({ totalBooks: 1, totalHits: 7 });
      expect(resultsOf(final)[0]?.snippet).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
