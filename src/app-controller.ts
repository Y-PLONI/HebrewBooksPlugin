import type { HostBridge } from './bridge';
import { requireHostData } from './bridge';
import type {
  HealthStatus,
  HebrewBooksResult,
  ResultSnippet,
  SearchOptions,
  SearchSnapshot,
  UnifiedSearchResult,
} from './models';
import { plainSearchQuery } from './models';
import { CatalogMappingRepository } from './repositories/catalog-mapping-repository';
import { HebrewBooksRepository } from './repositories/hebrewbooks-repository';
import { HebrewBooksSnippetRepository } from './repositories/hebrewbooks-snippet-repository';
import { OtzariaSearchRepository, otzariaTabBlocker } from './repositories/otzaria-search-repository';
import { LibraryScreen } from './screens/library-screen';
import { ResultsScreen, type SearchTerms } from './screens/results-screen';
import { SearchDialog } from './screens/search-dialog';
import { ViewerScreen } from './screens/viewer-screen';
import { ExternalSearchServer, createFingerprint, sumHitCounts } from './services/external-search-server';
import { LatestRequest } from './services/latest-request';
import { applyTheme } from './theme';
import { externalIdOf } from './utils/personal-id';
import { outdatedServiceMessage } from './utils/service-version';

type Screen = 'library' | 'results' | 'viewer';

/// טקסט המשתמש להצגה ולהדגשה: בהתאמה חלקית snapshot.query היא שאילתת
/// אופרטורים שנבנתה עבור המנוע, ואין להראות אותה או להדגיש לפיה.
function displayQueryOf(snapshot: SearchSnapshot | null | undefined): string {
  return snapshot ? snapshot.displayQuery ?? snapshot.query : '';
}

export class AppController {
  private readonly repository: HebrewBooksRepository;
  // מקביליות 3: עמוד מדור חיצוני טוען עד 20 קטעים בתור, וב-2 במקביל הזנב
  // חורג מתקרת ההזרמה; מעבר לזה מציף את ה-sidecar בבקשות Range.
  private readonly snippets = new HebrewBooksSnippetRepository(3);
  private readonly otzariaRepository: OtzariaSearchRepository;
  /// הגשת אירועי החיפוש הממוקדים — אותו מודול שמופע הרקע מריץ לבדו.
  private readonly server: ExternalSearchServer;
  private readonly library: LibraryScreen;
  private readonly results: ResultsScreen;
  private readonly viewer: ViewerScreen;
  private readonly dialog: SearchDialog;

  private healthStatus: HealthStatus | null = null;
  // מ-0.9.97 אין דרך לקרוא את הנתיב: מדיניות ההגדרות חוסמת כל מפתח שבשמו
  // `path`. הוא נודע רק כשהמשתמש משנה אותו, דרך settings.changed.
  private hebrewBooksPath: string | null = null;
  private snapshot: SearchSnapshot | null = null;
  private resultList: HebrewBooksResult[] = [];
  private selectedResult: HebrewBooksResult | null = null;
  private readonly latestSearch = new LatestRequest();
  // פתיחת ספר תלויה לעיתים ב-/inbook. אסור שתשובה מאוחרת תפתח ספר שכבר
  // נזנח, או תחזיר את הקורא אחרי שהמשתמש חזר למסך התוצאות.
  private readonly latestResultOpen = new LatestRequest();
  private activeSearchCancellation: AbortController | null = null;

