import { describe, expect, it } from 'vitest';
import type {
  HebrewBooksResult,
  HebrewBooksSearchPage,
  HostSearchRequest,
  OtzariaSearchChunk,
  OtzariaSearchResponse,
  UnifiedSearchResponse,
} from '../src/models';
import {
  mergeUnifiedSearchResponses,
  UnifiedSearchService,
  toHebrewBooksSnapshot,
} from '../src/services/unified-search-service';
import { buildCategoryTree, collectBooks, facetMatches } from '../src/screens/results-screen';

const request: HostSearchRequest = {
  query: 'חכמה בינה',
  mode: 'advanced',
  distance: 4,
  limit: 100,
  wordOptions: {
    'חכמה_0': { 'קידומות דקדוקיות': true, 'כתיב מלא/חסר': true },
    'בינה_1': { 'ראשי תיבות': true },
  },
};

const hbResults: HebrewBooksResult[] = [
  {
    fileId: '10',
    bookName: 'ספר משויך',
    authorName: null,
    printPlace: null,
    printYear: null,
    countPage: 100,
    categories: null,
    sourceType: 'PDF',
    relativePath: null,
    hitCount: 3,
    firstHitPage: 4,
  },
  {
    fileId: '11',
    bookName: 'ספר ללא שיוך',
    authorName: null,
    printPlace: null,
    printYear: null,
    countPage: null,
    categories: null,
    sourceType: 'PDF',
    relativePath: null,
    hitCount: 2,
    firstHitPage: 7,
  },
  {
    fileId: '12',
    bookName: 'ספר נוסף',
    authorName: null,
    printPlace: null,
    printYear: null,
    countPage: null,
    categories: null,
    sourceType: 'PDF',
    relativePath: null,
    hitCount: 1,
    firstHitPage: null,
  },
];

const otzariaResponse: OtzariaSearchResponse = {
  results: [
    {
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
    },
  ],
  total: 1,
  groupCount: null,
  truncated: false,
  limit: 100,
  offset: 0,
  facets: ['/'],
};

async function* searchChunks(
  response: OtzariaSearchResponse,
): AsyncIterable<OtzariaSearchChunk> {
  yield { ...response, sequence: 0 };
}

function hebrewBooksPage(
  results: HebrewBooksResult[],
  totalBooks = results.length,
  totalHits = results.reduce((total, result) => total + result.hitCount, 0),
  truncated = false,
): HebrewBooksSearchPage {
  return { results, totalBooks, totalHits, truncated };
}

