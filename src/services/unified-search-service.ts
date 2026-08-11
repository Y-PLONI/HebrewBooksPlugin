import type {
  HebrewBooksResult,
  HostBookIdentity,
  HostSearchRequest,
  OtzariaSearchChunk,
  OtzariaSearchResponse,
  ResolvedBook,
  SearchOptions,
  SearchSnapshot,
  UnifiedSearchCursor,
  UnifiedSearchResponse,
  UnifiedSearchResult,
} from '../models';

const hebrewBooksFallbackCategory = 'ספרי היברובוקס';
const otzariaFallbackCategory = 'ספרי אוצריא';
const maximumHebrewBooksResults = 500;

interface HebrewBooksSearchSource {
  search(
    snapshot: SearchSnapshot,
    onUpdate?: (results: readonly HebrewBooksResult[]) => boolean | void,
    signal?: AbortSignal,
  ): Promise<HebrewBooksResult[]>;
}

interface OtzariaSearchSource {
  search(request: HostSearchRequest, signal?: AbortSignal): AsyncIterable<OtzariaSearchChunk>;
  resolveBooks(identities: HostBookIdentity[]): Promise<Array<ResolvedBook | null>>;
}

interface CatalogMappingSource {
  findBestOtzariaIds(fileIds: string[]): Promise<Map<string, number>>;
}

export class UnifiedSearchService {
  constructor(
    private readonly hebrewBooks: HebrewBooksSearchSource,
    private readonly otzaria: OtzariaSearchSource,
    private readonly catalog: CatalogMappingSource,
  ) {}

  async search(
    request: HostSearchRequest,
    cursor: UnifiedSearchCursor = initialCursor(request),
    onUpdate?: (response: UnifiedSearchResponse) => boolean | void,
    signal?: AbortSignal,
  ): Promise<UnifiedSearchResponse> {
    const pageSize = normalizePageSize(request.limit);
    const hebrewBooksLimit = Math.min(
      maximumHebrewBooksResults,
      cursor.hebrewBooksOffset + pageSize,
    );
    const snapshot = toHebrewBooksSnapshot({ ...request, limit: hebrewBooksLimit });
    const cancellation = new AbortController();
    if (signal?.aborted) cancellation.abort();
    else signal?.addEventListener('abort', () => cancellation.abort(), { once: true });
    let partialNative = { ...emptyOtzariaResponse(), limit: pageSize, offset: cursor.otzariaOffset };
    let partialHebrewBooks: readonly HebrewBooksResult[] = [];
    const publish = (): boolean => {
      if (cancellation.signal.aborted) return false;
      if (!onUpdate) return true;
      const shouldContinue = onUpdate(partialUnifiedResponse(partialNative, partialHebrewBooks));
      if (shouldContinue === false) cancellation.abort();
      return shouldContinue !== false;
    };
    const otzariaSearch = cursor.otzariaComplete
      ? Promise.resolve<OtzariaSearchResponse | null>(null)
      : collectOtzariaSearch(
          this.otzaria.search(
            { ...request, limit: pageSize, offset: cursor.otzariaOffset },
            cancellation.signal,
          ),
          pageSize,
          cursor.otzariaOffset,
          (response) => {
            partialNative = response;
            return publish();
          },
        );
    const [otzariaResult, hebrewBooksResult] = await Promise.allSettled([
      otzariaSearch,
      cursor.hebrewBooksComplete
        ? Promise.resolve<HebrewBooksResult[] | null>(null)
        : this.hebrewBooks.search(
            snapshot,
            (results) => {
              partialHebrewBooks = results;
              return publish();
            },
            cancellation.signal,
          ),
    ]);
    if (cancellation.signal.aborted) {
      return partialUnifiedResponse(partialNative, partialHebrewBooks);
    }
    const warnings: string[] = [];
    const native = otzariaResult.status === 'fulfilled'
      ? otzariaResult.value ?? emptyOtzariaResponse()
      : emptyOtzariaResponse();
    const externalWindow = hebrewBooksResult.status === 'fulfilled'
      ? hebrewBooksResult.value ?? []
      : [];
    const external = externalWindow.slice(cursor.hebrewBooksOffset, hebrewBooksLimit);
    if (otzariaResult.status === 'rejected') warnings.push(`החיפוש באוצריא נכשל: ${messageOf(otzariaResult.reason)}`);
    if (hebrewBooksResult.status === 'rejected') {
      warnings.push(`החיפוש בהיברובוקס נכשל: ${messageOf(hebrewBooksResult.reason)}`);
    }
    if (otzariaResult.status === 'rejected' && hebrewBooksResult.status === 'rejected') {
      throw new Error(warnings.join('\n'));
    }

    const hebrewBooksCategories = await this.resolveHebrewBooksCategories(external, warnings);
    const otzariaOffset = cursor.otzariaOffset + native.results.length;
    const hebrewBooksOffset = cursor.hebrewBooksOffset + external.length;
    const expectedNativeTotal = native.groupCount ?? native.total;
    const otzariaComplete = cursor.otzariaComplete
      || otzariaResult.status === 'rejected'
      || native.results.length === 0
      || otzariaOffset >= expectedNativeTotal;
    const hebrewBooksComplete = cursor.hebrewBooksComplete
      || hebrewBooksResult.status === 'rejected'
      || externalWindow.length < hebrewBooksLimit
      || hebrewBooksLimit >= maximumHebrewBooksResults;
    const hebrewBooksCapped = !cursor.hebrewBooksComplete
      && hebrewBooksResult.status === 'fulfilled'
      && hebrewBooksLimit >= maximumHebrewBooksResults
      && externalWindow.length >= maximumHebrewBooksResults;
    const nextCursor = otzariaComplete && hebrewBooksComplete
      ? null
      : { otzariaOffset, hebrewBooksOffset, otzariaComplete, hebrewBooksComplete };
    return {
      results: [
        ...native.results.map((hit) => ({
          source: 'otzaria' as const,
          categoryPath: normalizeCategory(hit.categoryPath, otzariaFallbackCategory),
          hit,
        })),
        ...external.map((hit) => ({
          source: 'hebrewbooks' as const,
          categoryPath: hebrewBooksCategories.get(hit.fileId) ?? hebrewBooksFallbackCategory,
          hit,
        })),
      ],
      otzariaTotal: native.total,
      hebrewBooksTotal: external.reduce((total, hit) => total + hit.hitCount, 0),
      truncated: nextCursor !== null || hebrewBooksCapped,
      warnings,
      nextCursor,
    };
  }