  constructor(private readonly bridge: HostBridge, shell: HTMLElement) {
    this.repository = new HebrewBooksRepository(bridge);
    this.otzariaRepository = new OtzariaSearchRepository(bridge);
    this.server = new ExternalSearchServer({
      repository: this.repository,
      otzaria: this.otzariaRepository,
      catalogMapping: new CatalogMappingRepository(bridge),
      snippets: this.snippets,
    });

    this.library = new LibraryScreen({
      onSearch: () => this.dialog.open(displayQueryOf(this.snapshot)),
      onRetry: () => void this.checkHealth(),
    });

    this.results = new ResultsScreen({
      onBack: () => {
        this.invalidateResultOpen();
        this.showScreen('library');
      },
      onEditSearch: () => {
        if (this.snapshot) this.dialog.setOptions(this.snapshot.options);
        this.dialog.open(displayQueryOf(this.snapshot));
      },
      onOpenResult: (result) => void this.openResult(result),
      onOpenWebsite: (result) => void this.openWebsite(result),
      onCopyDetails: (result) => void this.copyDetails(result),
      onLoadSnippet: (result) => this.loadSnippet(result),
    });

    this.viewer = new ViewerScreen(
      {
        onBack: () => {
          this.invalidateResultOpen();
          this.showScreen('results');
        },
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
      // בחירה שהטאב אינו יכול לכבד אינה נבלעת: החיפוש נשאר כאן, במסך שבו
      // האפשרויות שנבחרו חלות בפועל, והמשתמש מקבל את הסיבה.
      const blocker = otzariaTabBlocker(request.options);
      if (blocker !== null) {
        void this.bridge.call('ui.showMessage', { message: blocker });
        void this.performSearch(request.query, request.options);
        return;
      }
      // חיפוש מהתוסף נפתח בכרטיסיית חיפוש מובנית של אוצריא (המדור החיצוני
      // מציג שם את התוצאות); מארח ישן שאינו מכיר את ה-API נופל למסך התוסף.
      void this.otzariaRepository
        .openSearchTab(request.query, request.options)
        .catch(() => this.performSearch(request.query, request.options));
    });

    this.server.listen(this.bridge);

    shell.append(this.library.root, this.results.root, this.viewer.root);
    this.showScreen('library');
  }

  async boot(payload: OtzariaBootPayload): Promise<void> {
    // הרישום ראשון ולפני כל המתנה: קורא שפותח ספר היברובוקס בינתיים (למשל
    // "מהדורה מקבילה") בודק את הספקים בזמן הבנייה, ובלעדיהם אין חיפוש בספר.
    void this.server.registerProviders();
    applyTheme(payload.theme);
    this.bridge.on('theme.changed', ((theme: OtzariaTheme) => applyTheme(theme)) as (payload: never) => void);
    this.bridge.on('settings.changed', ((eventPayload: { key?: string; newValue?: string }) => {
      if (eventPayload && eventPayload.key === 'key-hebrew-books-path') {
        const path =
          typeof eventPayload.newValue === 'string' && eventPayload.newValue.trim() !== ''
            ? eventPayload.newValue.trim()
            : null;
        this.hebrewBooksPath = path;
        this.library.setHebrewBooksPath(path);
      }
    }) as (payload: never) => void);
    await this.checkHealth();
  }

