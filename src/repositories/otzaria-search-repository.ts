import type { HostBridge } from '../bridge';
import { requireHostData } from '../bridge';
import { hebrewBooksProvider, otzariaDistanceForProximity } from '../models';
import { honouredExpansions } from '../search-option-support';
import type {
  ExternalSearchIndexEntry,
  ExternalSearchResultPayload,
  HostBookIdentity,
  HostSearchMode,
  HostSearchRequest,
  OtzariaSearchChunk,
  OtzariaSearchHit,
  ResolvedBook,
  SearchOptions,
} from '../models';

/// הקוד שאוצריא מחזירה כשתשובה מתייחסת לבקשה שכבר אינה פתוחה אצלה.
const hostRequestGoneCode = 'error.not_found';

/// אוצריא דחתה עדכון כי הבקשה כבר אינה פתוחה אצלה — טאב החיפוש שביקש
/// אותה נסגר, החליף אותה בבקשה חדשה, או פג. אין אירוע ביטול במקומה, ולכן
/// זו האינדיקציה היחידה שהעבודה שרצה בשרת כבר אינה מעניינת איש.
export class HostRequestGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostRequestGoneError';
  }
}

export class OtzariaSearchRepository {
  constructor(private readonly bridge: HostBridge) {}

  async *search(
    request: HostSearchRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OtzariaSearchChunk> {
    const stream = this.bridge.call('search.query', {
      ...request,
      includeBookCounts: false,
    });
    const iterator = stream[Symbol.asyncIterator]();
    let finished = false;
    const cancel = (): void => {
      const cancellation = iterator.return?.();
      if (cancellation) void cancellation.catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) return;
      while (!signal?.aborted) {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          break;
        }
        yield parseSearchChunk(next.value);
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (!finished) await iterator.return?.();
    }
  }

  /// נתיב הקטגוריה בעץ הספרייה לכל מזהה ספר אוצריא, מיושר לסדר הקלט —
  /// מסלול bulk (עד 20K מזהים בקריאה אחת) לסיווג אינדקס תוצאות שלם.
  async resolveCategoryPaths(ids: number[]): Promise<Array<string | null>> {
    if (ids.length === 0) return [];
    const paths = await requireHostData<unknown[]>(this.bridge, 'library.resolveCategoryPaths', { ids });
    if (!Array.isArray(paths) || paths.length !== ids.length) {
      throw new Error('אוצריא החזירה נתיבי קטגוריות לא תקינים');
    }
    return paths.map(optionalString);
  }

  async resolveBooks(identities: HostBookIdentity[]): Promise<Array<ResolvedBook | null>> {
    if (identities.length === 0) return [];
    const chunks = chunk(identities, 100);
    const resolved = await Promise.all(
      chunks.map((items) => requireHostData<unknown[]>(this.bridge, 'library.resolveBooks', { items })),
    );
    return resolved.flat().map(parseResolvedBook);
  }

  async openBook(
    identity: HostBookIdentity,
    index: number,
    searchQuery: string,
    matches?: { pages: number[]; matchedTerms: string[] },
  ): Promise<boolean> {
    return requireHostData<boolean>(this.bridge, 'reader.openBook', {
      ...identity,
      index,
      searchQuery,
      navigateToPositionIfReused: true,
      ...(matches && matches.pages.length > 0
        ? { matchPages: matches.pages, matchedTerms: matches.matchedTerms }
        : {}),
    });
  }

  /// רושם את התוסף כספק חיפוש-בתוך-ספר לספרי היברובוקס — הקורא המובנה של
  /// אוצריא ישלח אלינו אירועי reader.inBookSearch.requested.
  async registerInBookSearchProvider(): Promise<void> {
    await requireHostData<boolean>(this.bridge, 'reader.registerInBookSearchProvider', {
      provider: hebrewBooksProvider,
    });
  }

  async respondInBookSearch(
    requestId: string,
    result: { pages: number[]; matchedTerms: string[]; query: string } | { error: string },
  ): Promise<void> {
    await requireHostData<boolean>(this.bridge, 'reader.respondInBookSearch', {
      requestId,
      ...result,
    });
  }

  /// פותח כרטיסיית חיפוש מובנית באוצריא עם שורת ההיברובוקס מסומנת —
  /// התוצאות יוצגו שם דרך ספק התוצאות החיצוני. הגדרות הדיאלוג עוברות רק
  /// בתוך `settings` — המארח מתעלם משדות אחרים ופותח במרווח 0.
  async openSearchTab(query: string, options?: SearchOptions): Promise<void> {
    await requireHostData<boolean>(this.bridge, 'reader.openSearchTab', {
      query,
      selectItems: ['include-hebrewbooks'],
      ...(options ? { settings: otzariaTabSettings(options) } : {}),
    });
  }

