import type { HostBridge } from '../bridge';
import { hebrewBooksProvider } from '../models';
import type {
  ExternalSearchIndexEntry,
  ExternalSearchRequestedEvent,
  ExternalSearchResultPayload,
  HebrewBooksResult,
  HebrewBooksSearchPage,
  InBookLocations,
  InBookSearchRequestedEvent,
  SearchOptions,
  SearchSnapshot,
} from '../models';
import { defaultSearchOptions } from '../models';
import type { CatalogMappingRepository } from '../repositories/catalog-mapping-repository';
import type { HebrewBooksRepository } from '../repositories/hebrewbooks-repository';
import type { OtzariaSearchRepository } from '../repositories/otzaria-search-repository';
import { HostRequestGoneError } from '../repositories/otzaria-search-repository';
import { externalIdOf } from '../utils/personal-id';
import { mapHebrewBooksCategory } from './hb-category-mapper';
import {
  sanitizedGlobalOptions,
  sanitizedMatchPolicy,
  sanitizedWordOptions,
  toHebrewBooksSnapshot,
} from './unified-search-service';

/// תקרת הזמן הכוללת להזרמת קטעי הטקסט למדור החיצוני, קצב העדכונים החלקיים,
/// ומספר הקטעים הנטענים במקביל (איתור עמוד ב-/inbook + חילוץ מה-PDF).
/// מקביליות 2 ולא 3: הגשר של אוצריא מתיר עד 4 זרמי רשת פעילים לתוסף, וזרם
/// חיפוש של בקשה קודמת עשוי עוד להיות חי — 2 קריאות /inbook + 2 זרמי חיפוש
/// נשארים בתקרה, בעוד 3 היו מפילים את איתור העמודים על error.rate_limited.
const snippetsDeadlineMs = 25_000;
const snippetFlushIntervalMs = 400;
const snippetConcurrency = 2;

/// חילוץ קטע טקסט מעמוד PDF. prepare מאפשר למחלץ שנטען בעצלתיים להודיע
/// מראש שאינו זמין, לפני שמתחילים לאתר עבורו עמודים ב-/inbook.
export interface SnippetSource {
  load(url: string, fileId: string, pageNumber: number | null, query: string): Promise<string | null>;
  prepare?(): Promise<boolean>;
}

export interface ExternalSearchServerDeps {
  readonly repository: HebrewBooksRepository;
  readonly otzaria: OtzariaSearchRepository;
  readonly catalogMapping: CatalogMappingRepository;
  readonly snippets?: SnippetSource | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/// מריץ את [task] על כל פריט במקביליות מוגבלת, בסדר התור המקורי.
async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length && shouldContinue()) {
        const index = next++;
        const item = items[index];
        if (item === undefined) continue;
        await task(item, index).catch(() => undefined);
      }
    },
  );
  await Promise.all(workers);
}

/// מזהי עמוד מפורשים מבקשת המדור החיצוני — עד 50 מזהים חיוביים.
function parseRequestedIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  const ids = value.filter((id): id is number => Number.isInteger(id) && Number(id) > 0);
  return ids.length === value.length ? ids : null;
}

export function sumHitCounts(results: readonly HebrewBooksResult[]): number {
  return results.reduce((total, result) => total + result.hitCount, 0);
}

export function createFingerprint(query: string, options: SearchOptions): string {
  return `${query}\u0000${JSON.stringify(options)}`;
}

interface ExternalPageTotals {
  totalBooks: number;
  totalHits: number;
  hasMore: boolean;
}

/// null כשאין מזהה מספרי: שרת ישן שולח בספר אישי נתיב יחסי בעברית, ורשומה
/// שנבנית ממנו נושאת NaN שמגיע לאוצריא כ-null ומרעיל את האינדקס כולו.
function toIndexEntry(result: HebrewBooksResult, withTitle: boolean): ExternalSearchIndexEntry | null {
  const id = externalIdOf(result.fileId);
  if (id === null) return null;
  const category = mapHebrewBooksCategory(result.categories);
  if (withTitle) return [id, result.hitCount, category ?? '', result.bookName];
  return category === null ? [id, result.hitCount] : [id, result.hitCount, category];
}

