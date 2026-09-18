// @vitest-environment jsdom

/// ספר מהמאגר האישי מגיע משרת ישן עם נתיב יחסי בעברית ב-fileId. Number()
/// עליו הוא NaN, שנשלח לאוצריא כ-null ומרעיל את אינדקס הקטגוריות של כל
/// התוצאות. רשומה כזו חייבת ליפול, לא להישלח.

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
type MockHostConfig = import('./helpers/mock-host').MockHostConfig;

/// נתיב יחסי אמיתי מתוך Personal_IDX\hb-manifest.json, כפי ש-ToDto שולח אותו היום.
const personalPath = "אא רמב''ם פרנקל\\א מדע מטופל.pdf";

async function bootController(config: MockHostConfig = {}): Promise<MockHost> {
  const host = createMockHost(config);
  const controller = new AppController(host.bridge, document.createElement('div'));
  await controller.boot(bootPayload());
  await Promise.resolve();
  return host;
}

function responsesFor(host: MockHost, requestId: string): Array<Record<string, unknown>> {
  return host
    .payloadsOf('reader.respondExternalSearch')
    .filter((payload): payload is Record<string, unknown> => payload?.requestId === requestId);
}

async function finalResponse(host: MockHost, requestId = 'xs-1'): Promise<Record<string, unknown>> {
  await vi.waitFor(
    () =>
      expect(responsesFor(host, requestId).some((payload) => payload.done === undefined)).toBe(true),
    { timeout: 5_000 },
  );
  const final = responsesFor(host, requestId).at(-1);
  if (!final) throw new Error('לא נשלחה תשובה סופית');
  return final;
}

/// שורה רגילה של היברובוקס ולצידה שורת מאגר אישי עם נתיב יחסי במקום מזהה.
const mixedRows: MockHostConfig['network'] = {
  '/search': () => ({
    body: hebrewBooksNdjson([
      hebrewBooksRow({ fileId: '201', categories: 'גאונים|שו"ת', hitCount: 3, firstHitPage: undefined }),
      hebrewBooksRow({
        fileId: personalPath,
        bookName: 'משנה תורה מדע',
        sourceType: 'Personal',
        categories: 'מאגר אישי',
        hitCount: 9,
        firstHitPage: undefined,
      }),
    ]),
  }),
};

function externalRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'xs-1',
    provider: 'hebrewbooks',
    query: 'משנה תורה',
    mode: 'exact',
    distance: 2,
    offset: 0,
    limit: 20,
    ...overrides,
  };
}

describe('אינדקס המדור החיצוני מול מזהה שאינו מספר', () => {
  it('שורת מאגר אישי עם נתיב יחסי אינה נכנסת לאינדקס', async () => {
    const host = await bootController({ network: mixedRows });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(final.index).toEqual([[201, 3, '/שו"ת']]);
  });

  it('אין null ואין NaN בשום רשומת אינדקס', async () => {
    const host = await bootController({ network: mixedRows });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    const index = final.index as Array<Array<unknown>>;
    expect(JSON.stringify(index)).not.toContain('null');
    for (const entry of index) {
      expect(typeof entry[0]).toBe('number');
      expect(Number.isFinite(entry[0] as number)).toBe(true);
    }
  });

  it('נופלת גם כשהמארח מבקש שמות ספרים באינדקס', async () => {
    const host = await bootController({ network: mixedRows });
    host.emit('search.external.requested', externalRequest({ indexTitles: true }));
    const final = await finalResponse(host);
    expect(final.index).toEqual([[201, 3, '/שו"ת', 'קובץ שיטות קמאי']]);
  });

  it('מזהה אישי מספרי מהשרת המתוקן עובר כמות שהוא', async () => {
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([
            hebrewBooksRow({
              fileId: '1000000000001',
              bookName: 'משנה תורה מדע',
              sourceType: 'Personal',
              categories: 'מאגר אישי',
              hitCount: 9,
              firstHitPage: undefined,
            }),
          ]),
        }),
      },
    });
    host.emit('search.external.requested', externalRequest());
    const final = await finalResponse(host);
    expect(final.index).toEqual([[1_000_000_000_001, 9]]);
  });
});
