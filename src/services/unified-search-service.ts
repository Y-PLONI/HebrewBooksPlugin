import type {
  HebrewBooksResult,
  HostBookIdentity,
  HostSearchRequest,
  OtzariaSearchResponse,
  ResolvedBook,
  SearchOptions,
  SearchSnapshot,
  UnifiedSearchResponse,
} from '../models';

const hebrewBooksFallbackCategory = 'ספרי היברובוקס';
const otzariaFallbackCategory = 'ספרי אוצריא';

interface HebrewBooksSearchSource {
  search(snapshot: SearchSnapshot): Promise<HebrewBooksResult[]>;
}

interface OtzariaSearchSource {
  search(request: HostSearchRequest): Promise<OtzariaSearchResponse>;
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

  async search(request: HostSearchRequest): Promise<UnifiedSearchResponse> {
    const snapshot = toHebrewBooksSnapshot(request);
    const [otzariaResult, hebrewBooksResult] = await Promise.allSettled([
      this.otzaria.search(request),
      this.hebrewBooks.search(snapshot),
    ]);
    const warnings: string[] = [];
    const native = otzariaResult.status === 'fulfilled' ? otzariaResult.value : emptyOtzariaResponse();
    const external = hebrewBooksResult.status === 'fulfilled' ? hebrewBooksResult.value : [];
    if (otzariaResult.status === 'rejected') warnings.push(`החיפוש באוצריא נכשל: ${messageOf(otzariaResult.reason)}`);
    if (hebrewBooksResult.status === 'rejected') {
      warnings.push(`החיפוש בהיברובוקס נכשל: ${messageOf(hebrewBooksResult.reason)}`);
    }
    if (otzariaResult.status === 'rejected' && hebrewBooksResult.status === 'rejected') {
      throw new Error(warnings.join('\n'));
    }

    const hebrewBooksCategories = await this.resolveHebrewBooksCategories(external, warnings);
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
      truncated: native.truncated || external.length >= snapshot.options.limit,
      warnings,
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

export function toHebrewBooksSnapshot(request: HostSearchRequest): SearchSnapshot {
  const options: SearchOptions = {
    proximity: Math.max(0, request.distance ?? 0),
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

function normalizeCategory(categoryPath: string | null | undefined, fallback: string): string {
  const value = categoryPath?.trim().replace(/^\/+|\/+$/g, '');
  return value ? `/${value}` : fallback;
}

function emptyOtzariaResponse(): OtzariaSearchResponse {
  return { results: [], total: 0, groupCount: null, truncated: false, limit: 0, offset: 0, facets: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'שגיאה לא צפויה';
}
