/// מופע הרקע (contributes.background.entrypoint). כשהוא חי, אוצריא משגרת
/// אליו את אירועי החיפוש הממוקדים (preferBackground), ולכן הוא שחייב לענות
/// עליהם. הקובץ רץ בסביבת node בכוונה: אין כאן DOM כלל, וכל נגיעה במסך,
/// ב-styles.css או ב-pdf.js באתחול הייתה מפילה אותו.

import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/// כל בקשה כאן מנסה לטעון את חבילת הגזירים ונכשלת — ראו המבחן השלישי.
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
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

  it('אינו מושך מסכים ואת pdf.js לחבילה שהוא עולה עליה', async () => {
    // גרף הייבוא ולא היעדר ה-DOM: מסך נטען בלי לגעת ב-document בזמן הייבוא,
    // ולכן הסביבה כאן לבדה לא הייתה מרגישה בו — רק החבילה שנבנית מעידה.
    const bundle = await build({
      entryPoints: ['src/background.ts'],
      bundle: true,
      write: false,
      metafile: true,
      format: 'iife',
      platform: 'browser',
      logLevel: 'silent',
    });

    const graph = Object.keys(bundle.metafile.inputs);
    expect(graph.filter((file) => /src\/screens\/|src\/viewer\/|pdfjs-dist/.test(file))).toEqual([]);
    expect(graph).toContain('src/services/lazy-snippet-source.ts');
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

  it('עונה בלי גזירים כשחבילת הגזירים אינה ניתנת לטעינה', async () => {
    // אין כאן document, ולכן הזרקת <script> של assets/snippets.js נכשלת —
    // בדיוק כמו התקנה פגומה שבה הקובץ חסר.
    const host = await startBackgroundInstance({ network: service });

    host.emit('search.external.requested', externalRequest());
    const final = await finalExternalResponse(host);

    expect((final.results as Array<Record<string, unknown>>)[0]).not.toHaveProperty('snippet');
    // בלי מחלץ אין טעם לאתר עמודים: /inbook כאן היה בקשת רשת לשווא בלבד.
    expect(pathCount(host, '/inbook')).toBe(0);
    expect(pathCount(host, '/search')).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
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