/// התוצאות שאוצריא יכולה לפתוח, לצד המזהה שלפיו תפתח אותן. שורה בלי מזהה
/// כזה נופלת — בדיוק כמו באינדקס — ואינה נשלחת למדור.
function openableResults(
  results: readonly HebrewBooksResult[],
): Array<readonly [number, HebrewBooksResult]> {
  return results.flatMap((result) => {
    const externalId = externalIdOf(result.fileId);
    return externalId === null ? [] : [[externalId, result] as const];
  });
}

/// עמוד למדור החיצוני מתוך כלל התוצאות. הדפדוף והספירות נספרים על התוצאות
/// הניתנות לפתיחה בלבד, אחרת המדור מבטיח ספרים שלעולם לא יוצגו — ועמוד
/// צפוף שומר על כך גם כשהמארח מקדם offset לפי מספר השורות שקיבל.
function externalPage(
  all: readonly HebrewBooksResult[] | null,
  page: HebrewBooksSearchPage,
  offset: number,
  limit: number,
): { entries: Array<readonly [number, HebrewBooksResult]>; totals: ExternalPageTotals } {
  // המטמון מלא בכל מסלול תקין; בלעדיו נשלח העמוד שהתקבל עם ספירות השרת.
  if (all === null) {
    const entries = openableResults(page.results);
    const hasMore = offset + page.results.length < page.totalBooks;
    return { entries, totals: { totalBooks: page.totalBooks, totalHits: page.totalHits, hasMore } };
  }
  const openable = openableResults(all);
  const entries = openable.slice(offset, offset + limit);
  return {
    entries,
    totals: {
      totalBooks: openable.length,
      totalHits: sumHitCounts(openable.map(([, result]) => result)),
      hasMore: offset + entries.length < openable.length,
    },
  };
}

/// אותה רשומה עם נתיב קטגוריה מעודן, בלי לאבד את שם הספר שכבר יושב עליה.
function withCategoryPath(entry: ExternalSearchIndexEntry, path: string): ExternalSearchIndexEntry {
  return entry.length === 4 ? [entry[0], entry[1], path, entry[3]] : [entry[0], entry[1], path];
}

/// מגיש את שני האירועים הממוקדים שאוצריא שולחת לתוסף — חיפוש למדור החיצוני
/// של טאב החיפוש המובנה, וחיפוש בתוך ספר מהקורא. אין כאן מסך ואין DOM, כדי
/// שמופע הרקע (background.html) יוכל לענות עליהם בלי לטעון את ממשק התוסף.
export class ExternalSearchServer {
  private readonly repository: HebrewBooksRepository;
  private readonly otzaria: OtzariaSearchRepository;
  private readonly catalogMapping: CatalogMappingRepository;
  private readonly snippets: SnippetSource | null;

  constructor(deps: ExternalSearchServerDeps) {
    this.repository = deps.repository;
    this.otzaria = deps.otzaria;
    this.catalogMapping = deps.catalogMapping;
    this.snippets = deps.snippets ?? null;
  }

  /// נרשם מיד עם בניית המופע ולא ב-boot: כשאוצריא מעירה את התוסף כדי למסור
  /// אירוע ממוקד, האירוע עלול להגיע לפני ש-boot רץ — מאזין שנרשם רק שם היה
  /// מפספס אותו והבקשה הייתה נופלת בטיימאאוט.
  listen(bridge: HostBridge): void {
    bridge.on('search.external.requested', ((request: ExternalSearchRequestedEvent) => {
      void this.handleExternalSearchRequest(request);
    }) as (payload: never) => void);

    bridge.on('reader.inBookSearch.requested', ((request: InBookSearchRequestedEvent) => {
      void this.handleInBookSearchRequest(request);
    }) as (payload: never) => void);
  }

