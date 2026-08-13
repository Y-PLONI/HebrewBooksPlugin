// @vitest-environment jsdom

/// הקורא המובנה של אוצריא מאציל לתוסף חיפוש-בתוך-ספר לספרי היברובוקס.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({ opens: [] as string[] }));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (options: { url: string }) => {
    pdf.opens.push(options.url);
    return {
      promise: Promise.resolve({
        numPages: 20,
        getPage: () =>
          Promise.resolve({
            getTextContent: () => Promise.resolve({ items: [{ str: 'ברכת המזון בשלוש' }] }),
          }),
        destroy: () => Promise.resolve(),
      }),
    };
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

function inBookRequests(host: MockHost): Array<Record<string, unknown>> {
  return host
    .payloadsOf('network.fetchStream')
    .filter((payload) => String(payload?.url).endsWith('/inbook'))
    .map((payload) => JSON.parse(String(payload?.body)) as Record<string, unknown>);
}

async function inBookAnswer(host: MockHost, requestId = 'ib-1'): Promise<Record<string, unknown>> {
  await vi.waitFor(() =>
    expect(
      host
        .payloadsOf('reader.respondInBookSearch')
        .some((payload) => payload?.requestId === requestId),
    ).toBe(true),
  );
  const answer = host
    .payloadsOf('reader.respondInBookSearch')
    .filter((payload) => payload?.requestId === requestId)
    .at(-1);
  if (!answer) throw new Error('לא נשלחה תשובה');
  return answer;
}

const locatedPages: MockHostConfig['network'] = {
  '/inbook': () => ({
    body: JSON.stringify({ hitCount: 4, pages: [9, 2, 2], matchedTerms: ['ברכת', 'המזון'] }),
  }),
};

beforeEach(() => {
  pdf.opens.length = 0;
});

