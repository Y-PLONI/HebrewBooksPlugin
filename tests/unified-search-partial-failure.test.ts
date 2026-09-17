import { describe, expect, it } from 'vitest';
import type {
  HebrewBooksResult,
  HebrewBooksSearchPage,
  HostSearchRequest,
  OtzariaSearchChunk,
  OtzariaSearchHit,
  SearchSnapshot,
} from '../src/models';
import { UnifiedSearchService } from '../src/services/unified-search-service';

const request: HostSearchRequest = {
  query: 'חכמה בינה',
  mode: 'advanced',
  distance: 4,
  limit: 100,
};

const otzariaHit: OtzariaSearchHit = {
  id: 7,
  type: 'text',
  source: 'library',
  bookId: 'ספר אוצריא',
  book: 'ספר אוצריא',
  categoryPath: '/הלכה/אחרונים',
  reference: 'סימן א',
  text: 'חכמה ובינה',
  index: 12,
  mergedCount: 1,
};

const hebrewBooksHit: HebrewBooksResult = {
  fileId: '10',
  bookName: 'ספר היברובוקס',
  authorName: null,
  printPlace: null,
  printYear: null,
  countPage: 100,
  categories: null,
  sourceType: 'PDF',
  relativePath: null,
  hitCount: 3,
  firstHitPage: 4,
};

function hebrewBooksPage(results: HebrewBooksResult[]): HebrewBooksSearchPage {
  return {
    results,
    totalBooks: results.length,
    totalHits: results.reduce((total, result) => total + result.hitCount, 0),
    truncated: false,
  };
}

/// זרם אוצריא ששלח נתח אחד ואז נפל: התוצאה הראשונה כבר הוצגה למשתמש.
async function* otzariaStreamThatFailsAfterAChunk(): AsyncIterable<OtzariaSearchChunk> {
  yield {
    results: [otzariaHit],
    total: 1,
    groupCount: null,
    truncated: false,
    limit: 100,
    offset: 0,
    facets: ['/'],
    sequence: 0,
  };
  throw new Error('החיבור לאוצריא נותק');
}

async function* otzariaStreamThatFailsImmediately(): AsyncIterable<OtzariaSearchChunk> {
  throw new Error('החיבור לאוצריא נותק');
  yield undefined as never;
}

/// היברובוקס שפרסם עמוד ואז נפל, מול היברובוקס שנפל לפני שפרסם דבר.
function hebrewBooksThatFailsAfterAPage() {
  return {
    async search(
      _snapshot: SearchSnapshot,
      onUpdate?: (page: HebrewBooksSearchPage) => boolean | void,
    ): Promise<HebrewBooksSearchPage> {
      onUpdate?.(hebrewBooksPage([hebrewBooksHit]));
      throw new Error('שרת היברובוקס נפל');
    },
  };
}

function hebrewBooksThatFailsImmediately() {
  return {
    async search(): Promise<HebrewBooksSearchPage> {
      throw new Error('שרת היברובוקס נפל');
    },
  };
}

const noCategories = { findBestOtzariaIds: async () => new Map<string, number>() };
const noBooks = { resolveBooks: async () => [] };