  /// שני הרישומים יוצאים יחד: מארח ישן שאינו מכיר את ה-API דוחה אותם, וזה
  /// אינו קריטי.
  registerProviders(): Promise<void> {
    return Promise.all([
      this.otzaria.registerInBookSearchProvider().catch(() => undefined),
      this.otzaria.registerExternalSearchProvider().catch(() => undefined),
    ]).then(() => undefined);
  }

  async handleInBookSearchRequest(request: InBookSearchRequestedEvent): Promise<void> {
    if (request?.provider !== hebrewBooksProvider) return;
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    if (!requestId) return;
    try {
      const query = String(request.query ?? '').trim();
      const fileId = String(request.externalId ?? '');
      if (query.length === 0 || query.length > 500 || !/^\d+$/.test(fileId)) {
        throw new Error('בקשת חיפוש בספר אינה תקינה');
      }
      const snapshot: SearchSnapshot = {
        query,
        options: defaultSearchOptions,
        fingerprint: createFingerprint(query, defaultSearchOptions),
      };
      // דרך המטמון: שלב הקטעים של המדור החיצוני כבר איתר את העמודים לרוב
      // הספרים, ולחיצת פתיחה נענית מיידית.
      const locations = await this.locateInBook(snapshot, fileId);
      await this.otzaria.respondInBookSearch(requestId, {
        pages: locations.pages,
        matchedTerms: locations.matchedTerms,
        query,
      });
    } catch (error) {
      await this.otzaria
        .respondInBookSearch(requestId, { error: messageOf(error) })
        .catch(() => undefined);
    }
  }

  /// בקשות שכבר בטיפול: אוצריא משגרת את אותו אירוע שוב אם לא ענינו תוך
  /// 8 שניות (boot של מנוע רקע לוקח יותר), והפעלה כפולה מריצה שני חיפושים
  /// מלאים במקביל — הכפיל גם מחניק את הזרמת הקטעים וגם עונה done מוקדם.
  private readonly inFlightExternalRequests = new Map<string, AbortController>();

  /// עמוד תוצאות למדור החיצוני של טאב החיפוש המובנה. הדפדוף נשען על מטמון
  /// החיפוש של ה-repository (אותו fingerprint), כך שרק העמוד הראשון פונה
  /// לשרת; קטעי הטקסט נטענים במקביל עם תקרת זמן ואינם מעכבים את התשובה.
  async handleExternalSearchRequest(request: ExternalSearchRequestedEvent): Promise<void> {
    if (request?.provider !== hebrewBooksProvider) return;
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    if (!requestId) return;
    if (this.inFlightExternalRequests.has(requestId)) return;
    // המדור המובנה מציג בקשה אחת בכל רגע — בקשה חדשה מייתרת את הקודמות,
    // וביטולן משחרר את זרמי הרשת של הגשר לטובת החיפוש והקטעים הנוכחיים.
    for (const [previousId, controller] of this.inFlightExternalRequests) {
      if (previousId !== requestId) controller.abort();
    }
    const abort = new AbortController();
    this.inFlightExternalRequests.set(requestId, abort);
    try {
      await this.serveExternalSearchRequest(request, requestId, abort.signal);
    } finally {
      this.inFlightExternalRequests.delete(requestId);
    }
  }

  /// אוצריא אינה שולחת אירוע ביטול כשטאב החיפוש נסגר: הבקשה נשארת "פתוחה"
  /// אצלה והתוסף ממשיך להזרים לתוך מדור שכבר אינו קיים. הסימן היחיד שהיא
  /// בכל זאת מוסרת הוא דחיית עדכון חלקי ב-error.not_found — וכל עוד הוא
  /// נבלע, החיפוש ממשיך לרוץ בשירות עד סופו והכונן ממשיך לעבוד. לכן דחייה
  /// כזו מבטלת כאן את הבקשה, והביטול שולח POST /search/cancel לשירות.
  /// שגיאה אחרת (תקלה חולפת בגשר) אינה מבטלת דבר.
  private abandonIfHostDropped(requestId: string, error: unknown): void {
    if (!(error instanceof HostRequestGoneError)) return;
    this.inFlightExternalRequests.get(requestId)?.abort();
  }

