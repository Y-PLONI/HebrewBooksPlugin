import type { HostBridge } from './bridge';
import { requireHostData } from './bridge';
import type {
  ExternalSearchIndexEntry,
  ExternalSearchRequestedEvent,
  ExternalSearchResultPayload,
  HealthStatus,
  HebrewBooksResult,
  HebrewBooksSearchPage,
  HostSearchRequest,
  HostSearchRequestedEvent,
  InBookLocations,
  InBookSearchRequestedEvent,
  SearchOptions,
  SearchSnapshot,
  UnifiedSearchResponse,
  UnifiedSearchResult,
} from './models';
import { defaultSearchOptions } from './models';
import { CatalogMappingRepository } from './repositories/catalog-mapping-repository';
import { HebrewBooksRepository } from './repositories/hebrewbooks-repository';
import { HebrewBooksSnippetRepository } from './repositories/hebrewbooks-snippet-repository';
import { OtzariaSearchRepository } from './repositories/otzaria-search-repository';
import { LibraryScreen } from './screens/library-screen';
import { ResultsScreen, type SearchTerms } from './screens/results-screen';
import { SearchDialog } from './screens/search-dialog';
import { ViewerScreen } from './screens/viewer-screen';
import { mapHebrewBooksCategory } from './services/hb-category-mapper';
import { LatestRequest } from './services/latest-request';
import {
  mergeUnifiedSearchResponses,
  UnifiedSearchService,
  toHebrewBooksSnapshot,
} from './services/unified-search-service';
import { applyTheme } from './theme';

type Screen = 'library' | 'results' | 'viewer';

/// תקרת הזמן הכוללת להזרמת קטעי הטקסט למדור החיצוני, קצב העדכונים החלקיים,
/// ומספר הקטעים הנטענים במקביל (איתור עמוד ב-/inbook + חילוץ מה-PDF).
const snippetsDeadlineMs = 15_000;
const snippetFlushIntervalMs = 400;
const snippetConcurrency = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/// מריץ את [task] על כל פריט במקביליות מוגבלת, בסדר התור המקורי.
async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
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

function sumHitCounts(results: readonly HebrewBooksResult[]): number {
  return results.reduce((total, result) => total + result.hitCount, 0);
}

function toIndexEntry(result: HebrewBooksResult): ExternalSearchIndexEntry {
  const id = Number(result.fileId);
  const category = mapHebrewBooksCategory(result.categories);
  return category === null ? [id, result.hitCount] : [id, result.hitCount, category];
}

export class AppController {
  private readonly repository: HebrewBooksRepository;
  // מקביליות 3: עמוד מדור חיצוני טוען עד 20 קטעים בתור, וב-2 במקביל הזנב
  // חורג מתקרת ההזרמה; מעבר לזה מציף את ה-sidecar בבקשות Range.
  private readonly snippets = new HebrewBooksSnippetRepository(3);
  private readonly otzariaRepository: OtzariaSearchRepository;
  private readonly unifiedSearch: UnifiedSearchService;
  private readonly library: LibraryScreen;
  private readonly results: ResultsScreen;
  private readonly viewer: ViewerScreen;
  private readonly dialog: SearchDialog;

  private healthStatus: HealthStatus | null = null;
  private hebrewBooksPath: string | null = null;
  private hebrewBooksPathVersion = 0;
  private snapshot: SearchSnapshot | null = null;
  private resultList: HebrewBooksResult[] = [];
  private selectedResult: HebrewBooksResult | null = null;
  private readonly latestSearch = new LatestRequest();
  private unifiedRequest: HostSearchRequest | null = null;
  private unifiedResponse: UnifiedSearchResponse | null = null;
  private unifiedRequestId: number | null = null;
  private loadingMore = false;
  private activeSearchCancellation: AbortController | null = null;