describe('UnifiedSearchService', () => {
  it('maps the host options supported by HebrewBooks and always preserves word order', () => {
    const snapshot = toHebrewBooksSnapshot(request);

    expect(snapshot.options).toMatchObject({
      proximity: 4,
      hybur: true,
      spelling: true,
      rashetevot: true,
      aramaic: false,
      requireWordOrder: true,
    });
  });

  it('maps Otzaria adjacent-word distance to the smallest valid HebrewBooks proximity', () => {
    const snapshot = toHebrewBooksSnapshot({ ...request, distance: 0 });

    expect(snapshot.options.proximity).toBe(1);
  });

  it('caps the HebrewBooks proximity at the range the service supports', () => {
    expect(toHebrewBooksSnapshot({ ...request, distance: 30 }).options.proximity).toBe(30);
    expect(toHebrewBooksSnapshot({ ...request, distance: 31 }).options.proximity).toBe(30);
    expect(toHebrewBooksSnapshot({ ...request, distance: 5000 }).options.proximity).toBe(30);
  });

  it('places matched HebrewBooks results in the Otzaria category and unmatched results in their own category', async () => {
    const service = new UnifiedSearchService(
      { search: async () => hebrewBooksPage(hbResults.slice(0, 2)) },
      {
        search: () => searchChunks(otzariaResponse),
        resolveBooks: async () => [{ id: 70, title: 'מקביל', categoryPath: '/מחשבה/מוסר' }],
      },
      { findBestOtzariaIds: async () => new Map([['10', 70]]) },
    );

    const response = await service.search(request);

    expect(response.results.map((result) => [result.source, result.categoryPath])).toEqual([
      ['otzaria', '/הלכה/אחרונים'],
      ['hebrewbooks', '/מחשבה/מוסר'],
      ['hebrewbooks', 'ספרי היברובוקס'],
    ]);
    expect(response.hebrewBooksTotal).toBe(5);
  });

  it('returns Otzaria results with a warning when the local HebrewBooks server fails', async () => {
    const service = new UnifiedSearchService(
      { search: async () => { throw new Error('לא מחובר'); } },
      { search: () => searchChunks(otzariaResponse), resolveBooks: async () => [] },
      { findBestOtzariaIds: async () => new Map() },
    );

    const response = await service.search(request);

    expect(response.results).toHaveLength(1);
    expect(response.warnings.join(' ')).toContain('לא מחובר');
  });

  it('publishes Otzaria results before HebrewBooks finishes', async () => {
    let finishHebrewBooks!: (results: HebrewBooksSearchPage) => void;
    const hebrewBooksPending = new Promise<HebrewBooksSearchPage>((resolve) => {
      finishHebrewBooks = resolve;
    });
    const service = new UnifiedSearchService(
      { search: async () => hebrewBooksPending },
      { search: () => searchChunks(otzariaResponse), resolveBooks: async () => [] },
      { findBestOtzariaIds: async () => new Map() },
    );
    let partial: UnifiedSearchResponse | undefined;
    let fullSearch!: Promise<UnifiedSearchResponse>;
    const partialReady = new Promise<void>((resolve) => {
      fullSearch = service.search(request, undefined, (response) => {
        partial = response;
        resolve();
      });
    });

    await partialReady;

    expect(partial).toMatchObject({
      results: [{ source: 'otzaria' }],
      hebrewBooksTotal: 0,
      nextCursor: null,
    });
    finishHebrewBooks(hebrewBooksPage([]));
    await fullSearch;
  });

  it('publishes every Otzaria chunk and accumulates the final response', async () => {
    async function* nativeChunks(): AsyncIterable<OtzariaSearchChunk> {
      yield { ...otzariaResponse, sequence: 0, results: [], total: 1 };
      yield { ...otzariaResponse, sequence: 1 };
    }
    const service = new UnifiedSearchService(
      { search: async () => hebrewBooksPage([]) },
      { search: nativeChunks, resolveBooks: async () => [] },
      { findBestOtzariaIds: async () => new Map() },
    );
    const publishedSizes: number[] = [];

    const response = await service.search(request, undefined, (partial) => {
      publishedSizes.push(partial.results.length);
    });

    expect(publishedSizes).toEqual([0, 1]);
    expect(response.results).toHaveLength(1);
    expect(response.otzariaTotal).toBe(1);
  });

  it('publishes HebrewBooks batches together with results already received from Otzaria', async () => {
    const service = new UnifiedSearchService(
      {
        search: async (_snapshot, onUpdate) => {
          onUpdate?.(hebrewBooksPage([hbResults[0]!]));
          onUpdate?.(hebrewBooksPage(hbResults));
          return hebrewBooksPage(hbResults);
        },
      },
      { search: () => searchChunks(otzariaResponse), resolveBooks: async () => [] },
      { findBestOtzariaIds: async () => new Map() },
    );
    const updates: Array<Array<'otzaria' | 'hebrewbooks'>> = [];

    await service.search(request, undefined, (partial) => {
      updates.push(partial.results.map((result) => result.source));
    });

    expect(updates.some((sources) => sources.includes('hebrewbooks'))).toBe(true);
    expect(updates.at(-1)).toEqual([
      'otzaria',
      ...hbResults.map(() => 'hebrewbooks' as const),
    ]);
  });

  it('closes the Otzaria iterator when the caller rejects a stale update', async () => {
    let closed = false;
    async function* nativeChunks(): AsyncIterable<OtzariaSearchChunk> {
      try {
        yield { ...otzariaResponse, sequence: 0 };
        yield { ...otzariaResponse, sequence: 1, results: [] };
      } finally {
        closed = true;
      }
    }
    const service = new UnifiedSearchService(
      { search: async () => hebrewBooksPage([]) },
      { search: nativeChunks, resolveBooks: async () => [] },
      { findBestOtzariaIds: async () => new Map() },
    );

    await service.search(request, undefined, () => false);

    expect(closed).toBe(true);
  });

  it('aborts the pending HebrewBooks request when an update becomes stale', async () => {
    let nativeClosed = false;
    let hebrewBooksAborted = false;
    async function* nativeChunks(): AsyncIterable<OtzariaSearchChunk> {
      try {
        yield { ...otzariaResponse, sequence: 0 };
      } finally {
        nativeClosed = true;
      }
    }
    const service = new UnifiedSearchService(
      {
        search: async (_snapshot, _onUpdate, signal) => new Promise<HebrewBooksSearchPage>((resolve) => {
          const abort = (): void => {
            hebrewBooksAborted = true;
            resolve(hebrewBooksPage([]));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        }),
      },
      { search: nativeChunks, resolveBooks: async () => [] },
      { findBestOtzariaIds: async () => new Map() },
    );

    await service.search(request, undefined, () => false);

    expect(nativeClosed).toBe(true);
    expect(hebrewBooksAborted).toBe(true);
  });

  it('forwards caller cancellation before either source publishes a result', async () => {
    let hebrewBooksAborted = false;
    const service = new UnifiedSearchService(
      {
        search: async (_snapshot, _onUpdate, signal) => new Promise<HebrewBooksSearchPage>((resolve) => {
          const abort = (): void => {
            hebrewBooksAborted = true;
            resolve(hebrewBooksPage([]));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        }),
      },
      {
        search: async function* () {},
        resolveBooks: async () => [],
      },
      { findBestOtzariaIds: async () => new Map() },
    );
    const cancellation = new AbortController();

    const pending = service.search(request, undefined, undefined, cancellation.signal);
    cancellation.abort();
    await pending;

    expect(hebrewBooksAborted).toBe(true);
  });

  it('טוען עמוד נוסף מכל מנוע ומאחד ללא כפילויות', async () => {
    const nativeHits = [
      otzariaResponse.results[0]!,
      { ...otzariaResponse.results[0]!, id: 8, bookId: 'ספר 8', book: 'ספר 8', index: 13 },
      { ...otzariaResponse.results[0]!, id: 9, bookId: 'ספר 9', book: 'ספר 9', index: 14 },
    ];
    const nativeOffsets: number[] = [];
    const hebrewBooksLimits: number[] = [];
    const service = new UnifiedSearchService(
      {
        search: async (snapshot, _onUpdate, _signal, offset = 0) => {
          hebrewBooksLimits.push(snapshot.options.limit);
          return hebrewBooksPage(
            hbResults.slice(offset, offset + snapshot.options.limit),
            hbResults.length,
            6,
          );
        },
      },
      {
        search: (pageRequest) => {
          const offset = pageRequest.offset ?? 0;
          const limit = pageRequest.limit ?? 100;
          nativeOffsets.push(offset);
          return searchChunks({
            ...otzariaResponse,
            results: nativeHits.slice(offset, offset + limit),
            total: nativeHits.length,
            limit,
            offset,
          });
        },
        resolveBooks: async () => [],
      },
      { findBestOtzariaIds: async () => new Map() },
    );
    const pagedRequest = { ...request, limit: 2 };

    const first = await service.search(pagedRequest);
    expect(first.nextCursor).toEqual({
      otzariaOffset: 2,
      hebrewBooksOffset: 2,
      otzariaComplete: false,
      hebrewBooksComplete: false,
    });
    const second = await service.search(pagedRequest, first.nextCursor!);
    const merged = mergeUnifiedSearchResponses(first, second);

    expect(nativeOffsets).toEqual([0, 2]);
    expect(hebrewBooksLimits).toEqual([2, 2]);
    expect(second.nextCursor).toBeNull();
    expect(merged.results).toHaveLength(6);
    expect(
      new Set(
        merged.results.map((result) =>
          result.source === 'otzaria'
            ? `otzaria:${result.hit.bookId}`
            : `hebrewbooks:${result.hit.fileId}`,
        ),
      ),
    ).toHaveLength(6);
    expect(merged.truncated).toBe(false);
  });

  it('אינו שולח שוב בקשה למנוע שכבר הסתיים', async () => {
    let nativeCalls = 0;
    const service = new UnifiedSearchService(
      {
        search: async (snapshot, _onUpdate, _signal, offset = 0) => hebrewBooksPage(
          hbResults.slice(offset, offset + snapshot.options.limit),
          hbResults.length,
          6,
        ),
      },
      {
        search: (pageRequest) => {
          nativeCalls += 1;
          return searchChunks({ ...otzariaResponse, limit: pageRequest.limit ?? 100 });
        },
        resolveBooks: async () => [],
      },
      { findBestOtzariaIds: async () => new Map() },
    );
    const pagedRequest = { ...request, limit: 2 };

    const first = await service.search(pagedRequest);
    expect(first.nextCursor?.otzariaComplete).toBe(true);
    await service.search(pagedRequest, first.nextCursor!);

    expect(nativeCalls).toBe(1);
  });

  it('builds an ancestor-aware category tree with aggregate counts and book leaves', () => {
    const tree = buildCategoryTree([
      { source: 'otzaria', categoryPath: '/הלכה/אחרונים', hit: otzariaResponse.results[0]! },
      { source: 'hebrewbooks', categoryPath: '/הלכה/שו״ת', hit: hbResults[0]! },
      { source: 'hebrewbooks', categoryPath: 'ספרי היברובוקס', hit: hbResults[1]! },
    ]);

    const halacha = tree.find((node) => node.path === '/הלכה');
    expect(halacha?.count).toBe(2);
    expect(halacha?.children.map((node) => [node.path, node.depth, node.count])).toEqual([
      ['/הלכה/אחרונים', 1, 1],
      ['/הלכה/שו״ת', 1, 1],
    ]);
    expect(tree.find((node) => node.path === 'ספרי היברובוקס')?.count).toBe(1);
    expect(collectBooks(tree).map((book) => book.title)).toEqual([
      'ספר אוצריא',
      hbResults[0]!.bookName,
      hbResults[1]!.bookName,
    ]);
  });

  it('matches a category facet on its whole subtree and a book facet on one book only', () => {
    const inSubCategory = {
      source: 'otzaria',
      categoryPath: '/הלכה/אחרונים',
      hit: otzariaResponse.results[0]!,
    } as const;
    const elsewhere = { source: 'hebrewbooks', categoryPath: 'ספרי היברובוקס', hit: hbResults[1]! } as const;
    const bookFacet = collectBooks(buildCategoryTree([inSubCategory]))[0]!.facet;

    expect(facetMatches(null, elsewhere)).toBe(true);
    expect(facetMatches('/הלכה', inSubCategory)).toBe(true);
    expect(facetMatches('/הלכה', elsewhere)).toBe(false);
    expect(facetMatches(bookFacet, inSubCategory)).toBe(true);
    expect(facetMatches(bookFacet, elsewhere)).toBe(false);
  });
});