  private async serveExternalSearchRequest(
    request: ExternalSearchRequestedEvent,
    requestId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let partialChain: Promise<void> = Promise.resolve();
    try {
      const query = String(request.query ?? '').trim();
      if (query.length === 0 || query.length > 500) {
        throw new Error('בקשת החיפוש אינה תקינה');
      }
      const offset = clampInteger(request.offset, 0, 100_000, 0);
      const limit = clampInteger(request.limit, 1, 50, 20);
      const ids = parseRequestedIds(request.ids);
      const snapshot = toHebrewBooksSnapshot({
        query,
        mode: request.mode,
        distance: request.distance,
        ...sanitizedMatchPolicy(request.proximityScope, request.wordMatchMode, request.wordMatchCount),
        limit,
        // אפשרויות הטאב — מהן נגזרות קידומות דקדוקיות, כתיב מלא/חסר וכו'.
        // options (הגלובלית) חיונית: מפתחות wordOptions נבנים בטוקניזציה
        // של מנוע אוצריא (מקף מפצל מילה) ועלולים לא להתאים לפירוק שלנו.
        // מארח ותיק אינו שולח אף אחת מהן, וההרחבות נשארות כבויות.
        options: sanitizedGlobalOptions(request.options),
        wordOptions: sanitizedWordOptions(request.wordOptions),
      });

      if (ids) {
        // עמוד לפי מזהים: אוצריא מדפדפת בתוצאות מסוננות-קטגוריה שחישבה
        // מהאינדקס. מוגש מהמטמון; אם התוסף נטען מחדש בינתיים — החיפוש רץ
        // שוב (בלי עדכוני ביניים) רק כדי לאכלס אותו.
        let all = this.repository.cachedResultsFor(snapshot.fingerprint);
        if (!all) {
          // עדכוני "עוד חי" ריקים תוך כדי: בלעדיהם הצד של אוצריא משגר את
          // הבקשה שוב אחרי 8 שניות (ומריץ חיפוש מלא כפול), וטיימאאוט
          // חוסר-הפעילות עלול לנצח חיפוש ארוך.
          let lastKeepAliveAt = 0;
          await this.repository.search(snapshot, (partial) => {
            const now = Date.now();
            if (now - lastKeepAliveAt < 1_000) return;
            lastKeepAliveAt = now;
            if (signal.aborted) return;
            void this.otzaria
              .respondExternalSearch(requestId, {
                results: [],
                totalBooks: partial.totalBooks,
                totalHits: partial.totalHits,
                hasMore: false,
                done: false,
              })
              .catch((error) => this.abandonIfHostDropped(requestId, error));
          }, signal);
          all = this.repository.cachedResultsFor(snapshot.fingerprint) ?? [];
        }
        const openable = openableResults(all);
        const byId = new Map(openable);
        const entries = ids.flatMap((id) => {
          const result = byId.get(id);
          return result === undefined ? [] : [[id, result] as const];
        });
        await this.streamPageWithSnippets(
          requestId,
          entries,
          {
            totalBooks: openable.length,
            totalHits: sumHitCounts(openable.map(([, result]) => result)),
            hasMore: false,
          },
          query,
          undefined,
          signal,
        );
        return;
      }

      // הזרמה: כל מקטע NDJSON שמגיע מהשרת נשלח למדור כעדכון חלקי (ללא
      // קטעי טקסט, עם ספירות רף-תחתון), בקצב מרוסן וברצף — כמו במסך התוסף.
      let lastPartialAt = 0;
      let lastPartialHadResults = false;
      const sendPartial = (partial: HebrewBooksSearchPage): void => {
        const now = Date.now();
        // reset של v2 חייב למחוק מיד ספרים זמניים שכבר נשלחו, כי התוצאות
        // המדורגות שמחליפות אותם כבר בדרך. גם תוצאה ראשונה אחרי keepalive
        // ריק חייבת להישלח מיד.
        if (partial.results.length > 0 && lastPartialHadResults && now - lastPartialAt < 250) return;
        lastPartialAt = now;
        lastPartialHadResults = partial.results.length > 0;
        const payload = {
          results: openableResults(partial.results).map((entry) => this.toExternalResult(entry)),
          totalBooks: partial.totalBooks,
          totalHits: partial.totalHits,
          hasMore: true,
          done: false,
        };
        partialChain = partialChain.then(() =>
          this.otzaria
            .respondExternalSearch(requestId, payload)
            .catch((error) => this.abandonIfHostDropped(requestId, error)),
        );
      };
      const page = await this.repository.search(snapshot, sendPartial, signal, offset);
      // כל העדכונים החלקיים נשלחו לפני הסופי — אחרת עדכון מאחר היה נבלע.
      await partialChain;
      // חיפוש שנזנח (בקשה חדשה החליפה אותו, או שאוצריא כבר אינה מחזיקה
      // את הבקשה) מחזיר תמונה חלקית ולא סופית. תשובה סופית עליה הייתה
      // מוסרת למדור "אלה כל התוצאות" — ועל תמונה ריקה, "אין תוצאות".
      if (signal.aborted) return;
      // אינדקס הקטגוריות (עמוד ראשון בלבד): כלל התוצאות בתמצות, עם קטגוריית
      // אוצריא לכל ספר. הסיווג כולו כאן, בצד התוסף: מיפוי ההשוואות
      // (hb→otzaria, דרך ה-DB של המארח במסלול bulk) קובע נתיב מדויק, ותגיות
      // הקטלוג משמשות fallback. אוצריא רק מאמתת את הנתיבים מול עץ הספרייה.
      const all = this.repository.cachedResultsFor(snapshot.fingerprint);
      const { entries, totals } = externalPage(all, page, offset, limit);
      let index: ExternalSearchIndexEntry[] | undefined;
      if (offset === 0 && all) {
        // התוצאות עצמן לא ממתינות לעידון האינדקס — עמוד ראשון נשלח מיד,
        // והאינדקס המסווג מצטרף בעדכון הבסיס של הזרמת הקטעים.
        await this.otzaria
          .respondExternalSearch(requestId, {
            results: entries.map((entry) => this.toExternalResult(entry)),
            ...totals,
            done: false,
          })
          .catch((error) => this.abandonIfHostDropped(requestId, error));
        // שם הספר נשלח רק כשהמארח הצהיר שהוא צורך אותו: מארח ותיק זורק
        // רשומה בת ארבעה איברים בסניטציה, ואיתה את הסיווג כולו.
        index = await this.refineIndex(
          snapshot.fingerprint,
          all,
          request.indexTitles === true,
        );
      }
      await this.streamPageWithSnippets(
        requestId,
        entries,
        totals,
        query,
        index,
        signal,
      );
    } catch (error) {
      // השגיאה נשלחת אחרי כל העדכונים החלקיים, כדי שלא תוצג לפני התוצאות
      // שכבר נשלחו ותיבלע על ידן. התוצאות עצמן נשארות במדור: המשתמש רואה
      // את מה שכן נמצא, ולצידו את הסיבה שהחיפוש לא הושלם.
      await partialChain;
      // בקשה שנזנחה אינה זקוקה להודעת שגיאה: אין מדור שיציג אותה, ובקשה
      // חדשה שהחליפה אותה כבר מציגה את התוצאות שלה.
      if (signal.aborted) return;
      await this.otzaria
        .respondExternalSearch(requestId, { error: messageOf(error) })
        .catch(() => undefined);
    }
  }

