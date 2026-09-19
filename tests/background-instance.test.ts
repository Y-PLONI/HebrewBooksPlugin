/// מופע הרקע (contributes.background.entrypoint). כשהוא קיים, אוצריא משגרת
/// אליו לבדו את אירועי החיפוש הממוקדים (preferBackground), ולכן הוא שחייב
/// לענות עליהם. הקובץ רץ בסביבת node בכוונה: אין כאן DOM כלל, וכל נגיעה
/// במסך, ב-styles.css או ב-pdf.js הייתה מפילה אותו.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootPayload,
  createMockHost,
  hebrewBooksNdjson,
  hebrewBooksRow,
  type MockHost,
  type MockHostConfig,
} from './helpers/mock-host';

const service: MockHostConfig['network'] = {
  '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow()]) }),
  '/inbook': () => ({
    body: JSON.stringify({ hitCount: 4, pages: [9, 2], matchedTerms: ['ברכת', 'המזון'] }),
  }),
};

async function startBackgroundInstance(config: MockHostConfig = {}): Promise<MockHost> {
  const host = createMockHost(config);
  (globalThis as { window?: unknown }).window = { Otzaria: host.bridge };
  vi.resetModules();
  await import('../src/background');
  host.emit('plugin.boot', bootPayload());
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

/// התשובה הסופית למדור החיצוני — זו שאין עליה `done: false`.
async function finalExternalResponse(host: MockHost): Promise<Record<string, unknown>> {
  await vi.waitFor(() =>
    expect(
      host.payloadsOf('reader.respondExternalSearch').some((payload) => payload?.done === undefined),
    ).toBe(true),
  );
  const final = host.payloadsOf('reader.respondExternalSearch').at(-1);
  if (!final) throw new Error('לא נשלחה תשובה סופית');
  return final;
}

function pathCount(host: MockHost, path: string): number {
  return host.payloadsOf('network.fetchStream').filter((payload) => String(payload?.url).endsWith(path))
    .length;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('מופע הרקע של התוסף', () => {
  it('רושם את שני ספקי החיפוש, ואינו עושה דבר מלבד זאת', async () => {
    const host = await startBackgroundInstance();

    await vi.waitFor(() => expect(host.countOf('reader.registerExternalSearchProvider')).toBe(1));
    expect(host.countOf('reader.registerInBookSearchProvider')).toBe(1);
    // בדיקת /health, ערכת הנושא ובניית המסכים הן עבודת הלשונית הנראית בלבד.
    expect(host.countOf('network.fetchStream')).toBe(0);
    expect(host.hasListener('theme.changed')).toBe(false);
    expect(typeof document).toBe('undefined');
  });

  it('מגיש בקשת חיפוש חיצוני עד לתשובה סופית עם אינדקס', async () => {
    const host = await startBackgroundInstance({ network: service });

    host.emit('search.external.requested', externalRequest());
    const final = await finalExternalResponse(host);

    expect(final).toMatchObject({ requestId: 'xs-1', totalBooks: 1, hasMore: false });
    expect(final.results).toEqual([
      expect.objectContaining({ title: 'קובץ שיטות קמאי', hitCount: 7, externalId: 43558 }),
    ]);
    expect(final.index).toEqual([[43558, 7, expect.any(String)]]);
  });

  it('אינו מאתר עמודים לגזירי טקסט שאין לו במה לחלץ', async () => {
    const host = await startBackgroundInstance({ network: service });

    host.emit('search.external.requested', externalRequest());
    const final = await finalExternalResponse(host);

    // בלי pdf.js אין גזיר, ולכן גם אין קריאת /inbook שכל תכליתה לאתר עמוד עבורו.
    expect((final.results as Array<Record<string, unknown>>)[0]).not.toHaveProperty('snippet');
    expect(pathCount(host, '/inbook')).toBe(0);
    expect(pathCount(host, '/search')).toBe(1);
  });

  it('עונה לקורא על חיפוש בתוך ספר', async () => {
    const host = await startBackgroundInstance({ network: service });

    host.emit('reader.inBookSearch.requested', {
      requestId: 'ib-1',
      provider: 'hebrewbooks',
      externalId: 43558,
      query: 'ברכת המזון',
    });

    await vi.waitFor(() => expect(host.countOf('reader.respondInBookSearch')).toBe(1));
    expect(host.lastPayload('reader.respondInBookSearch')).toMatchObject({
      requestId: 'ib-1',
      query: 'ברכת המזון',
      matchedTerms: ['ברכת', 'המזון'],
    });
    expect(pathCount(host, '/inbook')).toBe(1);
  });
});
