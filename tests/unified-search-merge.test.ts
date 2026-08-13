import { describe, expect, it, vi } from 'vitest';
import type {
  HebrewBooksResult,
  HebrewBooksSearchPage,
  HostBookIdentity,
  HostSearchRequest,
  OtzariaSearchChunk,
  OtzariaSearchHit,
  ResolvedBook,
  UnifiedSearchCursor,
  UnifiedSearchResponse,
  UnifiedSearchResult,
} from '../src/models';
import {
  mergeUnifiedSearchResponses,
  toHebrewBooksSnapshot,
  UnifiedSearchService,
} from '../src/services/unified-search-service';

function hebrewBooksHit(fileId: string, hitCount = 1): HebrewBooksResult {
  return {
    fileId,
    bookName: `ספר ${fileId}`,
    authorName: null,
    printPlace: null,
    printYear: null,
    countPage: null,
    categories: null,
    sourceType: 'PDF',
    relativePath: null,
    hitCount,
    firstHitPage: null,
  };
}

function hebrewBooksResult(fileId: string, categoryPath = 'ספרי היברובוקס'): UnifiedSearchResult {
  return { source: 'hebrewbooks', categoryPath, hit: hebrewBooksHit(fileId) };
}

function otzariaHit(index: number, reference = 'סימן א'): OtzariaSearchHit {
  return {
    id: 7,
    bookId: 'shulchan-aruch',
    book: 'שולחן ערוך',
    categoryPath: '/הלכה',
    reference,
    text: 'טקסט',
    index,
    mergedCount: 1,
  };
}

function otzariaResult(index: number, reference = 'סימן א'): UnifiedSearchResult {
  return { source: 'otzaria', categoryPath: '/הלכה', hit: otzariaHit(index, reference) };
}

function unifiedResponse(overrides: Partial<UnifiedSearchResponse> = {}): UnifiedSearchResponse {
  return {
    results: [],
    otzariaTotal: 0,
    hebrewBooksTotal: 0,
    truncated: false,
    warnings: [],
    nextCursor: null,
    ...overrides,
  };
}

describe('mergeUnifiedSearchResponses', () => {
  it('מוסיף את העמוד החדש בסוף ומסלק כפילויות', () => {
    const current = unifiedResponse({
      results: [otzariaResult(1), hebrewBooksResult('10')],
      otzariaTotal: 5,
      hebrewBooksTotal: 3,
    });
    const page = unifiedResponse({
      results: [otzariaResult(1), otzariaResult(2), hebrewBooksResult('10'), hebrewBooksResult('11')],
      otzariaTotal: 5,
      hebrewBooksTotal: 4,
    });

    const merged = mergeUnifiedSearchResponses(current, page);
    expect(merged.results).toHaveLength(4);
    expect(merged.results.map((result) => (result.source === 'otzaria' ? `o${result.hit.index}` : `h${result.hit.fileId}`))).toEqual([
      'o1',
      'h10',
      'o2',
      'h11',
    ]);
  });

  it('אותו ספר אוצריא במיקום אחר או בהפניה אחרת אינו כפילות', () => {
    const merged = mergeUnifiedSearchResponses(
      unifiedResponse({ results: [otzariaResult(1, 'סימן א')] }),
      unifiedResponse({ results: [otzariaResult(1, 'סימן ב'), otzariaResult(2, 'סימן א')] }),
    );
    expect(merged.results).toHaveLength(3);
  });

  it('הספירות הן המקסימום, האזהרות מתאחדות והסמן מגיע מהעמוד החדש', () => {
    const cursor: UnifiedSearchCursor = {
      otzariaOffset: 2,
      hebrewBooksOffset: 2,
      otzariaComplete: false,
      hebrewBooksComplete: true,
    };
    const merged = mergeUnifiedSearchResponses(
      unifiedResponse({ otzariaTotal: 9, hebrewBooksTotal: 2, warnings: ['אזהרה א'], truncated: true }),
      unifiedResponse({
        otzariaTotal: 4,
        hebrewBooksTotal: 8,
        warnings: ['אזהרה א', 'אזהרה ב'],
        truncated: false,
        totalIsLowerBound: true,
        nextCursor: cursor,
      }),
    );

    expect(merged.otzariaTotal).toBe(9);
    expect(merged.hebrewBooksTotal).toBe(8);
    expect(merged.warnings).toEqual(['אזהרה א', 'אזהרה ב']);
    expect(merged.truncated).toBe(false);
    expect(merged.totalIsLowerBound).toBe(true);
    expect(merged.nextCursor).toBe(cursor);
  });
});