  /// אינדקסים מסווגים לפי חתימת חיפוש — חיפוש חוזר (או בקשת ids אחרי
  /// טעינה-מחדש) לא משלם שוב את מעברי הגשר של המיפוי.
  private readonly refinedIndexCache = new Map<string, ExternalSearchIndexEntry[]>();

  /// בונה את אינדקס הקטגוריות של כלל התוצאות: ספר שמושווה לספר אוצריא
  /// (בטבלת otzaria_hebrew_books, דרך מסלול ה-bulk של ה-DB) מקבל את נתיב
  /// הקטגוריה המדויק שלו בספרייה; לשאר נשארת הקטגוריה המשוערת מתגיות
  /// הקטלוג. במארח ישן (בלי bulk / resolveCategoryPaths) נופלים לתגיות.
  private async refineIndex(
    fingerprint: string,
    all: HebrewBooksResult[],
    withTitles: boolean,
  ): Promise<ExternalSearchIndexEntry[]> {
    // צורת הרשומה היא חלק מהמטמון: אותו חיפוש עשוי להישאל פעם עם שמות ופעם
    // בלעדיהם (מארח ותיק), וגרסה אחת אינה משמשת לשנייה.
    const cacheKey = withTitles ? `${fingerprint}|t` : fingerprint;
    const cached = this.refinedIndexCache.get(cacheKey);
    if (cached) return cached;
    const base = all
      .map((result) => toIndexEntry(result, withTitles))
      .filter((entry): entry is ExternalSearchIndexEntry => entry !== null);
    let refined = base;
    try {
      const mapping = await this.catalogMapping.findBestOtzariaIdsBulk(
        all.map((result) => result.fileId),
      );
      if (mapping.size > 0) {
        const otzariaIds = [...new Set(mapping.values())];
        const paths = await this.otzaria.resolveCategoryPaths(otzariaIds);
        const pathByOtzariaId = new Map(otzariaIds.map((id, position) => [id, paths[position] ?? null]));
        refined = base.map((entry) => {
          const otzariaId = mapping.get(String(entry[0]));
          const path = otzariaId === undefined ? null : pathByOtzariaId.get(otzariaId) ?? null;
          return path ? withCategoryPath(entry, path) : entry;
        });
      }
    } catch {
      // מיפוי או פתרון קטגוריות שנכשלו אינם מעכבים את האינדקס.
    }
    if (this.refinedIndexCache.size >= 8) {
      const oldest = this.refinedIndexCache.keys().next().value;
      if (oldest !== undefined) this.refinedIndexCache.delete(oldest);
    }
    this.refinedIndexCache.set(cacheKey, refined);
    return refined;
  }