describe('UnifiedSearchService partial results outliving a failure', () => {
  it('keeps the rows both engines already published when both of them then fail', async () => {
    const service = new UnifiedSearchService(
      hebrewBooksThatFailsAfterAPage(),
      { search: () => otzariaStreamThatFailsAfterAChunk(), ...noBooks },
      noCategories,
    );
    const published: number[] = [];

    const response = await service.search(request, undefined, (partial) => {
      published.push(partial.results.length);
      return true;
    });

    // מה שכבר הוצג על המסך הוצג — ואסור שייעלם רק מפני ששני המנועים נפלו.
    expect(published.at(-1)).toBe(2);
    expect(response.results.map((result) => result.source).sort()).toEqual([
      'hebrewbooks',
      'otzaria',
    ]);
    expect(response.warnings.join('\n')).toContain('החיבור לאוצריא נותק');
    expect(response.warnings.join('\n')).toContain('שרת היברובוקס נפל');
    // כישלון כפול אינו מזמין עמוד נוסף.
    expect(response.nextCursor).toBeNull();
  });

  it('still throws when both engines fail before publishing anything', async () => {
    const service = new UnifiedSearchService(
      hebrewBooksThatFailsImmediately(),
      { search: () => otzariaStreamThatFailsImmediately(), ...noBooks },
      noCategories,
    );

    // אין שורה אחת להציג, ולכן "לא נמצאו תוצאות" היה שקר: זו שגיאה.
    await expect(service.search(request)).rejects.toThrow(/החיבור לאוצריא נותק/);
    await expect(service.search(request)).rejects.toThrow(/שרת היברובוקס נפל/);
  });

  it('keeps the Otzaria rows already published when only Otzaria fails', async () => {
    const service = new UnifiedSearchService(
      { search: async () => hebrewBooksPage([hebrewBooksHit]) },
      { search: () => otzariaStreamThatFailsAfterAChunk(), ...noBooks },
      noCategories,
    );

    const response = await service.search(request);

    expect(response.results.map((result) => result.source)).toEqual([
      'otzaria',
      'hebrewbooks',
    ]);
    expect(response.warnings.join('\n')).toContain('החיבור לאוצריא נותק');
  });

  it('never reports a total the user can no longer reach', async () => {
    async function* bigTotalThenFails(): AsyncIterable<OtzariaSearchChunk> {
      yield {
        results: [otzariaHit], total: 5000, groupCount: null, truncated: false,
        limit: 100, offset: 0, facets: [], sequence: 0,
      };
      throw new Error('החיבור לאוצריא נותק');
    }
    const service = new UnifiedSearchService(
      { search: async () => hebrewBooksPage([hebrewBooksHit]) },
      { search: () => bigTotalThenFails(), ...noBooks },
      noCategories,
    );

    const response = await service.search(request);

    // 5000 בכותרת מול שורה אחת שהגיעה, בלי "טען עוד", זה מספר שאי אפשר להגיע אליו.
    expect(response.nextCursor).toBeNull();
    expect(response.otzariaTotal).toBe(1);
    expect(response.totalIsLowerBound).toBe(true);
  });

  it('clamps the HebrewBooks total to the hits actually delivered when it fails', async () => {
    const service = new UnifiedSearchService(
      {
        async search(
          _snapshot: SearchSnapshot,
          onUpdate?: (page: HebrewBooksSearchPage) => boolean | void,
        ): Promise<HebrewBooksSearchPage> {
          onUpdate?.({ results: [hebrewBooksHit], totalBooks: 400, totalHits: 9999, truncated: false });
          throw new Error('שרת היברובוקס נפל');
        },
      },
      { search: () => otzariaStreamThatFailsAfterAChunk(), ...noBooks },
      noCategories,
    );

    const response = await service.search(request);

    expect(response.hebrewBooksTotal).toBe(hebrewBooksHit.hitCount);
    expect(response.totalIsLowerBound).toBe(true);
  });

  it('keeps the real total on the success path, where more pages are reachable', async () => {
    async function* bigTotal(): AsyncIterable<OtzariaSearchChunk> {
      yield {
        results: [otzariaHit], total: 5000, groupCount: null, truncated: false,
        limit: 100, offset: 0, facets: [], sequence: 0,
      };
    }
    const service = new UnifiedSearchService(
      { search: async () => hebrewBooksPage([hebrewBooksHit]) },
      { search: () => bigTotal(), ...noBooks },
      noCategories,
    );

    const response = await service.search(request);

    expect(response.otzariaTotal).toBe(5000);
    expect(response.nextCursor).not.toBeNull();
    expect(response.totalIsLowerBound).toBe(false);
  });

  it('reports an empty search as empty, not as a failure', async () => {
    const service = new UnifiedSearchService(
      { search: async () => hebrewBooksPage([]) },
      {
        search: async function* (): AsyncIterable<OtzariaSearchChunk> {
          yield {
            results: [],
            total: 0,
            groupCount: null,
            truncated: false,
            limit: 100,
            offset: 0,
            facets: [],
            sequence: 0,
          };
        },
        ...noBooks,
      },
      noCategories,
    );

    const response = await service.search(request);

    expect(response.results).toEqual([]);
    expect(response.warnings).toEqual([]);
  });
});
