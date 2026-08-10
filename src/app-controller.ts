import type { HostBridge } from './bridge';
import { requireHostData } from './bridge';
import type { HealthStatus, HebrewBooksResult, SearchOptions, SearchSnapshot } from './models';
import { HebrewBooksRepository } from './repositories/hebrewbooks-repository';
import { LibraryScreen } from './screens/library-screen';
import { ResultsScreen } from './screens/results-screen';
import { SearchDialog } from './screens/search-dialog';
import { ViewerScreen } from './screens/viewer-screen';
import { applyTheme } from './theme';

type Screen = 'library' | 'results' | 'viewer';

export class AppController {
  private readonly repository: HebrewBooksRepository;
  private readonly library: LibraryScreen;
  private readonly results: ResultsScreen;
  private readonly viewer: ViewerScreen;
  private readonly dialog: SearchDialog;

  private healthStatus: HealthStatus | null = null;
  private snapshot: SearchSnapshot | null = null;
  private resultList: HebrewBooksResult[] = [];
  private selectedResult: HebrewBooksResult | null = null;
  private searchInFlight = false;

  constructor(private readonly bridge: HostBridge, shell: HTMLElement) {
    this.repository = new HebrewBooksRepository(bridge);

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
      onSortChanged: (sort) => {
        if (!this.snapshot) return;
        void this.performSearch(this.snapshot.query, { ...this.snapshot.options, sort });
      },
      onOpenBook: (result) => void this.openBook(result),
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
    if (this.searchInFlight) return;
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

    this.snapshot = { query, options, fingerprint: createFingerprint(query, options) };
    this.showScreen('results');
    this.results.setSearch(this.snapshot, null);
    this.results.showLoading();
    this.searchInFlight = true;
    try {
      this.resultList = await this.repository.search(this.snapshot);
      this.results.setSearch(this.snapshot, this.resultList.length);
      if (this.resultList.length === 0) this.results.showNoResults();
      else this.results.showResults(this.resultList, this.resultList.length >= options.limit);
    } catch (error) {
      this.resultList = [];
      this.results.setSearch(this.snapshot, 0);
      this.results.showError(messageOf(error));
    } finally {
      this.searchInFlight = false;
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