  private toExternalResult(
    [externalId, result]: readonly [number, HebrewBooksResult],
  ): ExternalSearchResultPayload {
    return {
      title: result.bookName,
      meta: metaLineOf(result),
      hitCount: result.hitCount,
      firstPage: result.firstHitPage ?? undefined,
      externalId,
    };
  }

  /// שולח את עמוד התוצאות למדור החיצוני מיד (בלי קטעי טקסט) ומזרים את
  /// הקטעים בעדכונים חלקיים כשהם נחלצים מה-PDF. חילוץ עמוד אורך שניות
  /// ותור בעומק עמוד שלם דוחף את רוב הקטעים מעבר לכל תקרה לבקשה בודדת —
  /// לכן התקרה כאן כוללת, והתשובה הסופית נושאת את מה שהספיק להיטען.
  private async streamPageWithSnippets(
    requestId: string,
    pageResults: ReadonlyArray<readonly [number, HebrewBooksResult]>,
    totals: ExternalPageTotals,
    query: string,
    index?: ExternalSearchIndexEntry[],
    signal?: AbortSignal,
  ): Promise<void> {
    // בקשה שנזנחה בדרך לכאן תשלח עמוד שאינו שלה — ולרוב עמוד ריק, שהיה
    // מוחק מהמדור את התוצאות של הבקשה שהחליפה אותה.
    if (signal?.aborted) return;
    const results: ExternalSearchResultPayload[] = pageResults.map((entry) =>
      this.toExternalResult(entry),
    );
    const respondFinal = (): Promise<void> =>
      this.otzaria.respondExternalSearch(requestId, {
        results,
        ...totals,
        ...(index ? { index } : {}),
      });
    // בלי מחלץ קטעים אין מה להזרים, והעמוד נענה סופית מיד.
    const snippets = this.snippets;
    if (!snippets) {
      await respondFinal();
      return;
    }
    // האינדקס (שעשוי להגיע ל-10K רשומות) נשלח בעדכון הבסיס — כדי שהעץ
    // יתעדכן בלי להמתין לקטעים — ושוב בתשובה הסופית ליתר ביטחון; עדכוני
    // הקטעים שביניהם נשלחים בלעדיו, כדי לא לגרור אותו על הגשר שוב ושוב.
    const respondPartial = (withIndex: boolean): Promise<void> =>
      this.otzaria
        .respondExternalSearch(requestId, {
          results: [...results],
          ...totals,
          ...(withIndex && index ? { index } : {}),
          done: false,
        })
        .catch((error) => this.abandonIfHostDropped(requestId, error));
    await respondPartial(true);
    // מחלץ שלא הצליח להיטען אינו מחלץ דבר, ואיתור עמוד עבורו הוא בקשת רשת
    // לשווא — העמוד נענה סופית מיד, בדיוק כמו בלי מחלץ כלל.
    if (snippets.prepare && !(await snippets.prepare())) {
      if (!signal?.aborted) await respondFinal();
      return;
    }

    // עדכוני הקטעים נשלחים ברצף אחד (flushChain) ובקצב מרוסן, כדי שעדכון
    // מאחר לא יעקוף את הסופי ולא נציף את הגשר בעדכון לכל קטע בנפרד.
    let finished = false;
    let stopNewWork = false;
    let flushScheduled = false;
    let flushChain: Promise<void> = Promise.resolve();
    const scheduleFlush = (): void => {
      if (finished || flushScheduled) return;
      flushScheduled = true;
      flushChain = flushChain.then(async () => {
        await delay(snippetFlushIntervalMs);
        flushScheduled = false;
        if (!finished && !signal?.aborted) await respondPartial(false);
      });
    };
    /// המועד האחרון רק הפסיק לתזמן עבודה חדשה; בלי ביטול ממשי בקשת /inbook שכבר
    /// רצה נשארה פתוחה עד 120 שניות, והכונן המשיך לעבוד בשביל קטע שלא ייקרא.
    const abandonSnippets = new AbortController();
    let stopDeadline: () => void = () => undefined;
    const deadlineOrAbort = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, snippetsDeadlineMs);
      const onAbort = (): void => resolve();
      signal?.addEventListener('abort', onAbort, { once: true });
      stopDeadline = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      if (signal?.aborted) resolve();
    });
    try {
      await Promise.race([
        mapWithConcurrency(pageResults, snippetConcurrency, async ([, result], position) => {
          // בקשה שבוטלה (חיפוש חדש החליף אותה) — אין טעם להמשיך לחלץ קטעים.
          if (stopNewWork || signal?.aborted) return;
          const snippet = await this.loadResultSnippet(result, query, () => !stopNewWork && !signal?.aborted, abandonSnippets.signal);
          const current = results[position];
          if (snippet && current && !stopNewWork) {
            results[position] = { ...current, snippet };
            scheduleFlush();
          }
        }, () => !stopNewWork && !signal?.aborted),
        deadlineOrAbort,
      ]);
    } finally {
      // קובע מצב סופי לפני שחרור קריאת /inbook ממתינה, כדי שלא תתחיל
      // בעקבותיה משימת PDF או פריט נוסף בתור.
      stopNewWork = true;
      stopDeadline();
      abandonSnippets.abort();
    }
    await flushChain;
    finished = true;
    // אוצריא כבר עברה ל-requestId חדש; תשובה ישנה כעת רק תופסת את הגשר.
    if (signal?.aborted) return;
    console.info(
      `external ${requestId}: ${results.filter((r) => r.snippet).length}/${results.length} snippets loaded`,
    );
    await respondFinal();
  }

  /// קטע טקסט לתוצאה: תוצאות ברמת ספר מגיעות מהשרת בלי עמוד ההתאמה
  /// הראשונה (firstHitPage ריק), ולכן מאתרים אותו קודם דרך /inbook —
  /// עם מטמון לפי חיפוש+ספר, שגם מאיץ את פתיחת הספר בלחיצה.
  private async loadResultSnippet(
    result: HebrewBooksResult,
    query: string,
    shouldContinue: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const snippets = this.snippets;
    if (!snippets) return null;
    let page = result.firstHitPage;
    if (page === null) {
      // איתור בברירות המחדל (proximity 30, בלי סדר-מילים) ולא באפשרויות
      // החיפוש: /inbook עם proximity הדוק מחזיר 0 עמודים גם לספרים
      // ש-/search מצא בהם מופעים — לכן גם מסלול הפתיחה-בלחיצה משתמש בהן.
      const inBookSnapshot: SearchSnapshot = {
        query,
        options: defaultSearchOptions,
        fingerprint: createFingerprint(query, defaultSearchOptions),
      };
      try {
        page =
          (await this.locateInBook(inBookSnapshot, result.fileId, signal)).pages[0] ?? null;
      } catch (error) {
        console.warn(`snippet ${result.fileId}: inbook failed — ${messageOf(error)}`);
        page = null;
      }
    }
    if (page === null || !shouldContinue()) return null;
    // סריקות בלי שכבת טקסט מחזירות עמוד ריק — קטע יופיע רק לספרים עם
    // טקסט משובץ (OCR); הטקסט של הסריקות קיים רק באינדקס שבצד השרת.
    return this.repository
      .withPdfAccess(result.fileId, (url) => snippets.load(url, result.fileId, page, query))
      .catch((error: unknown) => {
        console.warn(`snippet ${result.fileId} p${page}: extract failed — ${messageOf(error)}`);
        return null;
      });
  }

  private readonly inBookLocationsCache = new Map<string, Promise<InBookLocations>>();

  /// חיפוש מאוחד יכול להישלח במרחק הדוק או עם סדר מילים. השרת מוצא את
  /// הספר בחיפוש הכללי, אך /inbook באותן הגבלות עשוי להחזיר רשימת עמודים
  /// ריקה. לפני פתיחה מנסים פעם אחת את ההגדרות הרגילות, ומקבלים מהמטמון
  /// את אותו איתור שכבר שימש לקטע התצוגה אם הוא קיים.
  async locateOpeningInBook(snapshot: SearchSnapshot, fileId: string): Promise<InBookLocations> {
    const strict = await this.locateInBook(snapshot, fileId);
    if (strict.pages.length > 0) return strict;
    const fallback: SearchSnapshot = {
      query: snapshot.query,
      ...(snapshot.displayQuery === undefined ? {} : { displayQuery: snapshot.displayQuery }),
      options: defaultSearchOptions,
      fingerprint: createFingerprint(snapshot.query, defaultSearchOptions),
    };
    return fallback.fingerprint === snapshot.fingerprint
      ? strict
      : this.locateInBook(fallback, fileId);
  }

  locateInBook(snapshot: SearchSnapshot, fileId: string, signal?: AbortSignal): Promise<InBookLocations> {
    const key = `${snapshot.fingerprint}\u0000${fileId}`;
    const existing = this.inBookLocationsCache.get(key);
    if (existing) return existing;
    const request = this.repository.inBook(snapshot, fileId, signal);
    if (this.inBookLocationsCache.size >= 300) {
      const oldest = this.inBookLocationsCache.keys().next().value;
      if (oldest !== undefined) this.inBookLocationsCache.delete(oldest);
    }
    this.inBookLocationsCache.set(key, request);
    // כישלון אינו נשמר — הבקשה הבאה לאותו ספר תנסה שוב.
    request.catch(() => this.inBookLocationsCache.delete(key));
    return request;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'אירעה שגיאה לא צפויה';
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

/// שורת מטא לתצוגה במדור החיצוני: מחבר · מקום · שנה.
function metaLineOf(result: HebrewBooksResult): string | undefined {
  const parts = [result.authorName, result.printPlace, result.printYear]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '');
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
