import type { HostBridge } from './bridge';
import { requireHostData } from './bridge';
import type {
  HealthStatus,
  HebrewBooksResult,
  HostSearchRequest,
  HostSearchRequestedEvent,
  SearchOptions,
  SearchSnapshot,
  UnifiedSearchResponse,
  UnifiedSearchResult,
} from './models';
import { CatalogMappingRepository } from './repositories/catalog-mapping-repository';
import { HebrewBooksRepository } from './repositories/hebrewbooks-repository';
import { OtzariaSearchRepository } from './repositories/otzaria-search-repository';
import { LibraryScreen } from './screens/library-screen';
import { ResultsScreen } from './screens/results-screen';
import { SearchDialog } from './screens/search-dialog';
import { ViewerScreen } from './screens/viewer-screen';
import { LatestRequest } from './services/latest-request';
import {
  mergeUnifiedSearchResponses,
  UnifiedSearchService,
  toHebrewBooksSnapshot,
} from './services/unified-search-service';
import { applyTheme } from './theme';

type Screen = 'library' | 'results' | 'viewer';

export class AppController {
  private readonly repository: HebrewBooksRepository;
  private readonly otzariaRepository: OtzariaSearchRepository;
  private readonly unifiedSearch: UnifiedSearchService;
  private readonly library: LibraryScreen;
  private readonly results: ResultsScreen;
  private readonly viewer: ViewerScreen;
  private readonly dialog: SearchDialog;

  private healthStatus: HealthStatus | null = null;
  private snapshot: SearchSnapshot | null = null;
  private resultList: HebrewBooksResult[] = [];
  private selectedResult: HebrewBooksResult | null = null;
  private readonly latestSearch = new LatestRequest();
  private unifiedRequest: HostSearchRequest | null = null;
  private unifiedResponse: UnifiedSearchResponse | null = null;
  private unifiedRequestId: number | null = null;
  private loadingMore = false;

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
      void this.performSearch(request.query, request.options);
    });

    this.bridge.on('search.requested', ((payload: HostSearchRequestedEvent) => {
      void this.performUnifiedSearch(payload);
    }) as (payload: never) => void);

    shell.append(this.library.root, this.results.root, this.viewer.root);
    this.showScreen('library');
  }

  async boot(payload: OtzariaBootPayload): Promise<void> {
    applyTheme(payload.theme);
    this.bridge.on('theme.changed', ((theme: OtzariaTheme) => applyTheme(theme)) as (payload: never) => void);
    await this.checkHealth();
  }

  private async checkHealth(): Promise<void> {
    this.library.showChecking();
    try {
      this.healthStatus = await this.repository.health();
      const capability = this.healthStatus.kind === 'onlineFull' ? 'חיפוש ועיון' : 'חיפוש בלבד';
      const version = this.healthStatus.serverVersion ? ` · גרסה ${this.healthStatus.serverVersion}` : '';
      this.library.showReady(`שירות החיפוש מחובר (${capability})${version}`);
    } catch (error) {
      this.healthStatus = null;
      this.library.showOffline(
        `${messageOf(error)}\nוודא שהשירות המקומי של היברובוקס פועל, ולחץ "בדוק שוב".`,
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

    const requestId = this.latestSearch.begin();
    this.clearUnifiedSearch();
    this.snapshot = { query, options, fingerprint: createFingerprint(query, options) };
    this.showScreen('results');
    this.results.setSearch(query, null, true);
    this.results.showLoading();
    try {
      const resultList = await this.repository.search(this.snapshot);
      if (!this.latestSearch.isCurrent(requestId)) return;
      this.resultList = resultList;
      this.results.setSearch(query, this.resultList.length, true);
      if (this.resultList.length === 0) this.results.showNoResults();
      else {
        this.results.showResults({
          results: this.resultList.map((hit) => ({
            source: 'hebrewbooks',
            categoryPath: 'ספרי היברובוקס',
            hit,
          })),
          otzariaTotal: 0,
          hebrewBooksTotal: this.resultList.reduce((total, result) => total + result.hitCount, 0),
          truncated: this.resultList.length >= options.limit,
          warnings: [],
          nextCursor: null,
        });
      }
    } catch (error) {
      if (!this.latestSearch.isCurrent(requestId)) return;
      this.resultList = [];
      this.results.setSearch(query, 0, true);
      this.results.showError(messageOf(error));
    }
  }

  private async performUnifiedSearch(event: HostSearchRequestedEvent): Promise<void> {
    const request = event?.request;
    if (!isHostSearchRequest(request)) {
      await this.showHostError('בקשת החיפוש מאוצריא אינה תקינה');
      return;
    }
    const requestId = this.latestSearch.begin();
    this.unifiedRequest = request;
    this.unifiedResponse = null;
    this.unifiedRequestId = requestId;
    this.loadingMore = false;
    this.snapshot = toHebrewBooksSnapshot(request);
    this.showScreen('results');
    this.results.setSearch(request.query, null, false);
    this.results.showLoading();
    try {
      const response = await this.unifiedSearch.search(request, undefined, (partial) => {
        if (!this.latestSearch.isCurrent(requestId)) return false;
        this.results.setSearch(request.query, partial.results.length, false);
        this.results.showPartialResults(partial, 'תוצאות אוצריא מוכנות; החיפוש בהיברובוקס ממשיך…');
        return true;
      });
      if (!this.latestSearch.isCurrent(requestId)) return;
      this.unifiedResponse = response;
      this.resultList = response.results
        .filter((result): result is Extract<UnifiedSearchResult, { source: 'hebrewbooks' }> => result.source === 'hebrewbooks')
        .map((result) => result.hit);
      this.results.setSearch(request.query, response.results.length, false);
      if (response.results.length === 0) this.results.showNoResults();
      else this.results.showResults(response);
    } catch (error) {
      if (!this.latestSearch.isCurrent(requestId)) return;
      this.resultList = [];
      this.results.setSearch(request.query, 0, false);
      this.results.showError(messageOf(error));
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
    try {
      const page = await this.unifiedSearch.search(request, cursor);
      if (!this.latestSearch.isCurrent(requestId)) return;
      const response = mergeUnifiedSearchResponses(current, page);
      this.unifiedResponse = response;
      this.resultList = response.results
        .filter(
          (result): result is Extract<UnifiedSearchResult, { source: 'hebrewbooks' }> =>
            result.source === 'hebrewbooks',
        )
        .map((result) => result.hit);
      this.results.setSearch(request.query, response.results.length, false);
      this.results.showResults(response);
    } catch (error) {
      if (!this.latestSearch.isCurrent(requestId)) return;
      this.results.setLoadingMore(false);
      await this.showHostError(messageOf(error));
    } finally {
      if (this.latestSearch.isCurrent(requestId)) this.loadingMore = false;
    }
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
      const page = snapshot.options.firstWord || snapshot.options.lastWord ? 1 : locations.pages[0] ?? 1;
      const externalId = Number(result.hit.fileId);
      if (!Number.isInteger(externalId) || externalId <= 0) throw new Error('מזהה הספר בהיברובוקס אינו תקין');
      const opened = await this.otzariaRepository.openBook(
        { external: { provider: 'hebrewbooks', id: externalId } },
        Math.max(0, page - 1),
        snapshot.query,
      );
      if (!opened) throw new Error('הספר לא נמצא בקטלוג היברובוקס של אוצריא');
    } catch (error) {
      await this.showHostError(messageOf(error));
    }
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
  return `${query} ${JSON.stringify(options)}`;
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