  constructor(private readonly bridge: HostBridge, shell: HTMLElement) {
    this.repository = new HebrewBooksRepository(bridge);
    this.otzariaRepository = new OtzariaSearchRepository(bridge);
    this.unifiedSearch = new UnifiedSearchService(
      this.repository,
      this.otzariaRepository,
      new CatalogMappingRepository(bridge),
    );

    this.library = new LibraryScreen({
      onSearch: () => this.dialog.open(this.snapshot?.query ?? ''),
      onRetry: () => void this.checkHealth(),
    });

    this.results = new ResultsScreen({
      onBack: () => this.showScreen('library'),
      onEditSearch: () => {
        if (this.snapshot) this.dialog.setOptions(this.snapshot.options);
        this.dialog.open(this.snapshot?.query ?? '');
      },
      onLoadMore: () => void this.loadMoreUnifiedSearch(),
      onOpenResult: (result) => void this.openResult(result),
      onOpenWebsite: (result) => void this.openWebsite(result),
      onCopyDetails: (result) => void this.copyDetails(result),
      onLoadSnippet: (result) => this.loadSnippet(result),
    });

    this.viewer = new ViewerScreen(
      {
        onBack: () => this.showScreen('results'),
        onOpenTextEdition: () => {
          if (this.selectedResult) void this.openTextEdition(this.selectedResult);
        },
        onOpenWebsite: () => {
          if (this.selectedResult) void this.openWebsite(this.selectedResult);
        },
        onInBookSearch: (query) => void this.searchInBook(query),
      },
      new URL('vendor/pdf.worker.min.mjs', document.baseURI).toString(),
    );

    this.dialog = new SearchDialog((request) => {
      this.dialog.close();
      // חיפוש מהתוסף נפתח בכרטיסיית חיפוש מובנית של אוצריא (המדור החיצוני
      // מציג שם את התוצאות); מארח ישן שאינו מכיר את ה-API נופל למסך התוסף.
      void this.otzariaRepository
        .openSearchTab(request.query)
        .catch(() => this.performSearch(request.query, request.options));
    });

    this.bridge.on('search.requested', ((payload: HostSearchRequestedEvent) => {
      void this.performUnifiedSearch(payload);
    }) as (payload: never) => void);

    // נרשם כאן ולא ב-boot: כשאוצריא מעירה את התוסף דרך פתיחת הדף כדי למסור
    // אירוע ממוקד, האירוע עלול להגיע לפני ש-boot רץ — מאזין שנרשם רק שם
    // היה מפספס אותו והבקשה הייתה נופלת בטיימאאוט.
    this.bridge.on('search.external.requested', ((request: ExternalSearchRequestedEvent) => {
      void this.handleExternalSearchRequest(request);
    }) as (payload: never) => void);

    // אותו טעם: הקורא המובנה מאציל אלינו חיפוש-בתוך-ספר לספרי היברובוקס,
    // וההערה עשויה להגיע עם אירוע ההעֲרָה עצמו.
    this.bridge.on('reader.inBookSearch.requested', ((request: InBookSearchRequestedEvent) => {
      void this.handleInBookSearchRequest(request);
    }) as (payload: never) => void);

    shell.append(this.library.root, this.results.root, this.viewer.root);
    this.showScreen('library');
  }

  async boot(payload: OtzariaBootPayload): Promise<void> {
    applyTheme(payload.theme);
    this.bridge.on('theme.changed', ((theme: OtzariaTheme) => applyTheme(theme)) as (payload: never) => void);
    this.bridge.on('settings.changed', ((eventPayload: { key?: string; newValue?: string }) => {
      if (eventPayload && eventPayload.key === 'key-hebrew-books-path') {
        const path =
          typeof eventPayload.newValue === 'string' && eventPayload.newValue.trim() !== ''
            ? eventPayload.newValue.trim()
            : null;
        this.hebrewBooksPath = path;
        this.hebrewBooksPathVersion += 1;
        this.library.setHebrewBooksPath(path);
      }
    }) as (payload: never) => void);
    await this.fetchHebrewBooksPath();
    await this.checkHealth();
    void this.otzariaRepository
      .registerInBookSearchProvider()
      .catch(() => undefined); // מארח ישן שאינו מכיר את ה-API — לא קריטי
    void this.otzariaRepository
      .registerExternalSearchProvider()
      .catch(() => undefined);
  }

