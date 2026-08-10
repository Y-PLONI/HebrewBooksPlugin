import type { HostBridge } from './bridge';
import { requireHostData } from './bridge';
import { defaultSearchOptions, type HealthStatus, type HebrewBooksResult, type InBookLocations, type SearchOptions, type SearchSnapshot } from './models';
import { HebrewBooksRepository } from './repositories/hebrewbooks-repository';
import { applyTheme } from './theme';
import { PdfViewerController } from './viewer/pdf-viewer-controller';

type Screen = 'home' | 'results' | 'viewer';

export class AppController {
  private readonly repository: HebrewBooksRepository;
  private readonly viewer: PdfViewerController;
  private healthStatus: HealthStatus | null = null;
  private snapshot: SearchSnapshot | null = null;
  private results: HebrewBooksResult[] = [];
  private selectedResult: HebrewBooksResult | null = null;
  private locations: InBookLocations | null = null;
  private searchInFlight = false;

  constructor(private readonly bridge: HostBridge) {
    this.repository = new HebrewBooksRepository(bridge);
    this.viewer = new PdfViewerController(element('pdf-canvas', HTMLCanvasElement), element('pdf-stage'));
    this.bindEvents();
    this.viewer.onChanged = (page, count, zoom) => this.updateViewerState(page, count, zoom);
    this.viewer.onLoading = (loading) => element('pdf-loading').classList.toggle('hidden', !loading);
  }

  async boot(payload: OtzariaBootPayload): Promise<void> {
    applyTheme(payload.theme);
    this.bridge.on('theme.changed', ((theme: OtzariaTheme) => applyTheme(theme)) as (payload: never) => void);
    this.showScreen('home');
    await this.checkHealth();
    element('home-query', HTMLInputElement).focus();
  }

