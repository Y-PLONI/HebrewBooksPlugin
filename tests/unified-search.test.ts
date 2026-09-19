import { describe, expect, it } from 'vitest';
import type {
  HebrewBooksResult,
  HebrewBooksSearchPage,
  HostSearchRequest,
  OtzariaSearchChunk,
  OtzariaSearchResponse,
  SearchMatchPolicy,
  UnifiedSearchResponse,
} from '../src/models';
import {
  mergeUnifiedSearchResponses,
  UnifiedSearchService,
  sanitizedGlobalOptions,
  sanitizedMatchPolicy,
  sanitizedWordOptions,
  toHebrewBooksSnapshot,
} from '../src/services/unified-search-service';
import { buildCategoryTree, collectBooks, facetMatches } from '../src/screens/results-screen';
import {
  maximumMatchCombinations,
  otzariaDistanceForProximity,
  paragraphProximity,
  scopeProximity,
  sectionProximity,
} from '../src/models';

const request: HostSearchRequest = {
  query: 'חכמה בינה',
  mode: 'advanced',
  distance: 4,
  limit: 100,
  wordOptions: {
    'חכמה_0': { 'קידומות דקדוקיות': true, 'כתיב מלא/חסר': true, 'ראשי תיבות': true },
    'בינה_1': { 'קידומות דקדוקיות': true, 'כתיב מלא/חסר': true, 'ראשי תיבות': true },
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
      proximity: 5,
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

  it('treats the fuzzy distance as an edit distance, not as word spacing', () => {
    const snapshot = toHebrewBooksSnapshot({ query: 'ברכת המזון', mode: 'fuzzy', distance: 2 });
    expect(snapshot.options).toMatchObject({ proximity: 1, fuzziness: 2 });
  });

  it('searches the window of the requested scope when Otzaria waives the word spacing', () => {
    for (const [policy, proximity] of [
      [{ proximityScope: 'sameParagraph' as const }, paragraphProximity],
      [{ proximityScope: 'sameSection' as const }, sectionProximity],
      [{ wordMatchMode: 'mostWords' as const }, paragraphProximity],
    ] as const) {
      const snapshot = toHebrewBooksSnapshot({ ...request, distance: 0, ...policy });
      expect(snapshot.options).toMatchObject({ proximity, requireWordOrder: false });
    }
    expect(
      toHebrewBooksSnapshot({ ...request, distance: 0, proximityScope: 'wordDistance', wordMatchMode: 'all' })
        .options,
    ).toMatchObject({ proximity: 1, requireWordOrder: true });
  });

  it('keeps the dialog proximity across the Otzaria tab round trip', () => {
    for (const query of ['ברכה', 'ברכת המזון', 'ברוך אתה השם אלוקינו']) {
      for (let proximity = 1; proximity <= 30; proximity++) {
        const distance = otzariaDistanceForProximity(proximity);
        expect(toHebrewBooksSnapshot({ query, distance }).options.proximity).toBe(proximity);
      }
    }
  });

  // hbsearch מחיל את proximity על כל צמד סמוך (`A w/N B w/N C`), ולכן המרת
  // distance אינה תלויה במספר המילים — היא distance+1 תמיד.
  it('sends a per-gap proximity that does not grow with the number of query words', () => {
    const queries = ['ברכת המזון', 'ברוך אתה השם', 'ברוך אתה השם אלוקינו'];
    for (const [distance, proximity] of [[0, 1], [1, 2], [5, 6]] as const) {
      for (const query of queries) {
        const snapshot = toHebrewBooksSnapshot({ query, mode: 'exact', distance });
        expect({ q: snapshot.query, proximity: snapshot.options.proximity }).toEqual({ q: query, proximity });
      }
    }
  });

  // הגבול: distance 0 חייב להפיק w/1 — מילה מוכנסת באמצע פוסלת את ההתאמה.
  it('maps an adjacent-words request to the strictest window', () => {
    for (const query of ['ברכת המזון', 'ברוך אתה השם', 'ברוך אתה השם אלוקינו']) {
      expect(toHebrewBooksSnapshot({ query, mode: 'exact', distance: 0 }).options.proximity).toBe(1);
      expect(toHebrewBooksSnapshot({ query, mode: 'exact', distance: 1 }).options.proximity).toBe(2);
    }
  });

  it('maps a global Otzaria option when no per-word override is supplied', () => {
    const snapshot = toHebrewBooksSnapshot({
      ...request,
      options: { 'תרגום ארמי': true },
      wordOptions: undefined,
    });

    expect(snapshot.options.aramaic).toBe(true);
    expect(snapshot.options).toMatchObject({ roots: false, gematria: false, numberGender: false, rashiOcr: false });
  });

  it('does not apply a per-word Otzaria option globally in HebrewBooks', () => {
    const snapshot = toHebrewBooksSnapshot({
      ...request,
      wordOptions: {
        'חכמה_0': { 'קידומות דקדוקיות': true },
        'בינה_1': {},
      },
    });

    expect(snapshot.options.hybur).toBe(false);
  });

  it('caps the HebrewBooks proximity at the range the service supports', () => {
    expect(toHebrewBooksSnapshot({ ...request, distance: 30 }).options.proximity).toBe(30);
    expect(toHebrewBooksSnapshot({ ...request, distance: 31 }).options.proximity).toBe(30);
    expect(toHebrewBooksSnapshot({ ...request, distance: 5000 }).options.proximity).toBe(30);
  });

  it('falls back to the global options when the host tokenization differs (hyphen)', () => {
    // 'בית-דין' נטוקנן באוצריא לשתי מילים ('בית_0', 'דין_1') — המפתחות לא
    // מתאימים לפירוק לפי רווחים; המפה הגלובלית שומרת על האפשרות פעילה.
    const snapshot = toHebrewBooksSnapshot({
      ...request,
      query: 'בית-דין צדק',
      options: { 'קידומות דקדוקיות': true },
      wordOptions: {
        'בית_0': { 'קידומות דקדוקיות': true },
        'דין_1': { 'קידומות דקדוקיות': true },
        'צדק_2': { 'קידומות דקדוקיות': true },
      },
    });

    expect(snapshot.options.hybur).toBe(true);
  });

  it('without the global map a tokenization mismatch keeps the option off (conservative)', () => {
    const snapshot = toHebrewBooksSnapshot({
      ...request,
      query: 'בית-דין צדק',
      options: undefined,
      wordOptions: {
        'בית_0': { 'קידומות דקדוקיות': true },
        'דין_1': { 'קידומות דקדוקיות': true },
        'צדק_2': { 'קידומות דקדוקיות': true },
      },
    });

    expect(snapshot.options.hybur).toBe(false);
  });

  it('sanitizedGlobalOptions keeps true values only and rejects malformed payloads', () => {
    expect(
      sanitizedGlobalOptions({ 'קידומות דקדוקיות': true, 'כתיב מלא/חסר': 'yes' }),
    ).toEqual({ 'קידומות דקדוקיות': true });
    expect(sanitizedGlobalOptions(undefined)).toBeUndefined();
    expect(sanitizedGlobalOptions(null)).toBeUndefined();
    expect(sanitizedGlobalOptions('קידומות')).toBeUndefined();
    expect(sanitizedGlobalOptions(['קידומות'])).toBeUndefined();
  });

  it('sanitizedWordOptions keeps a well-formed map and drops non-true values', () => {
    expect(
      sanitizedWordOptions({
        'ברכת_0': { 'קידומות דקדוקיות': true, 'כתיב מלא/חסר': 'yes' },
        'המזון_1': { 'קידומות דקדוקיות': true },
      }),
    ).toEqual({
      'ברכת_0': { 'קידומות דקדוקיות': true },
      'המזון_1': { 'קידומות דקדוקיות': true },
    });
  });

  it('sanitizedWordOptions rejects malformed payloads as if none were sent', () => {
    expect(sanitizedWordOptions(undefined)).toBeUndefined();
    expect(sanitizedWordOptions(null)).toBeUndefined();
    expect(sanitizedWordOptions('קידומות')).toBeUndefined();
    expect(sanitizedWordOptions(['ברכת_0'])).toBeUndefined();
    expect(sanitizedWordOptions({ 'ברכת_0': 'קידומות' })).toBeUndefined();
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

// מדיניות ההתאמה של אוצריא (issue #1427): כל מצב שאינו "כל המילים לפי הסדר"
// מתורגם לשאילתת האופרטורים שנשלחת ל-hbsearch בשדה q.
describe('Otzaria match policy as a hbsearch query', () => {
  const query = 'ברוך אתה השם אלוקינו';
  const queryOf = (policy: SearchMatchPolicy, text = query): string =>
    toHebrewBooksSnapshot({ query: text, mode: 'advanced', distance: 0, ...policy }).query;

  it('leaves the query untouched when the host sends no policy (older host)', () => {
    const snapshot = toHebrewBooksSnapshot({ query, mode: 'advanced', distance: 0 });

    expect(snapshot.query).toBe(query);
    expect(snapshot.displayQuery).toBeUndefined();
    expect(snapshot.options).toMatchObject({ proximity: 1, requireWordOrder: true });
  });

  it('refuses "same paragraph" rather than searching a word window under its name', () => {
    const snapshot = toHebrewBooksSnapshot({ query, proximityScope: 'sameParagraph' });

    expect(snapshot.unsupportedPolicy).toContain('אינו נתמך בהיברובוקס');
    expect(snapshot.query).toBe(query);
    expect(snapshot.displayQuery).toBeUndefined();
  });

  it('keeps the section window wider than the paragraph window, and both under the book', () => {
    expect(sectionProximity).toBeGreaterThan(paragraphProximity);
    expect(scopeProximity('wordDistance')).toBe(paragraphProximity);
  });

  it('maps anyWord to a disjunction', () => {
    const disjunction = 'ברוך or אתה or השם or אלוקינו';
    expect(queryOf({ wordMatchMode: 'anyWord' })).toBe(disjunction);
    expect(queryOf({ wordMatchMode: 'anyWord', proximityScope: 'wordDistance' })).toBe(disjunction);
  });

  it('maps mostWords to the n/2+1 sized combinations', () => {
    // כל w/30 מסוגר במפורש עם מילה בודדת מימינו — שרשרת חשופה נדחית.
    expect(queryOf({ wordMatchMode: 'mostWords' })).toBe(
      '((ברוך w/30 אתה) w/30 השם) or ((ברוך w/30 אתה) w/30 אלוקינו)'
        + ' or ((ברוך w/30 השם) w/30 אלוקינו) or ((אתה w/30 השם) w/30 אלוקינו)',
    );
    // שתי מילים: רוב = שתיהן, ואין צורך באופרטורים.
    expect(queryOf({ wordMatchMode: 'mostWords' }, 'ברכת המזון')).toBe('ברכת המזון');
    expect(queryOf({ wordMatchMode: 'mostWords' }, 'ברוך אתה השם')).toBe(
      '(ברוך w/30 אתה) or (ברוך w/30 השם) or (אתה w/30 השם)',
    );
  });

  it('refuses "under the same heading" instead of approximating it with a word window', () => {
    // אוצריא מודדת סעיף בבלוק כותרת; מסמך של היברובוקס הוא ספר סרוק שלם.
    for (const proximityScope of ['sameParagraph', 'sameSection'] as const) {
      for (const wordMatchMode of ['all', 'anyWord', 'mostWords'] as const) {
        const snapshot = toHebrewBooksSnapshot({ query, proximityScope, wordMatchMode });
        expect(snapshot.unsupportedPolicy).toContain('אינו נתמך בהיברובוקס');
        expect(snapshot.query).toBe(query);
      }
    }
  });

  it('counts distinct words for the threshold, as the Otzaria engine merges repeats', () => {
    // "רוב" משתי מילים ייחודיות הוא שתיהן — השאילתה הרגילה, ולא צירופי זוגות.
    expect(queryOf({ wordMatchMode: 'mostWords' }, 'ברכת ברכת המזון')).toBe('ברכת ברכת המזון');
    expect(queryOf({ wordMatchMode: 'anyWord' }, 'ברכת ברכת המזון')).toBe('ברכת or המזון');
  });

  it('expands atLeast to the combinations of the requested size', () => {
    expect(queryOf({ wordMatchMode: 'atLeast', wordMatchCount: 2 })).toBe(
      '(ברוך w/30 אתה) or (ברוך w/30 השם) or (ברוך w/30 אלוקינו)'
        + ' or (אתה w/30 השם) or (אתה w/30 אלוקינו) or (השם w/30 אלוקינו)',
    );
    // בלי wordMatchCount ברירת המחדל של אוצריא היא שתי מילים.
    expect(queryOf({ wordMatchMode: 'atLeast' })).toBe(queryOf({ wordMatchMode: 'atLeast', wordMatchCount: 2 }));
  });

  it('clamps atLeast to the number of query words, which is the plain search again', () => {
    expect(queryOf({ wordMatchMode: 'atLeast', wordMatchCount: 9 })).toBe(query);
    expect(queryOf({ wordMatchMode: 'atLeast', wordMatchCount: 0 })).toBe('ברוך or אתה or השם or אלוקינו');
    expect(queryOf({ wordMatchMode: 'atLeast', wordMatchCount: 9, proximityScope: 'sameSection' })).toBe(query);
  });

  it('refuses "most of eight words": C(8,5)=56 combinations are too slow to finish', () => {
    const snapshot = toHebrewBooksSnapshot({ query: 'א ב ג ד ה ו ז ח', wordMatchMode: 'mostWords' });

    // 56 צירופים נמדדו מול השירות הרבה מעבר לתקרת הזמן של בקשת החיפוש.
    expect(snapshot.unsupportedPolicy).toContain('5 מתוך 8');
    expect(snapshot.query).toBe('א ב ג ד ה ו ז ח');
  });

  it('expands "most of five words" — the largest partial match that still fits', () => {
    const groups = queryOf({ wordMatchMode: 'mostWords' }, 'א ב ג ד ה').split(' or ');

    // רוב מתוך חמש = שלוש מילים ב-C(5,3)=10 צירופים, בדיוק בתקרה.
    expect(groups).toHaveLength(maximumMatchCombinations);
    expect(groups.every((group) => /^\(\(\S+ w\/30 \S+\) w\/30 \S+\)$/.test(group))).toBe(true);
  });

  it('refuses a partial match too large to express, instead of searching for any word', () => {
    const many = 'א ב ג ד ה ו ז ח ט י כ ל';
    const snapshot = toHebrewBooksSnapshot({ query: many, mode: 'advanced', wordMatchMode: 'mostWords' });

    // C(12,7)=792: דיסיונקציה במקומה הייתה "מילה כלשהי" — חיפוש אחר לגמרי.
    expect(snapshot.unsupportedPolicy).toContain('אינו נתמך');
    expect(snapshot.unsupportedPolicy).toContain('7 מתוך 12');
    expect(snapshot.query).toBe(many);
    expect(snapshot.query).not.toContain(' or ');
  });

  it('refuses only above the cap — C(n,k) that fits still expands', () => {
    const cap = (words: string, count: number): string | undefined =>
      toHebrewBooksSnapshot({ query: words, wordMatchMode: 'atLeast', wordMatchCount: count }).unsupportedPolicy;

    // C(5,2)=10 עוד נכנס בתקרה, C(6,2)=15 כבר לא.
    expect(cap('א ב ג ד ה', 2)).toBeUndefined();
    expect(cap('א ב ג ד ה ו', 2)).toContain('אינו נתמך');
  });

  it('refuses a query too large for the engine to parse, whatever the mode', () => {
    const long = Array.from({ length: 2_000 }, (_, index) => `מילה${index}`).join(' ');

    for (const policy of [{}, { wordMatchMode: 'anyWord' as const }]) {
      const snapshot = toHebrewBooksSnapshot({ query: long, ...policy });
      expect(snapshot.unsupportedPolicy).toContain('ארוכה מדי');
      expect(snapshot.query).toBe(long);
    }
    expect(toHebrewBooksSnapshot({ query: 'ברוך אתה', wordMatchMode: 'anyWord' }).unsupportedPolicy)
      .toBeUndefined();
  });

  it('refuses a partial match whose words include a search-engine operator', () => {
    const snapshot = toHebrewBooksSnapshot({ query: 'ברוך w/5 אתה מלך', wordMatchMode: 'mostWords' });

    expect(snapshot.unsupportedPolicy).toContain('אופרטור של מנוע החיפוש');
    expect(snapshot.query).toBe('ברוך w/5 אתה מלך');
    // "כל המילים" עדיין שולח את טקסט המשתמש — הבנאי של hbsearch מטפל באופרטורים.
    expect(toHebrewBooksSnapshot({ query: 'ברוך w/5 אתה' }).unsupportedPolicy).toBeUndefined();
  });

  it('strips gershayim like the hbsearch query builder does, and never splits one word', () => {
    expect(queryOf({ wordMatchMode: 'anyWord' }, 'רמב"ם הלכות')).toBe('רמבם or הלכות');
    for (const mode of ['anyWord', 'mostWords', 'atLeast'] as const) {
      expect(queryOf({ wordMatchMode: mode, proximityScope: 'sameSection' }, 'ברכה')).toBe('ברכה');
    }
  });

  it('changes the request fingerprint whenever the policy changes', () => {
    const fingerprints = [
      {},
      { proximityScope: 'sameParagraph' as const },
      { proximityScope: 'sameSection' as const },
      { wordMatchMode: 'anyWord' as const },
      { wordMatchMode: 'mostWords' as const },
      { wordMatchMode: 'atLeast' as const, wordMatchCount: 2 },
    ].map((policy) => toHebrewBooksSnapshot({ query, mode: 'advanced', distance: 0, ...policy }).fingerprint);
    const fingerprintOf = (policy: SearchMatchPolicy): string =>
      toHebrewBooksSnapshot({ query, mode: 'advanced', distance: 0, ...policy }).fingerprint;

    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    // "רוב המילים" מארבע מילים הוא בדיוק "לפחות שלוש" — אותו חיפוש, ובצדק אותו מטמון.
    expect(fingerprintOf({ wordMatchMode: 'atLeast', wordMatchCount: 3 }))
      .toBe(fingerprintOf({ wordMatchMode: 'mostWords' }));
  });

  it('sends that query to the HebrewBooks repository', async () => {
    const snapshots: string[] = [];
    const service = new UnifiedSearchService(
      {
        search: async (snapshot) => {
          snapshots.push(snapshot.query);
          return hebrewBooksPage([]);
        },
      },
      { search: () => searchChunks(otzariaResponse), resolveBooks: async () => [] },
      { findBestOtzariaIds: async () => new Map() },
    );

    await service.search({ ...request, query, wordMatchMode: 'anyWord' });

    expect(snapshots).toEqual(['ברוך or אתה or השם or אלוקינו']);
  });

  it('sanitizedMatchPolicy forwards a usable wordMatchCount and drops the rest', () => {
    expect(sanitizedMatchPolicy('sameSection', 'atLeast', 3)).toEqual({
      proximityScope: 'sameSection',
      wordMatchMode: 'atLeast',
      wordMatchCount: 3,
    });
    for (const count of [undefined, null, 0, -2, 1.5, 'שלוש', {}]) {
      expect(sanitizedMatchPolicy('sameParagraph', 'mostWords', count)).toEqual({
        proximityScope: 'sameParagraph',
        wordMatchMode: 'mostWords',
      });
    }
    expect(sanitizedMatchPolicy('everywhere', 'someWords', 3)).toEqual({
      proximityScope: undefined,
      wordMatchMode: undefined,
      wordMatchCount: 3,
    });
  });
});