  private async checkHealth(): Promise<void> {
    this.library.showChecking();
    try {
      this.healthStatus = await this.repository.health();
      const capability = this.healthStatus.kind === 'onlineFull' ? 'חיפוש ועיון' : 'חיפוש בלבד';
      const version = this.healthStatus.serverVersion ? ` · גרסה ${this.healthStatus.serverVersion}` : '';
      this.library.showReady(
        `שירות החיפוש מחובר (${capability})${version}`,
        this.hebrewBooksPath,
        outdatedServiceMessage(this.healthStatus.serverVersion),
      );
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

    this.invalidateResultOpen();
    const cancellation = this.replaceSearchCancellation();
    const requestId = this.latestSearch.begin();
    // הטקסט שנשלח למנוע נקי מתווי הפעולה שלו; המשתמש ממשיך לראות את שלו.
    const sent = plainSearchQuery(query);
    if (sent === '') {
      await this.showHostError('החיפוש מכיל תווים מיוחדים של מנוע החיפוש בלבד; יש להזין מילות חיפוש');
      return;
    }
    this.snapshot = {
      query: sent,
      ...(sent === query ? {} : { displayQuery: query }),
      options,
      fingerprint: createFingerprint(sent, options),
    };
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
            warnings: partial.warnings,
            nextCursor: null,
          }, 'מוצגות תוצאות שהתקבלו; החיפוש ממשיך…');
          return true;
        },
        cancellation.signal,
      );
      if (!this.latestSearch.isCurrent(requestId)) return;
      // חיפוש שבוטל מחזיר תמונה חלקית ולא סופית — "אין תוצאות" על בסיסה
      // הוא שקר למשתמש שכבר ראה תוצאות על המסך.
      if (cancellation.signal.aborted) return;
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
          warnings: searchPage.warnings,
          nextCursor: null,
        });
      }
    } catch (error) {
      if (!this.latestSearch.isCurrent(requestId)) return;
      // ספרים שכבר נמצאו לפני שהזרם נפל שווים יותר ממסך ריק: הם נשארים,
      // ושורת האזהרה שמעליהם אומרת שהחיפוש לא הושלם. רק כשאין מה להציג
      // המסך כולו הופך להודעת שגיאה.
      const found = this.resultList;
      this.results.setSearch(query, found.length, true, undefined, false, hebrewBooksSearchTerms(options));
      if (found.length === 0) this.results.showError(messageOf(error));
      else {
        this.results.showResults({
          results: found.map((hit) => ({
            source: 'hebrewbooks',
            categoryPath: 'ספרי היברובוקס',
            hit,
          })),
          otzariaTotal: 0,
          hebrewBooksTotal: sumHitCounts(found),
          truncated: false,
          warnings: [`החיפוש בהיברובוקס נכשל: ${messageOf(error)}`],
          nextCursor: null,
        });
      }
    } finally {
      this.releaseSearchCancellation(cancellation);
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

  /// מסך התוסף מציג תוצאות היברובוקס בלבד; תוצאות אוצריא מוצגות
  /// בטאב החיפוש המובנה, לצד המדור החיצוני שלנו.
  private async openResult(result: UnifiedSearchResult): Promise<void> {
    if (result.source !== 'hebrewbooks') return;
    // ספר מהאוסף האישי אינו בקטלוג היברובוקס, ולכן טוען הספקים של אוצריא
    // אינו יודע לפתוח את מזההו הסינתטי — התוסף מציג אותו במציג שלו.
    if (result.hit.sourceType === 'Personal') {
      await this.openBook(result.hit);
      return;
    }
    const openRequestId = this.latestResultOpen.begin();
    try {
      const snapshot = this.snapshot;
      if (!snapshot) return;
      const locations = await this.server.locateOpeningInBook(snapshot, result.hit.fileId);
      if (!this.isCurrentResultOpen(openRequestId) || this.snapshot !== snapshot) return;
      // בעיגון מילה ראשונה/אחרונה מספרי העמודים אינם מיקומי התאמה אמינים —
      // פותחים מעמוד 1 ולא מעבירים אותם לקורא.
      const anchored = snapshot.options.firstWord || snapshot.options.lastWord;
      const page = anchored ? 1 : locations.pages[0] ?? 1;
      const externalId = externalIdOf(result.hit.fileId);
      if (externalId === null) throw new Error('מזהה הספר בהיברובוקס אינו תקין');
      const opened = await this.otzariaRepository.openBook(
        { external: { provider: 'hebrewbooks', id: externalId } },
        // ב-PDF אוצריא מונה עמודים מ-1 (PdfBookTab.pageNumber), כמו matchPages.
        Math.max(1, page),
        displayQueryOf(snapshot),
        anchored
          ? undefined
          : { pages: locations.pages, matchedTerms: locations.matchedTerms },
      );
      if (!this.isCurrentResultOpen(openRequestId)) return;
      if (!opened) throw new Error('הספר לא נמצא בקטלוג היברובוקס של אוצריא');
    } catch (error) {
      if (!this.isCurrentResultOpen(openRequestId)) return;
      await this.showHostError(messageOf(error));
    }
  }

  private async loadSnippet(result: HebrewBooksResult): Promise<ResultSnippet> {
    const snapshot = this.snapshot;
    if (!snapshot) return { page: null, text: null };
    let page = result.firstHitPage;
    if (page === null) {
      try {
        // מסך התוצאות מפעיל זאת רק כשהכרטיס נכנס לאזור התצוגה. נשמרת
        // חתימת החיפוש המקורית כדי שהעמוד שייך לאפשרויות שהפיקו את התוצאה.
        page = (await this.server.locateInBook(snapshot, result.fileId)).pages[0] ?? null;
      } catch (error) {
        console.warn(`snippet ${result.fileId}: inbook failed — ${messageOf(error)}`);
        return { page: null, text: null, lookupFailed: true };
      }
    }
    if (this.snapshot !== snapshot || page === null) return { page: null, text: null };
    const text = await this.repository.withPdfAccess(result.fileId, (url) =>
      this.snippets.load(url, result.fileId, page, displayQueryOf(snapshot)));
    return this.snapshot === snapshot ? { page, text } : { page: null, text: null };
  }

  private async openBook(result: HebrewBooksResult): Promise<void> {
    const openRequestId = this.latestResultOpen.begin();
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.selectedResult = result;
    this.showScreen('viewer');
    this.viewer.setSearchQuery(displayQueryOf(snapshot));
    try {
      // בלי מזהה מספרי אין כתובת PDF להגיש למציג.
      if (externalIdOf(result.fileId) === null) {
        throw new Error('שירות היברובוקס המותקן אינו מספק מזהה לספר זה; עדכן אותו כדי לפתוח ספרי אוסף אישי');
      }
      const locations = await this.server.locateOpeningInBook(snapshot, result.fileId);
      if (!this.isCurrentResultOpen(openRequestId) || this.snapshot !== snapshot) return;
      // כשהחיפוש מוגבל למילה ראשונה/אחרונה בעמוד, מספרי העמודים אינם מיקומי
      // התאמה ולכן נפתחים מתחילת הספר — כמו במסך התוצאות של אוצריא.
      const anchored = snapshot.options.firstWord || snapshot.options.lastWord;
      const initialPage = anchored ? 1 : locations.pages[0] ?? 1;
      await this.repository.withPdfAccess(result.fileId, async (url) => {
        // A token refresh can finish after the user has opened a different result.
        if (!this.isCurrentResultOpen(openRequestId) || this.snapshot !== snapshot) return;
        await this.viewer.openBook(result.bookName, url, locations.pages, initialPage);
      });
    } catch (error) {
      if (!this.isCurrentResultOpen(openRequestId)) return;
      this.showScreen('results');
      await this.showHostError(messageOf(error));
    }
  }

  private async searchInBook(query: string): Promise<void> {
    const snapshot = this.snapshot;
    const result = this.selectedResult;
    if (!snapshot || !result) return;
    try {
      // displayQuery של החיפוש המקורי היה גובר כאן ומדגיש מילים אחרות.
      const locations = await this.repository.inBook(
        { ...snapshot, query: plainSearchQuery(query), displayQuery: query },
        result.fileId,
      );
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
        searchQuery: this.snapshot && isSimpleSearch(this.snapshot.options) ? displayQueryOf(this.snapshot) : '',
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

  private invalidateResultOpen(): void {
    this.latestResultOpen.begin();
  }

  private isCurrentResultOpen(requestId: number): boolean {
    return this.latestResultOpen.isCurrent(requestId);
  }

  private async showHostError(message: string): Promise<void> {
    await this.bridge.call('ui.showError', { message });
  }
}

function hebrewBooksSearchTerms(options: SearchOptions): SearchTerms {
  return { source: 'hebrewbooks', options };
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