  private async handleInBookSearchRequest(request: InBookSearchRequestedEvent): Promise<void> {
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
      await this.otzariaRepository.respondInBookSearch(requestId, {
        pages: locations.pages,
        matchedTerms: locations.matchedTerms,
        query,
      });
    } catch (error) {
      await this.otzariaRepository
        .respondInBookSearch(requestId, { error: messageOf(error) })
        .catch(() => undefined);
    }
  }

  /// עמוד תוצאות למדור החיצוני של טאב החיפוש המובנה. הדפדוף נשען על מטמון
  /// החיפוש של ה-repository (אותו fingerprint), כך שרק העמוד הראשון פונה
  /// לשרת; קטעי הטקסט נטענים במקביל עם תקרת זמן ואינם מעכבים את התשובה.
  private async handleExternalSearchRequest(request: ExternalSearchRequestedEvent): Promise<void> {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    if (!requestId) return;
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
        limit,
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
            void this.otzariaRepository
              .respondExternalSearch(requestId, {
                results: [],
                totalBooks: partial.totalBooks,
                totalHits: partial.totalHits,
                hasMore: false,
                done: false,
              })
              .catch(() => undefined);
          });
          all = this.repository.cachedResultsFor(snapshot.fingerprint) ?? [];
        }
        const byId = new Map(all.map((result) => [Number(result.fileId), result]));
        const results = ids
          .map((id) => byId.get(id))
          .filter((result): result is HebrewBooksResult => result !== undefined);
        await this.streamPageWithSnippets(
          requestId,
          results,
          {
            totalBooks: all.length,
            totalHits: sumHitCounts(all),
            hasMore: false,
          },
          query,
        );
        return;
      }

      // הזרמה: כל מקטע NDJSON שמגיע מהשרת נשלח למדור כעדכון חלקי (ללא
      // קטעי טקסט, עם ספירות רף-תחתון), בקצב מרוסן וברצף — כמו במסך התוסף.
      let lastPartialAt = 0;
      let partialChain: Promise<void> = Promise.resolve();
      const sendPartial = (partial: HebrewBooksSearchPage): void => {
        const now = Date.now();
        if (now - lastPartialAt < 250) return;
        lastPartialAt = now;
        const payload = {
          results: partial.results.map((result) => this.toExternalResult(result)),
          totalBooks: partial.totalBooks,
          totalHits: partial.totalHits,
          hasMore: true,
          done: false,
        };
        partialChain = partialChain.then(() =>
          this.otzariaRepository
            .respondExternalSearch(requestId, payload)
            .catch(() => undefined),
        );
      };
      const page = await this.repository.search(snapshot, sendPartial, undefined, offset);
      // כל העדכונים החלקיים נשלחו לפני הסופי — אחרת עדכון מאחר היה נבלע.
      await partialChain;
      // אינדקס הקטגוריות (עמוד ראשון בלבד): כלל התוצאות בתמצות, עם
      // קטגוריית אוצריא המשוערת מתגיות הקטלוג. אוצריא בונה ממנו את
      // הספירות בעץ ומעדנת מול DB ההשוואות המקומי שלה.
      const all = offset === 0
        ? this.repository.cachedResultsFor(snapshot.fingerprint)
        : null;
      const index = all?.map(toIndexEntry);
      await this.streamPageWithSnippets(
        requestId,
        page.results,
        {
          totalBooks: page.totalBooks,
          totalHits: page.totalHits,
          hasMore: offset + page.results.length < page.totalBooks,
        },
        query,
        index,
      );
    } catch (error) {
      await this.otzariaRepository
        .respondExternalSearch(requestId, { error: messageOf(error) })
        .catch(() => undefined);
    }
  }

  private toExternalResult(result: HebrewBooksResult): ExternalSearchResultPayload {
    return {
      title: result.bookName,
      meta: metaLineOf(result),
      hitCount: result.hitCount,
      firstPage: result.firstHitPage ?? undefined,
      externalId: Number(result.fileId),
    };
  }

  /// שולח את עמוד התוצאות למדור החיצוני מיד (בלי קטעי טקסט) ומזרים את
  /// הקטעים בעדכונים חלקיים כשהם נחלצים מה-PDF. חילוץ עמוד אורך שניות
  /// ותור בעומק עמוד שלם דוחף את רוב הקטעים מעבר לכל תקרה לבקשה בודדת —
  /// לכן התקרה כאן כוללת, והתשובה הסופית נושאת את מה שהספיק להיטען.
  private async streamPageWithSnippets(
    requestId: string,
    pageResults: HebrewBooksResult[],
    totals: { totalBooks: number; totalHits: number; hasMore: boolean },
    query: string,
    index?: ExternalSearchIndexEntry[],
  ): Promise<void> {
    const results: ExternalSearchResultPayload[] = pageResults.map((result) =>
      this.toExternalResult(result),
    );
    // האינדקס (שעשוי להגיע ל-10K רשומות) נשלח בעדכון הבסיס — כדי שהעץ
    // יתעדכן בלי להמתין לקטעים — ושוב בתשובה הסופית ליתר ביטחון; עדכוני
    // הקטעים שביניהם נשלחים בלעדיו, כדי לא לגרור אותו על הגשר שוב ושוב.
    const respondPartial = (withIndex: boolean): Promise<void> =>
      this.otzariaRepository
        .respondExternalSearch(requestId, {
          results: [...results],
          ...totals,
          ...(withIndex && index ? { index } : {}),
          done: false,
        })
        .catch(() => undefined);
    await respondPartial(true);

    // עדכוני הקטעים נשלחים ברצף אחד (flushChain) ובקצב מרוסן, כדי שעדכון
    // מאחר לא יעקוף את הסופי ולא נציף את הגשר בעדכון לכל קטע בנפרד.
    let finished = false;
    let flushScheduled = false;
    let flushChain: Promise<void> = Promise.resolve();
    const scheduleFlush = (): void => {
      if (finished || flushScheduled) return;
      flushScheduled = true;
      flushChain = flushChain.then(async () => {
        await delay(snippetFlushIntervalMs);
        flushScheduled = false;
        if (!finished) await respondPartial(false);
      });
    };
    await Promise.race([
      mapWithConcurrency(pageResults, snippetConcurrency, async (result, position) => {
        const snippet = await this.loadResultSnippet(result, query);
        const current = results[position];
        if (snippet && current && !finished) {
          results[position] = { ...current, snippet };
          scheduleFlush();
        }
      }),
      delay(snippetsDeadlineMs),
    ]);
    await flushChain;
    finished = true;
    await this.otzariaRepository.respondExternalSearch(requestId, {
      results,
      ...totals,
      ...(index ? { index } : {}),
    });
  }

  /// קטע טקסט לתוצאה: תוצאות ברמת ספר מגיעות מהשרת בלי עמוד ההתאמה
  /// הראשונה (firstHitPage ריק), ולכן מאתרים אותו קודם דרך /inbook —
  /// עם מטמון לפי חיפוש+ספר, שגם מאיץ את פתיחת הספר בלחיצה.
  private async loadResultSnippet(
    result: HebrewBooksResult,
    query: string,
  ): Promise<string | null> {
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
          (await this.locateInBook(inBookSnapshot, result.fileId)).pages[0] ?? null;
      } catch {
        page = null;
      }
    }
    if (page === null) return null;
    // סריקות בלי שכבת טקסט מחזירות עמוד ריק — קטע יופיע רק לספרים עם
    // טקסט משובץ (OCR); הטקסט של הסריקות קיים רק באינדקס שבצד השרת.
    return this.snippets
      .load(this.repository.pdfUrl(result.fileId), result.fileId, page, query)
      .catch(() => null);
  }

  private readonly inBookLocationsCache = new Map<string, Promise<InBookLocations>>();

  private locateInBook(snapshot: SearchSnapshot, fileId: string): Promise<InBookLocations> {
    const key = `${snapshot.fingerprint}\u0000${fileId}`;
    const existing = this.inBookLocationsCache.get(key);
    if (existing) return existing;
    const request = this.repository.inBook(snapshot, fileId);
    if (this.inBookLocationsCache.size >= 300) {
      const oldest = this.inBookLocationsCache.keys().next().value;
      if (oldest !== undefined) this.inBookLocationsCache.delete(oldest);
    }
    this.inBookLocationsCache.set(key, request);
    // כישלון אינו נשמר — הבקשה הבאה לאותו ספר תנסה שוב.
    request.catch(() => this.inBookLocationsCache.delete(key));
    return request;
  }

  private async fetchHebrewBooksPath(): Promise<void> {
    const versionAtRequest = this.hebrewBooksPathVersion;
    try {
      const response = await this.bridge.call<string | null>('settings.get', {
        key: 'key-hebrew-books-path',
      });
      if (versionAtRequest === this.hebrewBooksPathVersion) {
        this.hebrewBooksPath =
          response.success && typeof response.data === 'string' && response.data.trim() !== ''
            ? response.data.trim()
            : null;
      }
    } catch {
      if (versionAtRequest === this.hebrewBooksPathVersion) this.hebrewBooksPath = null;
    }
    this.library.setHebrewBooksPath(this.hebrewBooksPath);
  }

  private async checkHealth(): Promise<void> {
    this.library.showChecking();
    try {
      this.healthStatus = await this.repository.health();
      const capability = this.healthStatus.kind === 'onlineFull' ? 'חיפוש ועיון' : 'חיפוש בלבד';
      const version = this.healthStatus.serverVersion ? ` · גרסה ${this.healthStatus.serverVersion}` : '';
      this.library.showReady(`שירות החיפוש מחובר (${capability})${version}`, this.hebrewBooksPath);
    } catch (error) {
      this.healthStatus = null;
      this.library.showOffline(
        `${messageOf(error)}\nוודא שהשירות המקומי של היברובוקס פועל, ולחץ "בדוק שוב".`,
        this.hebrewBooksPath,
      );
    }
  }

  private async performSearch(rawQuery: string, options: SearchOptions): Promise<void> {
    const query = rawQuery.trim();
    if (query.length === 0) {
      await this.showHostError('יש להזין מילות חיפוש');
      return;
    }
    if (query.length > 500) {
      await this.showHostError('החיפוש מוגבל ל־500 תווים');
      return;
    }
    if (options.corpus.length === 0) {
      await this.showHostError('יש לבחור מקור אחד לפחות');
      return;
    }

    const cancellation = this.replaceSearchCancellation();
    const requestId = this.latestSearch.begin();
    this.clearUnifiedSearch();
    this.snapshot = { query, options, fingerprint: createFingerprint(query, options) };
    this.showScreen('results');
    this.results.setSearch(query, null, true, undefined, false, hebrewBooksSearchTerms(options));
    this.results.showLoading();
    try {
      const searchPage = await this.repository.search(
        this.snapshot,
        (partial) => {
          if (!this.latestSearch.isCurrent(requestId)) return false;
          this.resultList = [...partial.results];
          this.results.setSearch(query, partial.results.length, true, undefined, false, hebrewBooksSearchTerms(options));
          this.results.showPartialResults({
            results: partial.results.map((hit) => ({
              source: 'hebrewbooks',
              categoryPath: 'ספרי היברובוקס',
              hit,
            })),
            otzariaTotal: 0,
            hebrewBooksTotal: partial.totalHits,
            truncated: partial.truncated,
            warnings: [],
            nextCursor: null,
          }, 'מוצגות תוצאות שהתקבלו; החיפוש ממשיך…');
          return true;
        },
        cancellation.signal,
      );
      if (!this.latestSearch.isCurrent(requestId)) return;
      this.resultList = searchPage.results;
      this.results.setSearch(
        query,
        this.resultList.length,
        true,
        searchPage.totalHits,
        searchPage.truncated,
        hebrewBooksSearchTerms(options),
      );
      if (this.resultList.length === 0) this.results.showNoResults();
      else {
        this.results.showResults({
          results: this.resultList.map((hit) => ({
            source: 'hebrewbooks',
            categoryPath: 'ספרי היברובוקס',
            hit,
          })),
          otzariaTotal: 0,
          hebrewBooksTotal: searchPage.totalHits,
          truncated: searchPage.truncated,
          warnings: [],
          nextCursor: null,
        });
      }
    } catch (error) {
      if (!this.latestSearch.isCurrent(requestId)) return;
      this.resultList = [];
      this.results.setSearch(query, 0, true, undefined, false, hebrewBooksSearchTerms(options));
      this.results.showError(messageOf(error));
    } finally {
      this.releaseSearchCancellation(cancellation);
    }
  }

  private async performUnifiedSearch(event: HostSearchRequestedEvent): Promise<void> {
    const request = event?.request;
    if (!isHostSearchRequest(request)) {
      await this.showHostError('בקשת החיפוש מאוצריא אינה תקינה');
      return;
    }
    const cancellation = this.replaceSearchCancellation();
    const requestId = this.latestSearch.begin();
    this.unifiedRequest = request;
    this.unifiedResponse = null;
    this.unifiedRequestId = requestId;
    this.loadingMore = false;
    this.snapshot = toHebrewBooksSnapshot(request);
    this.showScreen('results');
    this.results.setSearch(request.query, null, false, undefined, false, otzariaSearchTerms(request));
    this.results.showLoading();
    try {
      const response = await this.unifiedSearch.search(
        request,
        undefined,
        (partial) => {
          if (!this.latestSearch.isCurrent(requestId)) return false;
          this.results.setSearch(request.query, partial.results.length, false, undefined, false, otzariaSearchTerms(request));
          this.results.showPartialResults(partial, 'מוצגות תוצאות שהתקבלו; החיפוש ממשיך…');
          return true;
        },
        cancellation.signal,
      );
      if (!this.latestSearch.isCurrent(requestId)) return;
      this.unifiedResponse = response;
      this.resultList = response.results
        .filter((result): result is Extract<UnifiedSearchResult, { source: 'hebrewbooks' }> => result.source === 'hebrewbooks')
        .map((result) => result.hit);
      this.results.setSearch(
        request.query,
        response.results.length,
        false,
        response.otzariaTotal + response.hebrewBooksTotal,
        response.totalIsLowerBound,
        otzariaSearchTerms(request),
      );
      if (response.results.length === 0) this.results.showNoResults();
      else this.results.showResults(response);
    } catch (error) {
      if (!this.latestSearch.isCurrent(requestId)) return;
      this.resultList = [];
      this.results.setSearch(request.query, 0, false, undefined, false, otzariaSearchTerms(request));
      this.results.showError(messageOf(error));
    } finally {
      this.releaseSearchCancellation(cancellation);
    }
  }

  private async loadMoreUnifiedSearch(): Promise<void> {
    const request = this.unifiedRequest;
    const current = this.unifiedResponse;
    const requestId = this.unifiedRequestId;
    const cursor = current?.nextCursor;
    if (!request || !current || !cursor || requestId === null || this.loadingMore) return;

    this.loadingMore = true;
    this.results.setLoadingMore(true);
    const cancellation = this.replaceSearchCancellation();
    try {
      const page = await this.unifiedSearch.search(request, cursor, undefined, cancellation.signal);
      if (!this.latestSearch.isCurrent(requestId)) return;
      const response = mergeUnifiedSearchResponses(current, page);
      this.unifiedResponse = response;
      this.resultList = response.results
        .filter(
          (result): result is Extract<UnifiedSearchResult, { source: 'hebrewbooks' }> =>
            result.source === 'hebrewbooks',
        )
        .map((result) => result.hit);
      this.results.setSearch(
        request.query,
        response.results.length,
        false,
        response.otzariaTotal + response.hebrewBooksTotal,
        response.totalIsLowerBound,
        otzariaSearchTerms(request),
      );
      this.results.showResults(response);
    } catch (error) {
      if (!this.latestSearch.isCurrent(requestId)) return;
      this.results.setLoadingMore(false);
      await this.showHostError(messageOf(error));
    } finally {
      this.releaseSearchCancellation(cancellation);
      if (this.latestSearch.isCurrent(requestId)) this.loadingMore = false;
    }
  }

  private replaceSearchCancellation(): AbortController {
    this.activeSearchCancellation?.abort();
    const cancellation = new AbortController();
    this.activeSearchCancellation = cancellation;
    return cancellation;
  }

  private releaseSearchCancellation(cancellation: AbortController): void {
    if (this.activeSearchCancellation === cancellation) this.activeSearchCancellation = null;
  }

  private clearUnifiedSearch(): void {
    this.unifiedRequest = null;
    this.unifiedResponse = null;
    this.unifiedRequestId = null;
    this.loadingMore = false;
  }

  private async openResult(result: UnifiedSearchResult): Promise<void> {
    try {
      if (result.source === 'otzaria') {
        const { id, bookId, type, source } = result.hit;
        const opened = await this.otzariaRepository.openBook(
          { id, bookId, type, source },
          result.hit.index,
          this.snapshot?.query ?? '',
        );
        if (!opened) throw new Error('לא ניתן היה לפתוח את הספר באוצריא');
        return;
      }

      const snapshot = this.snapshot;
      if (!snapshot) return;
      const locations = await this.repository.inBook(snapshot, result.hit.fileId);
      // בעיגון מילה ראשונה/אחרונה מספרי העמודים אינם מיקומי התאמה אמינים —
      // פותחים מעמוד 1 ולא מעבירים אותם לקורא.
      const anchored = snapshot.options.firstWord || snapshot.options.lastWord;
      const page = anchored ? 1 : locations.pages[0] ?? 1;
      const externalId = Number(result.hit.fileId);
      if (!Number.isInteger(externalId) || externalId <= 0) throw new Error('מזהה הספר בהיברובוקס אינו תקין');
      const opened = await this.otzariaRepository.openBook(
        { external: { provider: 'hebrewbooks', id: externalId } },
        Math.max(0, page - 1),
        snapshot.query,
        anchored
          ? undefined
          : { pages: locations.pages, matchedTerms: locations.matchedTerms },
      );
      if (!opened) throw new Error('הספר לא נמצא בקטלוג היברובוקס של אוצריא');
    } catch (error) {
      await this.showHostError(messageOf(error));
    }
  }

  private loadSnippet(result: HebrewBooksResult): Promise<string | null> {
    const query = this.snapshot?.query;
    if (!query) return Promise.resolve(null);
    return this.snippets.load(
      this.repository.pdfUrl(result.fileId),
      result.fileId,
      result.firstHitPage,
      query,
    );
  }

  private async openBook(result: HebrewBooksResult): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.selectedResult = result;
    this.showScreen('viewer');
    this.viewer.setSearchQuery(snapshot.query);
    try {
      const locations = await this.repository.inBook(snapshot, result.fileId);
      // כשהחיפוש מוגבל למילה ראשונה/אחרונה בעמוד, מספרי העמודים אינם מיקומי
      // התאמה ולכן נפתחים מתחילת הספר — כמו במסך התוצאות של אוצריא.
      const anchored = snapshot.options.firstWord || snapshot.options.lastWord;
      const initialPage = anchored ? 1 : locations.pages[0] ?? 1;
      await this.viewer.openBook(result.bookName, this.repository.pdfUrl(result.fileId), locations.pages, initialPage);
    } catch (error) {
      this.showScreen('results');
      await this.showHostError(messageOf(error));
    }
  }

  private async searchInBook(query: string): Promise<void> {
    const snapshot = this.snapshot;
    const result = this.selectedResult;
    if (!snapshot || !result) return;
    try {
      const locations = await this.repository.inBook({ ...snapshot, query }, result.fileId);
      this.viewer.setMatchPages(locations.pages);
    } catch (error) {
      await this.showHostError(messageOf(error));
    }
  }

  private async openTextEdition(result: HebrewBooksResult): Promise<void> {
    try {
      const books = await requireHostData<Array<{ bookId: string; title: string }>>(
        this.bridge,
        'library.findBooks',
        { query: result.bookName, limit: 20 },
      );
      const normalizedTitle = normalizeTitle(result.bookName);
      const matches = books.filter((book) => normalizeTitle(book.title) === normalizedTitle);
      const match = matches[0];
      if (matches.length !== 1 || !match) throw new Error('לא נמצאה מהדורת טקסט תואמת בספריית אוצריא');
      const opened = await requireHostData<boolean>(this.bridge, 'reader.openBook', {
        bookId: match.bookId,
        index: 0,
        searchQuery: this.snapshot && isSimpleSearch(this.snapshot.options) ? this.snapshot.query : '',
      });
      if (!opened) throw new Error('הספר נמצא אך לא ניתן היה לפתוח אותו');
    } catch (error) {
      await this.showHostError(messageOf(error));
    }
  }

  private async openWebsite(result: HebrewBooksResult): Promise<void> {
    try {
      await requireHostData<boolean>(this.bridge, 'app.openUrl', {
        url: `https://hebrewbooks.org/${encodeURIComponent(result.fileId)}`,
      });
    } catch (error) {
      await this.showHostError(messageOf(error));
    }
  }

  private async copyDetails(result: HebrewBooksResult): Promise<void> {
    const details = [result.bookName, result.authorName, result.printPlace, result.printYear]
      .filter(Boolean)
      .join(', ');
    if (await copyText(details)) {
      await this.bridge.call('ui.showMessage', { message: 'הטקסט הועתק' });
    } else {
      await this.showHostError('לא ניתן היה להעתיק את הטקסט');
    }
  }

  private showScreen(screen: Screen): void {
    this.library.root.classList.toggle('hidden', screen !== 'library');
    this.results.root.classList.toggle('hidden', screen !== 'results');
    this.viewer.root.classList.toggle('hidden', screen !== 'viewer');
    if (screen !== 'viewer') void this.viewer.close();
  }

  private async showHostError(message: string): Promise<void> {
    await this.bridge.call('ui.showError', { message });
  }
}

function createFingerprint(query: string, options: SearchOptions): string {
  return `${query}\u0000${JSON.stringify(options)}`;
}

function hebrewBooksSearchTerms(options: SearchOptions): SearchTerms {
  return { source: 'hebrewbooks', options };
}

function otzariaSearchTerms(request: HostSearchRequest): SearchTerms {
  return { source: 'otzaria', request };
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[׳״'"־–—-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSimpleSearch(options: SearchOptions): boolean {
  return (
    options.fuzziness === 0 &&
    !options.hybur &&
    !options.roots &&
    !options.gematria &&
    !options.spelling &&
    !options.numberGender &&
    !options.aramaic &&
    !options.rashetevot &&
    !options.rashiOcr
  );
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

function isHostSearchRequest(value: unknown): value is HostSearchRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.query === 'string' &&
    request.query.trim() !== '' &&
    (request.mode === 'exact' || request.mode === 'advanced')
  );
}

/// ה-WebView אינו תמיד בהקשר מאובטח, ולכן נשמר גם המסלול הישן של execCommand.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  }
}