  private async resolveHebrewBooksCategories(
    results: HebrewBooksResult[],
    warnings: string[],
  ): Promise<Map<string, string>> {
    if (results.length === 0) return new Map();
    try {
      const mappings = await this.catalog.findBestOtzariaIds(results.map((result) => result.fileId));
      const entries = [...mappings.entries()];
      const books = await this.otzaria.resolveBooks(entries.map(([, id]) => ({ id, source: 'library' })));
      const categories = new Map<string, string>();
      entries.forEach(([fileId], index) => {
        const category = books[index]?.categoryPath;
        if (category) categories.set(fileId, normalizeCategory(category, hebrewBooksFallbackCategory));
      });
      return categories;
    } catch (error) {
      warnings.push(`שיוך הקטגוריות של היברובוקס נכשל: ${messageOf(error)}`);
      return new Map();
    }
  }
}

export function mergeUnifiedSearchResponses(
  current: UnifiedSearchResponse,
  page: UnifiedSearchResponse,
): UnifiedSearchResponse {
  const results = new Map<string, UnifiedSearchResult>();
  for (const result of [...current.results, ...page.results]) {
    results.set(unifiedResultKey(result), result);
  }
  const mergedResults = [...results.values()];
  return {
    results: mergedResults,
    otzariaTotal: Math.max(current.otzariaTotal, page.otzariaTotal),
    hebrewBooksTotal: mergedResults.reduce(
      (total, result) => total + (result.source === 'hebrewbooks' ? result.hit.hitCount : 0),
      0,
    ),
    truncated: page.truncated,
    warnings: [...new Set([...current.warnings, ...page.warnings])],
    nextCursor: page.nextCursor,
  };
}

