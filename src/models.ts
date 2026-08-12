export type SourceType = 'PDF' | 'Text' | 'Personal';

/// גבולות "מרחק בין מילים" (proximity). hbsearch דוחה כל ערך שאינו מספר שלם
/// חיובי (400 עם "expects a positive integer") אך אינו כופה תקרה — proximity
/// גדול פשוט מרחיב את חלון החיפוש בלי הגבלה. הטווח הנתמך בפועל, וזה שה־GUI
/// של השירות מרשה, הוא 1–30; מעליו התוצאות אינן "מרווח בין מילים" אלא הופעה
/// מקרית באותו אזור. לכן התוסף חוסם ב־30 בשני מקומות: בדיאלוג האפשרויות
/// ובתרגום בקשת החיפוש של אוצריא.
export const minimumProximity = 1;
export const maximumProximity = 30;

export function clampProximity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return minimumProximity;
  return Math.min(Math.max(Math.round(value), minimumProximity), maximumProximity);
}

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
  firstHitPage: number | null;
}

export interface HebrewBooksSearchPage {
  results: HebrewBooksResult[];
  totalBooks: number;
  totalHits: number;
  truncated: boolean;
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
  /** אפשרויות החלות על כל מילות השאילתה; wordOptions גובר עליהן לכל מילה. */
  options?: Record<string, boolean>;
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

/// בקשת חיפוש-בתוך-ספר מהקורא המובנה של אוצריא (התוסף רשום כספק).
export interface InBookSearchRequestedEvent {
  requestId: string;
  provider: string;
  externalId: number | string;
  query: string;
}

/// בקשת עמוד תוצאות ממסך החיפוש המובנה של אוצריא (התוסף רשום כספק
/// תוצאות חיצוני עם registerExternalSearchProvider).
///
/// כש-[ids] נשלח, העמוד המבוקש הוא הספרים הללו בסדרם (מתוך תוצאות החיפוש
/// שבמטמון) — כך אוצריא מדפדפת בתוצאות מסוננות-קטגוריה שהיא חישבה מהאינדקס.
export interface ExternalSearchRequestedEvent {
  requestId: string;
  provider: string;
  query: string;
  mode?: HostSearchMode;
  distance?: number;
  offset?: number;
  limit?: number;
  ids?: unknown;
}

/// שורת תוצאה במדור החיצוני של טאב החיפוש המובנה.
export interface ExternalSearchResultPayload {
  title: string;
  meta?: string;
  snippet?: string;
  hitCount: number;
  firstPage?: number;
  externalId: number;
}

/// רשומת אינדקס בתשובה לחיפוש חיצוני: כלל התוצאות בתמצות — מזהה, מספר
/// מופעים, וקטגוריית אוצריא המשוערת לפי תגיות הקטלוג של היברובוקס (אם יש).
/// מיוצג כמערך כדי לחסוך בגודל: [id, hits] או [id, hits, category].
export type ExternalSearchIndexEntry = [number, number] | [number, number, string];

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

export type OtzariaSearchChunk = Omit<OtzariaSearchResponse, 'total'> & {
  sequence: number;
  total: number | null;
};

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
  totalIsLowerBound?: boolean;
  truncated: boolean;
  warnings: string[];
  nextCursor: UnifiedSearchCursor | null;
}

export const defaultSearchOptions: SearchOptions = {
  proximity: 30,
  fuzziness: 0,
  max: 10_000,
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
