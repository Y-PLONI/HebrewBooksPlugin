import type {
  HebrewBooksResult,
  HebrewBooksSearchPage,
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
import { clampProximity } from '../models';

const hebrewBooksFallbackCategory = 'ספרי היברובוקס';
const otzariaFallbackCategory = 'ספרי אוצריא';
const maximumHebrewBooksResults = 10_000;

interface HebrewBooksSearchSource {
  search(
    snapshot: SearchSnapshot,
    onUpdate?: (page: HebrewBooksSearchPage) => boolean | void,
    signal?: AbortSignal,
    offset?: number,
  ): Promise<HebrewBooksSearchPage>;
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
    const snapshot = toHebrewBooksSnapshot({ ...request, limit: pageSize });
    const cancellation = new AbortController();
    if (signal?.aborted) cancellation.abort();
    else signal?.addEventListener('abort', () => cancellation.abort(), { once: true });
    let partialNative = { ...emptyOtzariaResponse(), limit: pageSize, offset: cursor.otzariaOffset };
    let partialHebrewBooks = emptyHebrewBooksPage();
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
        ? Promise.resolve<HebrewBooksSearchPage | null>(null)
        : this.hebrewBooks.search(
            snapshot,
            (page) => {
              partialHebrewBooks = page;
              return publish();
            },
            cancellation.signal,
            cursor.hebrewBooksOffset,
          ),
    ]);
    if (cancellation.signal.aborted) {
      return partialUnifiedResponse(partialNative, partialHebrewBooks);
    }
    const warnings: string[] = [];
    const native = otzariaResult.status === 'fulfilled'
      ? otzariaResult.value ?? emptyOtzariaResponse()
      : emptyOtzariaResponse();
    const externalPage = hebrewBooksResult.status === 'fulfilled'
      ? hebrewBooksResult.value ?? emptyHebrewBooksPage()
      : emptyHebrewBooksPage();
    const external = externalPage.results;
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
      || hebrewBooksOffset >= externalPage.totalBooks;
    const hebrewBooksCapped = externalPage.truncated;
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
      hebrewBooksTotal: externalPage.totalHits,
      totalIsLowerBound: hebrewBooksCapped,
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
    hebrewBooksTotal: Math.max(current.hebrewBooksTotal, page.hebrewBooksTotal),
    totalIsLowerBound: current.totalIsLowerBound === true || page.totalIsLowerBound === true,
    truncated: page.truncated,
    warnings: [...new Set([...current.warnings, ...page.warnings])],
    nextCursor: page.nextCursor,
  };
}

/// מפת אפשרויות גלובלית מאירוע של המארח מגיעה כ-JSON חופשי; מוחזרת רק
/// כשצורתה תקינה (אובייקט שטוח), עם ערכי true בלבד — אחרת undefined.
export function sanitizedGlobalOptions(raw: unknown): Record<string, boolean> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const sanitized: Record<string, boolean> = {};
  for (const [option, enabled] of Object.entries(raw as Record<string, unknown>)) {
    if (enabled === true) sanitized[option] = true;
  }
  return sanitized;
}

/// מפת wordOptions מאירוע של המארח מגיעה כ-JSON חופשי; מוחזרת רק כשצורתה
/// תקינה (אובייקט של אובייקטים), אחרת undefined — כאילו לא נשלחה.
export function sanitizedWordOptions(
  raw: unknown,
): Record<string, Record<string, boolean>> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>);
  const sanitized: Record<string, Record<string, boolean>> = {};
  for (const [word, options] of entries) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) return undefined;
    const wordEntry: Record<string, boolean> = {};
    for (const [option, enabled] of Object.entries(options as Record<string, unknown>)) {
      if (enabled === true) wordEntry[option] = true;
    }
    sanitized[word] = wordEntry;
  }
  return sanitized;
}

export function toHebrewBooksSnapshot(request: HostSearchRequest): SearchSnapshot {
  const options: SearchOptions = {
    // אוצריא משתמשת ב־0 למילים סמוכות; hbsearch דורש מספר חיובי ואינו כופה
    // תקרה, ולכן חוסמים ב־maximumProximity (הטווח שהשירות תומך בו בפועל).
    proximity: clampProximity(request.distance ?? 0),
    fuzziness: request.mode === 'fuzzy' ? Math.min(2, request.distance ?? 2) : 0,
    max: maximumHebrewBooksResults,
    limit: Math.min(500, Math.max(1, request.limit ?? 100)),
    sort: 'hitcount',
    corpus: ['pdf'],
    compactCharClass: true,
    // רק אפשרויות שקיימות בשני המנועים מועברות ל-HebrewBooks.
    hybur: sharedOptionEnabled(request, 'קידומות דקדוקיות'),
    roots: false,
    gematria: false,
    spelling: sharedOptionEnabled(request, 'כתיב מלא/חסר'),
    numberGender: false,
    aramaic: sharedOptionEnabled(request, 'תרגום ארמי'),
    rashetevot: sharedOptionEnabled(request, 'ראשי תיבות'),
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

function sharedOptionEnabled(request: HostSearchRequest, option: string): boolean {
  const words = request.query.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((word, index) => {
    // ב-SDK של אוצריא מפת wordOptions מחליפה את options עבור אותה מילה,
    // ולא מתמזגת בה. HebrewBooks תומך באפשרות לכל השאילתה בלבד, ולכן
    // מפעילים אותה רק אם היא פעילה באופן זהה בכל מילות השאילתה.
    const effectiveOptions = request.wordOptions?.[`${word}_${index}`] ?? request.options;
    return effectiveOptions?.[option] === true;
  });
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
  hebrewBooks: HebrewBooksSearchPage,
): UnifiedSearchResponse {
  return {
    results: [
      ...native.results.map((hit) => ({
        source: 'otzaria' as const,
        categoryPath: normalizeCategory(hit.categoryPath, otzariaFallbackCategory),
        hit,
      })),
      ...hebrewBooks.results.map((hit) => ({
        source: 'hebrewbooks' as const,
        categoryPath: hebrewBooksFallbackCategory,
        hit,
      })),
    ],
    otzariaTotal: native.total,
    hebrewBooksTotal: hebrewBooks.totalHits,
    totalIsLowerBound: hebrewBooks.truncated,
    truncated: hebrewBooks.truncated,
    warnings: [],
    nextCursor: null,
  };
}

function emptyHebrewBooksPage(): HebrewBooksSearchPage {
  return { results: [], totalBooks: 0, totalHits: 0, truncated: false };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'שגיאה לא צפויה';
}