export function toHebrewBooksSnapshot(request: HostSearchRequest): SearchSnapshot {
  const options: SearchOptions = {
    // אוצריא משתמשת ב־0 למילים סמוכות; hbsearch דורש מספר חיובי.
    proximity: Math.max(1, request.distance ?? 0),
    fuzziness: request.mode === 'fuzzy' ? Math.min(2, request.distance ?? 2) : 0,
    max: 500,
    limit: Math.min(500, Math.max(1, request.limit ?? 100)),
    sort: 'hitcount',
    corpus: ['pdf'],
    compactCharClass: true,
    hybur: optionEnabled(request.wordOptions, 'קידומות דקדוקיות'),
    roots: false,
    gematria: false,
    spelling: optionEnabled(request.wordOptions, 'כתיב מלא/חסר'),
    numberGender: false,
    aramaic: optionEnabled(request.wordOptions, 'תרגום ארמי'),
    rashetevot: optionEnabled(request.wordOptions, 'ראשי תיבות'),
    firstWord: false,
    lastWord: false,
    requireWordOrder: true,
    rashiOcr: false,
  };
  return {
    query: request.query.trim(),
    options,
    fingerprint: `${request.query.trim()}\u0000${JSON.stringify(options)}`,
  };
}

function optionEnabled(
  wordOptions: Record<string, Record<string, boolean>> | undefined,
  option: string,
): boolean {
  return Object.values(wordOptions ?? {}).some((word) => word[option] === true);
}

function initialCursor(request: HostSearchRequest): UnifiedSearchCursor {
  return {
    otzariaOffset: Math.max(0, request.offset ?? 0),
    hebrewBooksOffset: 0,
    otzariaComplete: false,
    hebrewBooksComplete: false,
  };
}

function normalizePageSize(limit: number | undefined): number {
  return Math.min(500, Math.max(1, limit ?? 100));
}

function unifiedResultKey(result: UnifiedSearchResult): string {
  if (result.source === 'hebrewbooks') return `hebrewbooks:${result.hit.fileId}`;
  const hit = result.hit;
  return `otzaria:${hit.id ?? ''}:${hit.bookId ?? ''}:${hit.index}:${hit.reference}`;
}

function normalizeCategory(categoryPath: string | null | undefined, fallback: string): string {
  const value = categoryPath?.trim().replace(/^\/+|\/+$/g, '');
  return value ? `/${value}` : fallback;
}

function emptyOtzariaResponse(): OtzariaSearchResponse {
  return { results: [], total: 0, groupCount: null, truncated: false, limit: 0, offset: 0, facets: [] };
}

async function collectOtzariaSearch(
  chunks: AsyncIterable<OtzariaSearchChunk>,
  limit: number,
  offset: number,
  onUpdate?: (response: OtzariaSearchResponse) => boolean | void,
): Promise<OtzariaSearchResponse> {
  const response: OtzariaSearchResponse = {
    ...emptyOtzariaResponse(),
    limit,
    offset,
  };
  for await (const chunk of chunks) {
    response.results.push(...chunk.results);
    response.total = chunk.total ?? response.total;
    response.groupCount = chunk.groupCount ?? response.groupCount;
    response.truncated = chunk.truncated;
    response.limit = chunk.limit;
    response.offset = chunk.offset;
    response.facets = chunk.facets;
    if (
      onUpdate?.({
        ...response,
        results: [...response.results],
        facets: [...response.facets],
      }) === false
    ) {
      break;
    }
  }
  return response;
}

function partialUnifiedResponse(
  native: OtzariaSearchResponse,
  hebrewBooks: readonly HebrewBooksResult[],
): UnifiedSearchResponse {
  return {
    results: [
      ...native.results.map((hit) => ({
        source: 'otzaria' as const,
        categoryPath: normalizeCategory(hit.categoryPath, otzariaFallbackCategory),
        hit,
      })),
      ...hebrewBooks.map((hit) => ({
        source: 'hebrewbooks' as const,
        categoryPath: hebrewBooksFallbackCategory,
        hit,
      })),
    ],
    otzariaTotal: native.total,
    hebrewBooksTotal: hebrewBooks.reduce((total, hit) => total + hit.hitCount, 0),
    truncated: false,
    warnings: [],
    nextCursor: null,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'שגיאה לא צפויה';
}