  private bindEvents(): void {
    element('home-search-form', HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      const query = element('home-query', HTMLInputElement).value;
      element('results-query', HTMLInputElement).value = query;
      void this.performSearch(query);
    });
    element('results-search-form', HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      void this.performSearch(element('results-query', HTMLInputElement).value);
    });
    document.querySelectorAll<HTMLElement>('[data-open-options]').forEach((button) => {
      button.addEventListener('click', () => element('search-options-dialog', HTMLDialogElement).showModal());
    });
    element('retry-health').addEventListener('click', () => void this.checkHealth());
    element('viewer-back').addEventListener('click', () => this.showScreen('results'));
    element('previous-page').addEventListener('click', () => void this.viewer.goToPage(this.viewer.currentPage - 1));
    element('next-page').addEventListener('click', () => void this.viewer.goToPage(this.viewer.currentPage + 1));
    element('zoom-in').addEventListener('click', () => void this.viewer.zoomBy(1.2));
    element('zoom-out').addEventListener('click', () => void this.viewer.zoomBy(1 / 1.2));
    element('zoom-reset').addEventListener('click', () => void this.viewer.fitWidth());
    element('rotate-page').addEventListener('click', () => void this.viewer.rotate());
    element('toggle-matches').addEventListener('click', () => element('matches-panel').classList.toggle('closed'));
    element('close-matches').addEventListener('click', () => element('matches-panel').classList.add('closed'));
    element('open-text-edition').addEventListener('click', () => {
      if (this.selectedResult) void this.openInOtzaria(this.selectedResult);
    });
    element('page-input', HTMLInputElement).addEventListener('change', (event) => {
      const page = Number((event.currentTarget as HTMLInputElement).value);
      if (Number.isFinite(page)) void this.viewer.goToPage(page);
    });
    window.addEventListener('resize', debounce(() => {
      if (!element('screen-viewer').classList.contains('hidden')) void this.viewer.fitWidth();
    }, 180));
  }

  private async checkHealth(): Promise<void> {
    const status = element('server-status');
    const retry = element('retry-health');
    status.className = 'status-badge checking';
    status.textContent = 'בודק שירות…';
    retry.classList.add('hidden');
    try {
      this.healthStatus = await this.repository.health();
      status.className = 'status-badge online';
      status.textContent = this.healthStatus.kind === 'onlineFull' ? 'השירות מחובר' : 'חיפוש זמין';
    } catch {
      this.healthStatus = null;
      status.className = 'status-badge offline';
      status.textContent = 'השירות אינו מחובר';
      retry.classList.remove('hidden');
    }
  }

  private async performSearch(rawQuery: string): Promise<void> {
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

    const options = this.readSearchOptions();
    if (options.corpus.length === 0) {
      await this.showHostError('יש לבחור מקור אחד לפחות');
      return;
    }

    this.snapshot = { query, options, fingerprint: createFingerprint(query, options) };
    element('home-query', HTMLInputElement).value = query;
    element('results-query', HTMLInputElement).value = query;
    this.showScreen('results');
    this.searchInFlight = true;
    element('results-submit', HTMLButtonElement).disabled = true;
    this.renderLoading();
    try {
      this.results = await this.repository.search(this.snapshot);
      this.renderResults();
    } catch (error) {
      this.results = [];
      this.renderError(messageOf(error));
    } finally {
      this.searchInFlight = false;
      element('results-submit', HTMLButtonElement).disabled = false;
    }
  }

  private renderLoading(): void {
    element('results-summary').textContent = 'מחפש בספריית HebrewBooks…';
    const content = element('results-content');
    content.replaceChildren(buildState('spinner', 'מחפש…', 'החיפוש עשוי להימשך מספר רגעים.'));
  }

  private renderResults(): void {
    const content = element('results-content');
    content.replaceChildren();
    const count = this.results.length;
    element('results-summary').textContent = count === this.snapshot?.options.limit
      ? `מוצגות ${count} תוצאות; ייתכנו תוצאות נוספות`
      : `התקבלו ${count} תוצאות`;
    if (count === 0) {
      content.append(buildState('search', 'אין תוצאות', 'נסה לשנות את מילות החיפוש או את אפשרויות החיפוש.'));
      return;
    }

    const list = document.createElement('ol');
    list.className = 'results-list';
    this.results.forEach((result, index) => list.append(this.buildResultCard(result, index)));
    content.append(list);
  }

  private buildResultCard(result: HebrewBooksResult, index: number): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'result-card';
    const number = document.createElement('span');
    number.className = 'result-number';
    number.textContent = String(index + 1);

    const type = document.createElement('span');
    type.className = 'result-type';
    type.textContent = result.sourceType === 'PDF' ? 'PDF' : result.sourceType === 'Text' ? 'טקסט' : 'אישי';

    const body = document.createElement('div');
    body.className = 'result-body';
    const heading = document.createElement('div');
    heading.className = 'result-title-row';
    const title = document.createElement('h3');
    title.textContent = result.bookName;
    heading.append(title, type);

    const metadata = document.createElement('p');
    metadata.className = 'result-metadata';
    metadata.textContent = [result.authorName, result.printPlace, result.printYear].filter(Boolean).join(' • ') || 'ללא פרטים נוספים';
    const details = document.createElement('p');
    details.className = 'result-details';
    details.textContent = `${result.hitCount} מופעים${result.countPage ? ` • ${result.countPage} עמודים` : ''}`;

    const actions = document.createElement('div');
    actions.className = 'result-actions';
    const open = button(result.sourceType === 'PDF' ? 'פתח ספר' : 'פתח באוצריא', 'primary-button compact');
    open.addEventListener('click', () => result.sourceType === 'PDF' ? void this.openPdf(result) : void this.openInOtzaria(result));
    const website = button('פתח באתר', 'text-button compact');
    website.addEventListener('click', () => void this.openWebsite(result));
    actions.append(open, website);
    body.append(heading, metadata, details, actions);
    item.append(number, body);
    return item;
  }

  private renderError(message: string): void {
    element('results-summary').textContent = 'החיפוש נכשל';
    element('results-content').replaceChildren(buildState('error', 'לא ניתן להשלים את החיפוש', message));
  }

  private async openPdf(result: HebrewBooksResult): Promise<void> {
    if (!this.snapshot) return;
    this.selectedResult = result;
    this.showScreen('viewer');
    element('top-bar-title').textContent = result.bookName;
    element('matches-list').replaceChildren();
    element('matches-summary').textContent = 'מאתר עמודים…';
    try {
      this.locations = await this.repository.inBook(this.snapshot, result.fileId);
      this.renderMatches(this.locations.pages);
      const hasAnchors = this.snapshot.options.firstWord || this.snapshot.options.lastWord;
      const initialPage = hasAnchors ? 1 : this.locations.pages[0] ?? 1;
      await this.viewer.open(this.repository.pdfUrl(result.fileId), initialPage);
    } catch (error) {
      this.showScreen('results');
      await this.showHostError(messageOf(error));
    }
  }

  private renderMatches(pages: number[]): void {
    const list = element('matches-list', HTMLOListElement);
    list.replaceChildren();
    element('matches-summary').textContent = pages.length === 0
      ? 'לא נמצאו עמודים מדויקים'
      : pages.length === 1
        ? 'עמוד אחד עם התאמה'
        : `${pages.length} עמודים עם התאמות`;
    for (const page of pages) {
      const item = document.createElement('li');
      const pageButton = button(`עמוד ${page}`, 'match-button');
      pageButton.addEventListener('click', () => void this.viewer.goToPage(page));
      item.append(pageButton);
      list.append(item);
    }
  }

  private updateViewerState(page: number, count: number, zoom: number): void {
    element('page-input', HTMLInputElement).value = String(page);
    element('page-count').textContent = `/ ${count}`;
    element('zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
    document.querySelectorAll('.match-button').forEach((button) => {
      button.classList.toggle('active', button.textContent === `עמוד ${page}`);
    });
  }

  private async openInOtzaria(result: HebrewBooksResult): Promise<void> {
    try {
      const books = await requireHostData<Array<{ bookId: string; title: string }>>(this.bridge, 'library.findBooks', { query: result.bookName, limit: 20 });
      const normalizedTitle = normalizeTitle(result.bookName);
      const matches = books.filter((book) => normalizeTitle(book.title) === normalizedTitle);
      if (matches.length !== 1 || !matches[0]) throw new Error('לא נמצאה מהדורת טקסט תואמת בספריית אוצריא');
      const opened = await requireHostData<boolean>(this.bridge, 'reader.openBook', {
        bookId: matches[0].bookId,
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
      await requireHostData<boolean>(this.bridge, 'app.openUrl', { url: `https://hebrewbooks.org/${encodeURIComponent(result.fileId)}` });
    } catch (error) {
      await this.showHostError(messageOf(error));
    }
  }

  private readSearchOptions(): SearchOptions {
    const checkedOptions = new Set(
      [...document.querySelectorAll<HTMLInputElement>('[data-option]:checked')].map((input) => input.dataset.option),
    );
    const corpus = [...document.querySelectorAll<HTMLInputElement>('[data-corpus]:checked')]
      .map((input) => input.dataset.corpus)
      .filter((value): value is 'pdf' | 'otzraya' | 'personal' => value === 'pdf' || value === 'otzraya' || value === 'personal');
    const limit = numberInput('option-limit', 50, 200);
    return {
      ...defaultSearchOptions,
      proximity: numberInput('option-proximity', 1, 100),
      fuzziness: numberInput('option-fuzziness', 0, 10),
      limit,
      max: Math.min(limit * 5, 1000),
      sort: element('option-sort', HTMLSelectElement).value as SearchOptions['sort'],
      corpus,
      hybur: checkedOptions.has('hybur'),
      roots: checkedOptions.has('roots'),
      gematria: checkedOptions.has('gematria'),
      spelling: checkedOptions.has('spelling'),
      numberGender: checkedOptions.has('numberGender'),
      aramaic: checkedOptions.has('aramaic'),
      rashetevot: checkedOptions.has('rashetevot'),
      requireWordOrder: checkedOptions.has('requireWordOrder'),
      rashiOcr: checkedOptions.has('rashiOcr'),
      firstWord: checkedOptions.has('firstWord'),
      lastWord: checkedOptions.has('lastWord'),
    };
  }

  private showScreen(screen: Screen): void {
    (['home', 'results', 'viewer'] as Screen[]).forEach((name) => element(`screen-${name}`).classList.toggle('hidden', name !== screen));
    element('viewer-back').classList.toggle('hidden', screen !== 'viewer');
    element('viewer-page-control').classList.toggle('hidden', screen !== 'viewer');
    element('server-status').classList.toggle('hidden', screen === 'viewer');
    element('retry-health').classList.toggle('viewer-hidden', screen === 'viewer');
    if (screen !== 'viewer') element('top-bar-title').textContent = 'היברובוקס';
  }

  private async showHostError(message: string): Promise<void> {
    await this.bridge.call('ui.showError', { message });
  }
}

function element<T extends HTMLElement>(id: string, constructor?: { new (): T }): T {
  const found = document.getElementById(id);
  if (!found || (constructor && !(found instanceof constructor))) throw new Error(`חסר רכיב ממשק: ${id}`);
  return found as T;
}

function buildState(kind: 'spinner' | 'search' | 'error', title: string, message: string): HTMLElement {
  const state = document.createElement('div');
  state.className = `informative-state ${kind}`;
  const icon = document.createElement('span');
  icon.className = kind === 'spinner' ? 'spinner' : 'state-icon';
  icon.textContent = kind === 'error' ? '!' : kind === 'search' ? '⌕' : '';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const body = document.createElement('p');
  body.textContent = message;
  state.append(icon, heading, body);
  return state;
}

function button(label: string, className: string): HTMLButtonElement {
  const result = document.createElement('button');
  result.type = 'button';
  result.className = className;
  result.textContent = label;
  return result;
}

function numberInput(id: string, minimum: number, maximum: number): number {
  const control = element(id);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
    throw new Error(`בקר המספר ${id} אינו תקין`);
  }
  const value = Number(control.value);
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), minimum), maximum) : minimum;
}

function createFingerprint(query: string, options: SearchOptions): string {
  return `${query}\u0000${JSON.stringify(options)}`;
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').replace(/[\u0591-\u05C7]/g, '').replace(/[׳״'"־–—-]/g, '').replace(/\s+/g, ' ').trim();
}

function isSimpleSearch(options: SearchOptions): boolean {
  return options.fuzziness === 0 && !options.hybur && !options.roots && !options.gematria && !options.spelling && !options.numberGender && !options.aramaic && !options.rashetevot && !options.rashiOcr;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'אירעה שגיאה לא צפויה';
}

function debounce(callback: () => void, milliseconds: number): () => void {
  let timeout: number | undefined;
  return () => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(callback, milliseconds);
  };
}