describe('ספק חיפוש-בתוך-ספר', () => {
  it('נרשם אצל המארח בעת ה-boot', async () => {
    const host = await bootController();
    expect(host.lastPayload('reader.registerInBookSearchProvider')).toEqual({
      provider: 'hebrewbooks',
    });
    expect(host.hasListener('reader.inBookSearch.requested')).toBe(true);
  });

  it('מחזיר את עמודי ההתאמה, המונחים והשאילתה', async () => {
    const host = await bootController({ network: locatedPages });
    host.emit('reader.inBookSearch.requested', {
      requestId: 'ib-1',
      provider: 'hebrewbooks',
      externalId: 43558,
      query: '  ברכת המזון  ',
    });
    await expect(inBookAnswer(host)).resolves.toEqual({
      requestId: 'ib-1',
      pages: [2, 9],
      matchedTerms: ['ברכת', 'המזון'],
      query: 'ברכת המזון',
    });
  });

  it('מאתר בברירות המחדל של השירות ולא באפשרויות חיפוש הדוקות', async () => {
    const host = await bootController({ network: locatedPages });
    host.emit('reader.inBookSearch.requested', {
      requestId: 'ib-1',
      provider: 'hebrewbooks',
      externalId: '43558',
      query: 'ברכת המזון',
    });
    await inBookAnswer(host);
    expect(inBookRequests(host)[0]).toMatchObject({
      fileName: '43558',
      q: 'ברכת המזון',
      proximity: 30,
      fuzziness: 0,
      requireWordOrder: false,
      rashiOcr: false,
    });
  });

  it('בקשה בלי requestId אינה נענית', async () => {
    const host = await bootController({ network: locatedPages });
    host.emit('reader.inBookSearch.requested', {
      provider: 'hebrewbooks',
      externalId: 43558,
      query: 'ברכת',
    });
    await Promise.resolve();
    expect(host.countOf('reader.respondInBookSearch')).toBe(0);
  });

  it('מזהה ספר שאינו מספרי נדחה בלי לפנות לשירות', async () => {
    const host = await bootController({ network: locatedPages });
    host.emit('reader.inBookSearch.requested', {
      requestId: 'ib-1',
      provider: 'hebrewbooks',
      externalId: '../etc/passwd',
      query: 'ברכת',
    });
    await expect(inBookAnswer(host)).resolves.toEqual({
      requestId: 'ib-1',
      error: 'בקשת חיפוש בספר אינה תקינה',
    });
    expect(inBookRequests(host)).toHaveLength(0);
  });

  it('שאילתה ריקה או ארוכה מדי נדחית', async () => {
    const host = await bootController({ network: locatedPages });
    host.emit('reader.inBookSearch.requested', {
      requestId: 'ib-empty',
      provider: 'hebrewbooks',
      externalId: 1,
      query: '   ',
    });
    host.emit('reader.inBookSearch.requested', {
      requestId: 'ib-long',
      provider: 'hebrewbooks',
      externalId: 1,
      query: 'א'.repeat(501),
    });
    await expect(inBookAnswer(host, 'ib-empty')).resolves.toMatchObject({
      error: 'בקשת חיפוש בספר אינה תקינה',
    });
    await expect(inBookAnswer(host, 'ib-long')).resolves.toMatchObject({
      error: 'בקשת חיפוש בספר אינה תקינה',
    });
    expect(inBookRequests(host)).toHaveLength(0);
  });

  it('כשל בשירות מוחזר כשגיאה לקורא', async () => {
    const host = await bootController({
      network: {
        '/inbook': () => ({ status: 500, ok: false, body: JSON.stringify({ error: 'האינדקס נעול' }) }),
      },
    });
    host.emit('reader.inBookSearch.requested', {
      requestId: 'ib-1',
      provider: 'hebrewbooks',
      externalId: 1,
      query: 'ברכת',
    });
    await expect(inBookAnswer(host)).resolves.toEqual({
      requestId: 'ib-1',
      error: 'האינדקס נעול',
    });
  });

  it('בקשה חוזרת לאותו ספר ושאילתה נענית מהמטמון', async () => {
    const host = await bootController({ network: locatedPages });
    for (const requestId of ['ib-1', 'ib-2']) {
      host.emit('reader.inBookSearch.requested', {
        requestId,
        provider: 'hebrewbooks',
        externalId: 43558,
        query: 'ברכת המזון',
      });
      await inBookAnswer(host, requestId);
    }
    expect(inBookRequests(host)).toHaveLength(1);

    // שאילתה אחרת היא מפתח מטמון אחר.
    host.emit('reader.inBookSearch.requested', {
      requestId: 'ib-3',
      provider: 'hebrewbooks',
      externalId: 43558,
      query: 'שאילתה אחרת',
    });
    await inBookAnswer(host, 'ib-3');
    expect(inBookRequests(host)).toHaveLength(2);
  });

  it('בקשה שנכשלה אינה נשמרת במטמון ומנסה שוב', async () => {
    let attempt = 0;
    const host = await bootController({
      network: {
        '/inbook': () => {
          attempt += 1;
          return attempt === 1
            ? { status: 503, ok: false, body: 'unavailable' }
            : { body: JSON.stringify({ hitCount: 1, pages: [4], matchedTerms: ['ברכת'] }) };
        },
      },
    });
    const request = (requestId: string): void =>
      host.emit('reader.inBookSearch.requested', {
        requestId,
        provider: 'hebrewbooks',
        externalId: 43558,
        query: 'ברכת המזון',
      });

    request('ib-1');
    await expect(inBookAnswer(host, 'ib-1')).resolves.toMatchObject({
      error: 'לא ניתן היה לאתר עמודים בספר (HTTP 503)',
    });
    request('ib-2');
    await expect(inBookAnswer(host, 'ib-2')).resolves.toMatchObject({ pages: [4] });
    expect(inBookRequests(host)).toHaveLength(2);
  });

  it('עמוד שאותר בשלב גזירי הטקסט נענה מיידית לקורא, בלי פנייה נוספת', async () => {
    const host = await bootController({
      network: {
        '/search': () => ({
          body: hebrewBooksNdjson([hebrewBooksRow({ fileId: '43558', firstHitPage: undefined })]),
        }),
        ...locatedPages,
      },
    });

    host.emit('search.external.requested', {
      requestId: 'xs-1',
      provider: 'hebrewbooks',
      query: 'ברכת המזון',
      mode: 'exact',
      offset: 0,
      limit: 20,
    });
    await vi.waitFor(
      () =>
        expect(
          host
            .payloadsOf('reader.respondExternalSearch')
            .some((payload) => payload?.requestId === 'xs-1' && payload?.done === undefined),
        ).toBe(true),
      { timeout: 5_000 },
    );
    expect(inBookRequests(host)).toHaveLength(1);

    host.emit('reader.inBookSearch.requested', {
      requestId: 'ib-1',
      provider: 'hebrewbooks',
      externalId: 43558,
      query: 'ברכת המזון',
    });
    await expect(inBookAnswer(host)).resolves.toMatchObject({ pages: [2, 9] });
    expect(inBookRequests(host)).toHaveLength(1);
  });
});
