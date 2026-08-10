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