  /// רושם את התוסף כספק תוצאות חיצוני לטאב החיפוש המובנה — אוצריא תשלח
  /// אלינו אירועי search.external.requested במקום לפתוח את מסך התוסף.
  async registerExternalSearchProvider(): Promise<void> {
    await requireHostData<boolean>(this.bridge, 'reader.registerExternalSearchProvider', {
      provider: hebrewBooksProvider,
    });
  }

  /// `done: false` — עדכון חלקי תוך כדי הזרמת החיפוש; הבקשה נשארת פתוחה
  /// בצד אוצריא והמדור מתעדכן חי. ללא השדה התשובה נחשבת סופית.
  async respondExternalSearch(
    requestId: string,
    result:
      | {
          results: ExternalSearchResultPayload[];
          totalBooks: number;
          totalHits: number;
          hasMore: boolean;
          done?: boolean;
          /// אינדקס כלל התוצאות (עמוד ראשון בלבד) לבניית עץ הקטגוריות.
          index?: ExternalSearchIndexEntry[];
        }
      | { error: string },
  ): Promise<void> {
    // לא דרך requireHostData: הקוד `error.not_found` הוא ההודעה היחידה
    // שאוצריא מוסרת על בקשה שאינה פתוחה אצלה עוד, והוא נבלע כשהשגיאה
    // מצטמצמת לטקסט. הקורא צריך להבדיל בינו לבין תקלה חולפת.
    const response = await this.bridge.call<boolean>('reader.respondExternalSearch', {
      requestId,
      ...result,
    });
    if (response.success && response.data !== null) return;
    const message = response.error?.message ?? 'הפעולה reader.respondExternalSearch נכשלה';
    if (response.error?.code === hostRequestGoneCode) throw new HostRequestGoneError(message);
    throw new Error(message);
  }
}

function parseSearchChunk(value: unknown): OtzariaSearchChunk {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error('אוצריא החזירה תשובת חיפוש לא תקינה');
  }
  return {
    sequence: nonNegativeInteger(value.sequence, 'sequence'),
    results: value.results.map(parseSearchHit),
    total: value.total === null ? null : nonNegativeInteger(value.total, 'total'),
    groupCount: value.groupCount === null ? null : nonNegativeInteger(value.groupCount, 'groupCount'),
    truncated: value.truncated === true,
    limit: nonNegativeInteger(value.limit, 'limit'),
    offset: nonNegativeInteger(value.offset, 'offset'),
    facets: Array.isArray(value.facets)
      ? value.facets.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function parseSearchHit(value: unknown): OtzariaSearchHit {
  if (
    !isRecord(value) ||
    typeof value.book !== 'string' ||
    typeof value.reference !== 'string' ||
    typeof value.text !== 'string'
  ) {
    throw new Error('אוצריא החזירה תוצאת חיפוש לא תקינה');
  }
  return {
    ...parseIdentity(value),
    book: value.book,
    categoryPath: optionalString(value.categoryPath),
    reference: value.reference,
    text: value.text,
    index: nonNegativeInteger(value.index, 'index'),
    mergedCount: nonNegativeInteger(value.mergedCount, 'mergedCount'),
  };
}

function parseResolvedBook(value: unknown): ResolvedBook | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.title !== 'string') {
    throw new Error('אוצריא החזירה זהות ספר לא תקינה');
  }
  return {
    ...parseIdentity(value),
    title: value.title,
    categoryPath: optionalString(value.categoryPath),
  };
}