describe('toHebrewBooksSnapshot', () => {
  it('חותך רווחים ומייצר חתימה יציבה לאותה בקשה', () => {
    const first = toHebrewBooksSnapshot({ query: '  ברכת המזון  ', mode: 'exact', distance: 3 });
    const second = toHebrewBooksSnapshot({ query: 'ברכת המזון', mode: 'exact', distance: 3 });
    expect(first.query).toBe('ברכת המזון');
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('שינוי במרחק או במצב משנה את החתימה', () => {
    const base = toHebrewBooksSnapshot({ query: 'ברכה', mode: 'exact', distance: 3 });
    expect(toHebrewBooksSnapshot({ query: 'ברכה', mode: 'exact', distance: 4 }).fingerprint).not.toBe(
      base.fingerprint,
    );
    expect(toHebrewBooksSnapshot({ query: 'ברכה', mode: 'fuzzy', distance: 3 }).fingerprint).not.toBe(
      base.fingerprint,
    );
  });

  it('גודל עמוד נחסם לטווח 1–500', () => {
    expect(toHebrewBooksSnapshot({ query: 'א', limit: 0 }).options.limit).toBe(1);
    expect(toHebrewBooksSnapshot({ query: 'א', limit: 5_000 }).options.limit).toBe(500);
    expect(toHebrewBooksSnapshot({ query: 'א' }).options.limit).toBe(100);
  });

  it('חיפוש מקורב מוגבל לשתי רמות, ומצב אחר מאפס את הקירוב', () => {
    expect(toHebrewBooksSnapshot({ query: 'א', mode: 'fuzzy', distance: 9 }).options.fuzziness).toBe(2);
    expect(toHebrewBooksSnapshot({ query: 'א', mode: 'fuzzy' }).options.fuzziness).toBe(2);
    expect(toHebrewBooksSnapshot({ query: 'א', mode: 'fuzzy', distance: 1 }).options.fuzziness).toBe(1);
    expect(toHebrewBooksSnapshot({ query: 'א', mode: 'advanced', distance: 2 }).options.fuzziness).toBe(0);
  });

  it('תקרת התוצאות שנאספות היא 10,000 ספרים', () => {
    expect(toHebrewBooksSnapshot({ query: 'א' }).options.max).toBe(10_000);
  });
});

/// מקורות מדומים לשירות המאוחד.
function sources(options: {
  otzariaChunks?: OtzariaSearchChunk[];
  otzariaError?: Error;
  hebrewBooksPage?: HebrewBooksSearchPage;
  hebrewBooksError?: Error;
  mapping?: Map<string, number>;
  books?: Array<ResolvedBook | null>;
  mappingError?: Error;
}) {
  const resolveBooks = vi.fn(async (identities: HostBookIdentity[]) =>
    options.books ?? identities.map(() => null),
  );
  const hebrewBooks = {
    search: vi.fn(async () => {
      if (options.hebrewBooksError) throw options.hebrewBooksError;
      return options.hebrewBooksPage ?? { results: [], totalBooks: 0, totalHits: 0, truncated: false };
    }),
  };
  const otzaria = {
    search: vi.fn(async function* (): AsyncIterable<OtzariaSearchChunk> {
      if (options.otzariaError) throw options.otzariaError;
      for (const chunk of options.otzariaChunks ?? []) yield chunk;
    }),
    resolveBooks,
  };
  const catalog = {
    findBestOtzariaIds: vi.fn(async () => {
      if (options.mappingError) throw options.mappingError;
      return options.mapping ?? new Map<string, number>();
    }),
  };
  return {
    service: new UnifiedSearchService(hebrewBooks, otzaria, catalog),
    hebrewBooks,
    otzaria,
    catalog,
    resolveBooks,
  };
}

function otzariaChunk(overrides: Partial<OtzariaSearchChunk> = {}): OtzariaSearchChunk {
  return {
    sequence: 0,
    results: [],
    total: 0,
    groupCount: null,
    truncated: false,
    limit: 100,
    offset: 0,
    facets: [],
    ...overrides,
  };
}

const baseRequest: HostSearchRequest = { query: 'ברכת המזון', mode: 'exact' };

describe('UnifiedSearchService — קטגוריות וסמן ההמשך', () => {
  it('מנרמל נתיב קטגוריה של אוצריא ונופל לקטגוריית ברירת מחדל', async () => {
    const { service } = sources({
      otzariaChunks: [
        otzariaChunk({
          total: 2,
          results: [
            { ...otzariaHit(1), categoryPath: 'תנך/תורה/' },
            { ...otzariaHit(2), categoryPath: null },
          ],
        }),
      ],
    });
    const response = await service.search(baseRequest);
    expect(response.results.map((result) => result.categoryPath)).toEqual([
      '/תנך/תורה',
      'ספרי אוצריא',
    ]);
  });

  it('ספר היברובוקס שהושווה מקבל את קטגוריית מהדורת אוצריא', async () => {
    const { service, resolveBooks } = sources({
      hebrewBooksPage: { results: [hebrewBooksHit('10')], totalBooks: 1, totalHits: 1, truncated: false },
      mapping: new Map([['10', 501]]),
      books: [{ id: 501, title: 'מהדורת אוצריא', categoryPath: '/הלכה/שולחן ערוך' }],
    });
    const response = await service.search(baseRequest);
    expect(response.results[0]?.categoryPath).toBe('/הלכה/שולחן ערוך');
    expect(resolveBooks).toHaveBeenCalledWith([{ id: 501, source: 'library' }]);
  });

  it('סמן ההמשך מתאפס כששני המנועים מיצו את התוצאות', async () => {
    const { service } = sources({
      otzariaChunks: [otzariaChunk({ total: 1, results: [otzariaHit(1)] })],
      hebrewBooksPage: { results: [hebrewBooksHit('10')], totalBooks: 1, totalHits: 1, truncated: false },
    });
    const response = await service.search(baseRequest);
    expect(response.nextCursor).toBeNull();
    expect(response.truncated).toBe(false);
  });

  it('groupCount גובר על total בקביעת סיום צד אוצריא', async () => {
    const { service } = sources({
      otzariaChunks: [
        otzariaChunk({ total: 500, groupCount: 1, results: [otzariaHit(1)] }),
      ],
    });
    const response = await service.search(baseRequest);
    expect(response.nextCursor).toBeNull();
  });

  it('מנוע שנכשל מסומן כמוצה, והשני ממשיך להתקדם', async () => {
    const { service } = sources({
      otzariaError: new Error('האינדקס אינו בנוי'),
      hebrewBooksPage: { results: [hebrewBooksHit('10')], totalBooks: 5, totalHits: 5, truncated: false },
    });
    const response = await service.search({ ...baseRequest, limit: 1 });
    expect(response.warnings).toEqual(['החיפוש באוצריא נכשל: האינדקס אינו בנוי']);
    expect(response.nextCursor).toMatchObject({
      otzariaComplete: true,
      hebrewBooksComplete: false,
      hebrewBooksOffset: 1,
    });
  });

  it('כשל בשני המנועים נזרק עם שתי ההודעות', async () => {
    const { service } = sources({
      otzariaError: new Error('האינדקס אינו בנוי'),
      hebrewBooksError: new Error('השירות אינו פועל'),
    });
    await expect(service.search(baseRequest)).rejects.toThrow(
      'החיפוש באוצריא נכשל: האינדקס אינו בנוי\nהחיפוש בהיברובוקס נכשל: השירות אינו פועל',
    );
  });

  it('מנוע שכבר סומן כמוצה בסמן אינו נשאל שוב', async () => {
    const { service, otzaria, hebrewBooks } = sources({
      hebrewBooksPage: { results: [hebrewBooksHit('11')], totalBooks: 2, totalHits: 2, truncated: false },
    });
    await service.search(baseRequest, {
      otzariaOffset: 3,
      hebrewBooksOffset: 1,
      otzariaComplete: true,
      hebrewBooksComplete: false,
    });
    expect(otzaria.search).not.toHaveBeenCalled();
    expect(hebrewBooks.search).toHaveBeenCalledTimes(1);
  });

  it('קטיעה של היברובוקס מסמנת ספירה כרף תחתון', async () => {
    const { service } = sources({
      hebrewBooksPage: {
        results: [hebrewBooksHit('10', 4)],
        totalBooks: 10_000,
        totalHits: 40_000,
        truncated: true,
      },
    });
    const response = await service.search(baseRequest);
    expect(response.totalIsLowerBound).toBe(true);
    expect(response.truncated).toBe(true);
    expect(response.hebrewBooksTotal).toBe(40_000);
  });

  it('בקשת חיפוש עם offset פותחת את הסמן באותו מקום', async () => {
    const { service, otzaria } = sources({});
    await service.search({ ...baseRequest, offset: 40, limit: 20 });
    expect(otzaria.search).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 40, limit: 20 }),
      expect.anything(),
    );
  });
});
