export type SourceType = 'PDF' | 'Text' | 'Personal';

export interface SearchOptions {
  proximity: number;
  fuzziness: number;
  max: number;
  limit: number;
  sort: 'hitcount' | 'bookname' | 'author' | 'place' | 'year' | 'id';
  corpus: Array<'pdf' | 'otzraya' | 'personal'>;
  compactCharClass: boolean;
  hybur: boolean;
  roots: boolean;
  gematria: boolean;
  spelling: boolean;
  numberGender: boolean;
  aramaic: boolean;
  rashetevot: boolean;
  firstWord: boolean;
  lastWord: boolean;
  requireWordOrder: boolean;
  rashiOcr: boolean;
}

export interface SearchSnapshot {
  query: string;
  options: SearchOptions;
  fingerprint: string;
}

export interface HebrewBooksResult {
  fileId: string;
  bookName: string;
  authorName: string | null;
  printPlace: string | null;
  printYear: string | null;
  countPage: number | null;
  categories: string | null;
  sourceType: SourceType;
  relativePath: string | null;
  hitCount: number;
}

export interface InBookLocations {
  hitCount: number;
  pages: number[];
  matchedTerms: string[];
}

export interface HealthStatus {
  kind: 'onlineLegacy' | 'onlineFull';
  serverVersion: string | null;
}

export type HostSearchMode = 'exact' | 'advanced' | 'fuzzy';

export interface HostBookIdentity {
  id?: number | null;
  bookId?: string;
  type?: 'text' | 'pdf' | 'docx' | 'epub' | 'external' | null;
  source?: 'library' | 'user' | 'external' | null;
  external?: { provider: 'hebrewbooks' | 'otzar'; id: number | string };
}

export interface HostSearchRequest {
  query: string;
  negativeQuery?: string;
  mode?: HostSearchMode;
  order?: 'relevance' | 'catalogue' | 'generation';
  limit?: number;
  offset?: number;
  distance?: number;
  proximityScope?: 'wordDistance' | 'sameParagraph' | 'sameSection';
  grouping?: 'none' | 'sameSection' | 'identicalText';
  wordMatchMode?: 'all' | 'anyWord' | 'mostWords' | 'atLeast';
  wordMatchCount?: number;
  wordOptions?: Record<string, Record<string, boolean>>;
  alternativeWords?: Record<string, string[]>;
  customSpacing?: Record<string, string>;
  negativeWordOptions?: Record<string, Record<string, boolean>>;
  negativeAlternativeWords?: Record<string, string[]>;
  negativeCustomSpacing?: Record<string, string>;
  facets?: string[];
}

export interface HostSearchRequestedEvent {
  itemId: string;
  request: HostSearchRequest;
}

export interface OtzariaSearchHit extends HostBookIdentity {
  book: string;
  categoryPath: string | null;
  reference: string;
  text: string;
  index: number;
  mergedCount: number;
}

export interface OtzariaSearchResponse {
  results: OtzariaSearchHit[];
  total: number;
  groupCount: number | null;
  truncated: boolean;
  limit: number;
  offset: number;
  facets: string[];
}

export interface ResolvedBook extends HostBookIdentity {
  title: string;
  categoryPath: string | null;
}

export type UnifiedSearchResult =
  | {
      source: 'otzaria';
      categoryPath: string;
      hit: OtzariaSearchHit;
    }
  | {
      source: 'hebrewbooks';
      categoryPath: string;
      hit: HebrewBooksResult;
    };

export interface UnifiedSearchCursor {
  otzariaOffset: number;
  hebrewBooksOffset: number;
  otzariaComplete: boolean;
  hebrewBooksComplete: boolean;
}

export interface UnifiedSearchResponse {
  results: UnifiedSearchResult[];
  otzariaTotal: number;
  hebrewBooksTotal: number;
  truncated: boolean;
  warnings: string[];
  nextCursor: UnifiedSearchCursor | null;
}

export const defaultSearchOptions: SearchOptions = {
  proximity: 30,
  fuzziness: 0,
  max: 500,
  limit: 100,
  sort: 'hitcount',
  corpus: ['pdf'],
  compactCharClass: true,
  hybur: false,
  roots: false,
  gematria: false,
  spelling: false,
  numberGender: false,
  aramaic: false,
  rashetevot: false,
  firstWord: false,
  lastWord: false,
  requireWordOrder: false,
  rashiOcr: false,
};