function parseIdentity(value: Record<string, unknown>): HostBookIdentity {
  const identity: HostBookIdentity = {};
  if (Number.isInteger(value.id)) identity.id = Number(value.id);
  if (typeof value.bookId === 'string') identity.bookId = value.bookId;
  if (typeof value.type === 'string') identity.type = value.type as HostBookIdentity['type'];
  if (typeof value.source === 'string') identity.source = value.source as HostBookIdentity['source'];
  if (isRecord(value.external) && typeof value.external.provider === 'string') {
    const id = value.external.id;
    if (typeof id === 'string' || Number.isInteger(id)) {
      identity.external = {
        provider: value.external.provider as 'hebrewbooks' | 'otzar',
        id: id as number | string,
      };
    }
  }
  return identity;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`אוצריא החזירה ${field} לא תקין`);
  }
  return Number(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/// מרחק העריכה המרבי של חיפוש מקורב באוצריא (kMaxFuzzyDistance).
const maximumOtzariaFuzziness = 2;

/// המקורות שתוצאותיהם ניתנות לפתיחה בטאב החיפוש של אוצריא. המדור החיצוני
/// פותח ספר לפי מזהה היברובוקס מספרי, וב"ספרי טקסט" ובמאגר האישי ה-fileId
/// הוא נתיב יחסי — הוא נושר מהאינדקס ומהעמוד, והספר לעולם אינו מוצג.
export const otzariaOpenableCorpus: SearchOptions['corpus'] = ['pdf'];

/// בחירת המקורות של המשתמש מצומצמת למה שהטאב יודע לפתוח.
export function otzariaTabCorpus(corpus: SearchOptions['corpus']): SearchOptions['corpus'] {
  return corpus.filter((source) => otzariaOpenableCorpus.includes(source));
}

const corpusLabels: Record<SearchOptions['corpus'][number], string> = {
  pdf: 'ספרים סרוקים',
  otzraya: 'ספרי טקסט',
  personal: 'אוסף אישי',
};

/// מה שטאב החיפוש של אוצריא אינו יכול לכבד כלל — הסבר בעברית, או null
/// כשהטאב מסוגל להריץ את החיפוש. חיפוש חסום רץ במסך התוצאות של התוסף.
export function otzariaTabBlocker(options: SearchOptions): string | null {
  // שורת ההיברובוקס מוגדרת visibleInModes: exact/advanced, ולכן בטאב מקורב
  // המדור החיצוני כלל אינו נשאל והמשתמש היה מקבל טאב בלי תוצאות היברובוקס.
  if (options.fuzziness > 0) {
    return 'חיפוש מקורב אינו זמין בטאב החיפוש של אוצריא; החיפוש רץ במסך התוסף.';
  }
  const dropped = options.corpus.filter((source) => !otzariaOpenableCorpus.includes(source));
  if (dropped.length > 0) {
    const names = dropped.map((source) => corpusLabels[source]).join(' ו');
    return `${names} אינם נפתחים מטאב החיפוש של אוצריא; החיפוש רץ במסך התוסף.`;
  }
  return null;
}

export interface OtzariaTabSettings {
  mode: HostSearchMode;
  distance: number;
  options?: Record<string, boolean>;
}

/// מצב החיפוש של אוצריא המייצג את בחירת הדיאלוג: רמת קירוב גוברת על הכול,
/// והרחבות מחייבות "מתקדם" — תרגום ארמי וראשי תיבות קיימים שם בלבד.
export function otzariaSearchMode(options: SearchOptions): HostSearchMode {
  if (options.fuzziness > 0) return 'fuzzy';
  return honouredExpansions.some((option) => options[option.key]) ? 'advanced' : 'exact';
}

/// המפתחות שאוצריא מקבלת ב-`settings`; כל מפתח אחר נדחה ב-error.invalid_params.
/// מספר התוצאות והמיון אינם ביניהם — הטאב מדפדף בקצב שלו ואין להם ייצוג.
export const otzariaTabSettingKeys: readonly string[] = [
  'mode',
  'distance',
  'proximityScope',
  'wordMatchMode',
  'wordMatchCount',
  'options',
  'wordOptions',
];

/// הגדרות הדיאלוג ביחידות של אוצריא: המרווח מתורגם כך שהמדור החיצוני יחזיר
/// את אותו proximity, וההרחבות המשותפות לשני המנועים עוברות כאפשרויות גלובליות.
export function otzariaTabSettings(options: SearchOptions): OtzariaTabSettings {
  const mode = otzariaSearchMode(options);
  // במקורב distance הוא מרחק העריכה, ואוצריא דוחה שם כל אפשרות מילה.
  if (mode === 'fuzzy') {
    const fuzziness = Math.round(options.fuzziness);
    return { mode, distance: Math.min(maximumOtzariaFuzziness, Math.max(1, fuzziness)) };
  }
  const shared: Record<string, boolean> = {};
  for (const option of honouredExpansions) {
    if (options[option.key]) shared[option.hostKey] = true;
  }
  return {
    mode,
    distance: otzariaDistanceForProximity(options.proximity),
    ...(Object.keys(shared).length > 0 ? { options: shared } : {}),
  };
}
