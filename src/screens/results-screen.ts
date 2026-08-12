import type { IconName } from '../icons.generated';
import type {
  HebrewBooksResult,
  HostSearchRequest,
  SearchOptions,
  UnifiedSearchResponse,
  UnifiedSearchResult,
} from '../models';
import { appendHighlightedHtml } from '../utils/highlighted-html';
import { navTreeGroup, navTreeHeader, navTreeRow, slimSearchField } from '../ui/nav-tree';
import {
  actionButton,
  barButton,
  centeredProgress,
  compactIconButton,
  element,
  iconElement,
  informativeState,
  topBar,
  topBarDivider,
} from '../ui/widgets';

interface ResultsHandlers {
  readonly onBack: () => void;
  readonly onEditSearch: () => void;
  readonly onLoadMore: () => void;
  readonly onOpenResult: (result: UnifiedSearchResult) => void;
  readonly onOpenWebsite: (result: HebrewBooksResult) => void;
  readonly onCopyDetails: (result: HebrewBooksResult) => void;
  readonly onLoadSnippet: (result: HebrewBooksResult) => Promise<string | null>;
}

type ResultSource = UnifiedSearchResult['source'];

/// מפריד בין נתיב הקטגוריה לשם הספר ב-facet של ספר. תו בקרה שאינו יכול
/// להופיע בשם קטגוריה או ספר, ולכן מבדיל בוודאות בין שני סוגי ה-facet.
const BOOK_FACET_SEPARATOR = '\u0000';

/// אורך המינימום שממנו שדה "איתור ספר" מחליף את העץ ברשימת ספרים שטוחה
/// (_kMinQueryLength ב-full_text_facet_filtering.dart).
const MIN_FILTER_LENGTH = 2;

const sourceLabels: ReadonlyArray<{ source: ResultSource; label: string }> = [
  { source: 'otzaria', label: 'אוצריא' },
  { source: 'hebrewbooks', label: 'היברובוקס' },
];

export interface CategoryTreeBook {
  readonly facet: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly icon: IconName;
  readonly count: number;
}

export interface CategoryTreeNode {
  readonly path: string;
  readonly label: string;
  readonly depth: number;
  readonly count: number;
  readonly children: readonly CategoryTreeNode[];
  readonly books: readonly CategoryTreeBook[];
}

export type SearchTerms =
  | { source: 'hebrewbooks'; options: SearchOptions }
  | { source: 'otzaria'; request: HostSearchRequest };

export class ResultsScreen {
  readonly root = element('main', 'screen results-screen');
  private readonly body = element('div', 'screen-body results-body');
  private readonly center = element('div', 'top-bar-center');
  private readonly trailing = element('div', 'top-bar-trailing');
  private query = '';
  private response: UnifiedSearchResponse | null = null;
  private selectedFacet: string | null = null;
  private hiddenSources = new Set<ResultSource>();
  private expansion = new Map<string, boolean>();
  private filterQuery = '';
  private sourceMenuOpen = false;
  private editable = false;
  private loadingMore = false;
  private loadMoreButton: HTMLButtonElement | null = null;
  private pendingMessage: string | null = null;
  private treeHost: HTMLElement | null = null;
  private snippetObserver: IntersectionObserver | null = null;
  private snippetGeneration = 0;
  private readonly snippetTargets = new Map<HTMLElement, HebrewBooksResult>();

  constructor(private readonly handlers: ResultsHandlers) {
    const bar = topBar();
    bar.leading.append(
      barButton({
        tooltip: 'חזרה למסך הפתיחה',
        icon: 'arrow_left_24_regular',
        mirrored: true,
        onClick: handlers.onBack,
      }),
    );
    bar.root.replaceChildren(bar.leading, this.center, this.trailing);
    this.root.append(bar.root, this.body);
  }

  setSearch(
    query: string,
    count: number | null,
    editable: boolean,
    totalCount?: number,
    totalIsLowerBound = false,
    searchTerms?: SearchTerms | null,
  ): void {
    this.query = query;
    this.editable = editable;
    this.center.replaceChildren(
      element('span', 'top-bar-count', 'מוצגות תוצאות של חיפוש: '),
      ...buildSearchTerms(query, searchTerms ?? null),
      ...(editable
        ? [barButton({ tooltip: 'ערוך חיפוש', icon: 'edit_24_regular', onClick: this.handlers.onEditSearch })]
        : []),
    );
    this.trailing.replaceChildren(
      element(
        'span',
        'top-bar-count',
        count === null
          ? 'מחפש בשני המאגרים…'
          : totalCount === undefined
            ? `${count} תוצאות מוצגות`
            : `${totalIsLowerBound ? 'לפחות ' : ''}${totalCount} תוצאות · ${count} פריטים מוצגים`,
      ),
      topBarDivider(),
      element('span', 'source-label', 'אוצריא + היברובוקס'),
    );
  }

  showLoading(): void {
    this.resetState();
    this.body.replaceChildren(centeredProgress());
  }

  showNoResults(): void {
    this.resetState();
    this.body.replaceChildren(
      informativeState({
        icon: 'document_search_24_regular',
        title: 'אין תוצאות',
        message: 'לא נמצאו תוצאות באוצריא או בהיברובוקס. נסה לשנות את מילות החיפוש.',
        action: this.editable
          ? { text: 'ערוך חיפוש', icon: 'edit_24_regular', onClick: this.handlers.onEditSearch }
          : undefined,
      }),
    );
  }

  showError(message: string): void {
    this.resetState();
    this.body.replaceChildren(
      informativeState({
        icon: 'warning_24_regular',
        title: 'לא ניתן להשלים את החיפוש',
        message,
        action: this.editable
          ? { text: 'ערוך חיפוש', icon: 'edit_24_regular', onClick: this.handlers.onEditSearch }
          : undefined,
      }),
    );
  }

  showResults(response: UnifiedSearchResponse): void {
    const scrollTop = this.body.querySelector<HTMLElement>('.results-list')?.scrollTop ?? 0;
    this.response = response;
    this.loadingMore = false;
    this.pendingMessage = null;
    this.renderResults(scrollTop);
  }

  showPartialResults(response: UnifiedSearchResponse, pendingMessage: string): void {
    this.response = response;
    this.loadingMore = false;
    this.pendingMessage = pendingMessage;
    this.renderResults();
  }

  setLoadingMore(loading: boolean): void {
    if (!this.response || this.loadingMore === loading) return;
    this.loadingMore = loading;
    if (!this.loadMoreButton) return;
    this.loadMoreButton.disabled = loading;
    this.loadMoreButton.replaceChildren(
      iconElement('arrow_download_24_regular', 18),
      document.createTextNode(loading ? 'טוען תוצאות נוספות…' : 'טען עוד תוצאות'),
    );
  }

  private resetState(): void {
    this.response = null;
    this.selectedFacet = null;
    this.hiddenSources = new Set();
    this.expansion = new Map();
    this.filterQuery = '';
    if (this.sourceMenuOpen) document.removeEventListener('click', this.closeSourceMenu);
    this.sourceMenuOpen = false;
    this.loadingMore = false;
    this.loadMoreButton = null;
    this.pendingMessage = null;
    this.treeHost = null;
  }

  /// התוצאות שנשארות אחרי סינון המקורות — הבסיס גם לעץ, גם למונים וגם לרשימה.
  private scopedResults(): UnifiedSearchResult[] {
    const response = this.response;
    if (!response) return [];
    if (this.hiddenSources.size === 0) return response.results;
    return response.results.filter((result) => !this.hiddenSources.has(result.source));
  }

  private renderResults(scrollTop = 0): void {
    const response = this.response;
    if (!response) return;
    this.loadMoreButton = null;
    const scoped = this.scopedResults();

    const layout = element('div', 'unified-results-layout');
    layout.append(this.buildNavigation(scoped));

    const content = element('section', 'categorized-results');
    const visible = scoped.filter((result) => facetMatches(this.selectedFacet, result));
    this.prepareSnippetLoading();
    const heading = element('div', 'category-results-heading', this.selectedFacetLabel());
    heading.append(element('span', undefined, ` · ${visible.length}`));
    content.append(heading);
    if (this.pendingMessage) content.append(buildProgressBanner(this.pendingMessage));
    for (const warning of response.warnings) content.append(buildWarningBanner(warning));
    if (response.truncated) content.append(buildTruncatedBanner());
    const list = element('ol', 'results-list');
    visible.forEach((result, index) => list.append(this.buildResultCard(result, index)));
    if (response.nextCursor) list.append(this.buildLoadMoreRow());
    content.append(list);

    layout.append(content);
    this.body.replaceChildren(layout);
    list.scrollTop = scrollTop;
  }

  // ── חלונית הניווט (SearchFacetFiltering + SearchNavigationTree) ────────────

  private buildNavigation(scoped: UnifiedSearchResult[]): HTMLElement {
    const navigation = element('aside', 'category-navigation');
    navigation.setAttribute('aria-label', 'קטגוריות תוצאות');

    const fieldWrap = element('div', 'nav-filter-field');
    const field = slimSearchField({
      hint: 'איתור ספר…',
      value: this.filterQuery,
      onInput: (value) => {
        this.filterQuery = value;
        this.renderTree();
      },
      onClear: () => {
        this.filterQuery = '';
        this.renderTree();
      },
      trailing: [this.buildSourceFilterButton()],
    });
    fieldWrap.append(field.root);
    navigation.append(fieldWrap);

    const treeHost = element('div', 'nav-tree');
    this.treeHost = treeHost;
    navigation.append(treeHost);
    this.renderTree(scoped);
    return navigation;
  }

  private renderTree(scoped: UnifiedSearchResult[] = this.scopedResults()): void {
    const host = this.treeHost;
    if (!host) return;
    host.replaceChildren(
      ...(this.filterQuery.trim().length >= MIN_FILTER_LENGTH
        ? this.buildFilteredBookList(scoped)
        : this.buildTreeRows(scoped)),
    );
  }

  private buildTreeRows(scoped: UnifiedSearchResult[]): HTMLElement[] {
    const anyFilterActive = this.selectedFacet !== null || this.hiddenSources.size > 0;
    const header = navTreeHeader({
      title: 'כל התוצאות',
      count: scoped.length,
      selected: !anyFilterActive,
      onSelect: () => this.clearAllFilters(),
      onClearFilter: anyFilterActive ? () => this.clearAllFilters() : undefined,
    });

    const rows: HTMLElement[] = [];
    for (const node of buildCategoryTree(scoped)) this.appendNodeRows(node, 0, rows);
    return rows.length === 0 ? [header] : [header, navTreeGroup(rows)];
  }

  private appendNodeRows(node: CategoryTreeNode, level: number, rows: HTMLElement[]): void {
    const expanded = this.expansion.get(node.path) ?? this.leadsToSelection(node.path);
    rows.push(
      navTreeRow({
        title: node.label,
        level,
        selected: this.selectedFacet === node.path,
        count: node.count,
        onSelect: () => this.selectFacet(node.path),
        expandable: {
          expanded,
          onToggle: () => {
            this.expansion.set(node.path, !expanded);
            this.renderTree();
          },
        },
      }),
    );
    if (!expanded) return;
    for (const child of node.children) this.appendNodeRows(child, level + 1, rows);
    for (const book of node.books) rows.push(this.buildBookRow(book, level + 1));
  }

  private buildBookRow(book: CategoryTreeBook, level: number): HTMLElement {
    return navTreeRow({
      title: book.title,
      subtitle: book.subtitle,
      level,
      selected: this.selectedFacet === book.facet,
      count: book.count,
      icon: book.icon,
      onSelect: () => this.selectFacet(book.facet),
    });
  }

  /// רשימת הספרים המסוננת לפי שדה האיתור — כל ספר בכרטיס משלו, כמו
  /// _buildFilteredBookList באוצריא.
  private buildFilteredBookList(scoped: UnifiedSearchResult[]): HTMLElement[] {
    const query = this.filterQuery.trim().toLowerCase();
    const matches = collectBooks(buildCategoryTree(scoped)).filter((book) =>
      book.title.toLowerCase().includes(query),
    );
    if (matches.length === 0) {
      return [element('div', 'nav-tree-empty', 'לא נמצאו ספרים עם תוצאות')];
    }
    return matches.map((book) => navTreeGroup([this.buildBookRow(book, 0)]));
  }

  /// כפתור הסינון שבתוך שדה האיתור — כאן הוא מסנן לפי מקור התוצאה, המקבילה
  /// של סינון המאפיינים (ספרי יסוד/תקופה) שבאוצריא.
  private buildSourceFilterButton(): HTMLElement {
    const anchor = element('div', 'nav-filter-anchor');
    const button = element('button', 'nav-filter-button');
    button.type = 'button';
    button.dataset.tooltip = 'סינון לפי מקור';
    button.setAttribute('aria-label', 'סינון לפי מקור');
    button.setAttribute('aria-expanded', String(this.sourceMenuOpen));
    if (this.hiddenSources.size > 0) button.classList.add('active');
    button.append(iconElement('filter_24_regular', 20));
    if (this.hiddenSources.size > 0) {
      button.append(element('span', 'nav-filter-badge', String(sourceLabels.length - this.hiddenSources.size)));
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.sourceMenuOpen) this.closeSourceMenu();
      else this.openSourceMenu();
    });
    anchor.append(button);

    if (this.sourceMenuOpen) {
      const menu = element('div', 'nav-filter-menu');
      menu.setAttribute('role', 'menu');
      menu.addEventListener('click', (event) => event.stopPropagation());
      for (const { source, label } of sourceLabels) {
        const active = !this.hiddenSources.has(source);
        const item = element('button', 'nav-filter-menu-item');
        item.type = 'button';
        item.setAttribute('role', 'menuitemcheckbox');
        item.setAttribute('aria-checked', String(active));
        item.append(
          iconElement(active ? 'checkbox_checked_24_filled' : 'checkbox_unchecked_24_regular', 18),
          element('span', undefined, label),
        );
        item.addEventListener('click', () => this.toggleSource(source));
        menu.append(item);
      }
      anchor.append(menu);
    }
    return anchor;
  }

  /// לחיצה מחוץ לתפריט סוגרת אותו, כמו MenuAnchor של אוצריא.
  private openSourceMenu(): void {
    this.sourceMenuOpen = true;
    document.addEventListener('click', this.closeSourceMenu);
    this.renderResults(this.currentScrollTop());
  }

  private readonly closeSourceMenu = (): void => {
    if (!this.sourceMenuOpen) return;
    this.sourceMenuOpen = false;
    document.removeEventListener('click', this.closeSourceMenu);
    this.renderResults(this.currentScrollTop());
  };

  /// כיבוי מקור אחרון אינו אפשרי — הוא היה מרוקן את המסך בלי חיווי.
  private toggleSource(source: ResultSource): void {
    const hidden = new Set(this.hiddenSources);
    if (hidden.has(source)) hidden.delete(source);
    else if (hidden.size + 1 < sourceLabels.length) hidden.add(source);
    else return;
    this.hiddenSources = hidden;
    if (this.selectedFacet !== null && !this.facetStillExists()) this.selectedFacet = null;
    this.renderResults(this.currentScrollTop());
  }

  private facetStillExists(): boolean {
    return this.scopedResults().some((result) => facetMatches(this.selectedFacet, result));
  }

  private selectFacet(facet: string): void {
    this.selectedFacet = facet;
    this.renderResults();
  }

  private clearAllFilters(): void {
    this.selectedFacet = null;
    this.hiddenSources = new Set();
    this.renderResults();
  }

  private leadsToSelection(path: string): boolean {
    const selected = this.selectedFacet;
    if (selected === null) return false;
    const separator = selected.indexOf(BOOK_FACET_SEPARATOR);
    const category = separator < 0 ? selected : selected.slice(0, separator);
    if (category.startsWith(`${path}/`)) return true;
    return separator >= 0 && category === path;
  }

  private selectedFacetLabel(): string {
    const selected = this.selectedFacet;
    if (selected === null) return 'כל התוצאות';
    const separator = selected.indexOf(BOOK_FACET_SEPARATOR);
    return separator < 0 ? categoryLabel(selected) : selected.slice(separator + 1);
  }

  private currentScrollTop(): number {
    return this.body.querySelector<HTMLElement>('.results-list')?.scrollTop ?? 0;
  }

  // ── רשימת התוצאות (tantivy_search_results.dart) ───────────────────────────

  private buildLoadMoreRow(): HTMLLIElement {
    const row = element('li', 'load-more-row');
    const button = actionButton({
      text: this.loadingMore ? 'טוען תוצאות נוספות…' : 'טען עוד תוצאות',
      variant: 'neutral',
      icon: 'arrow_download_24_regular',
      onClick: this.handlers.onLoadMore,
    });
    button.disabled = this.loadingMore;
    this.loadMoreButton = button;
    row.append(button);
    return row;
  }

  private buildResultCard(result: UnifiedSearchResult, index: number): HTMLLIElement {
    const item = element('li', 'result-card');
    const card = element('div', 'result-card-body');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const open = (): void => this.handlers.onOpenResult(result);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    card.append(element('span', 'result-index', String(index + 1)));
    card.append(result.source === 'otzaria' ? this.buildOtzariaContent(result) : this.buildHebrewBooksContent(result));
    item.append(card);
    return item;
  }

  private buildOtzariaContent(result: Extract<UnifiedSearchResult, { source: 'otzaria' }>): HTMLElement {
    const content = element('div', 'result-content');
    const titleRow = element('div', 'result-title-row');
    titleRow.append(iconElement('book_24_regular', 16, 'icon result-kind-icon'));
    titleRow.append(element('h3', 'result-title', result.hit.book));
    titleRow.append(element('span', 'result-source-badge otzaria', 'אוצריא'));
    content.append(titleRow);
    if (result.hit.reference) content.append(element('p', 'result-reference', result.hit.reference));
    const snippet = element('p', 'result-snippet');
    appendHighlightedHtml(snippet, result.hit.text);
    content.append(snippet);
    return content;
  }

  private buildHebrewBooksContent(
    result: Extract<UnifiedSearchResult, { source: 'hebrewbooks' }>,
  ): HTMLElement {
    const hit = result.hit;
    const content = element('div', 'result-content');
    const titleRow = element('div', 'result-title-row');
    titleRow.append(iconElement('document_pdf_24_regular', 16, 'icon result-kind-icon'));
    titleRow.append(element('h3', 'result-title', hit.bookName));
    titleRow.append(element('span', 'result-source-badge hebrewbooks', 'היברובוקס'));
    titleRow.append(
      compactIconButton('copy_24_regular', 'העתק את פרטי הספר', () => this.handlers.onCopyDetails(hit)),
      compactIconButton('open_24_regular', 'פתח באתר היברובוקס', () => this.handlers.onOpenWebsite(hit)),
    );
    content.append(titleRow);
    const reference = [hit.authorName, hit.printPlace, hit.printYear].filter(Boolean).join(' · ');
    if (reference) content.append(element('p', 'result-reference', reference));
    const meta = element('div', 'result-meta');
    meta.append(iconElement('layer_24_regular', 16));
    const pages = hit.countPage ? ` · ${hit.countPage} עמודים` : '';
    meta.append(element('span', undefined, `נמצאו ${hit.hitCount} מופעים${pages}`));
    content.append(meta, this.buildHebrewBooksSnippet(hit));
    return content;
  }

  private buildHebrewBooksSnippet(hit: HebrewBooksResult): HTMLElement {
    const snippet = element('p', 'result-snippet hebrewbooks-snippet');
    if (hit.firstHitPage === null) {
      snippet.textContent = 'לא התקבל מיקום לגזיר הטקסט';
      return snippet;
    }
    snippet.textContent = `טוען גזיר טקסט מעמוד ${hit.firstHitPage}…`;
    this.snippetTargets.set(snippet, hit);
    this.snippetObserver?.observe(snippet);
    return snippet;
  }

  private prepareSnippetLoading(): void {
    this.snippetGeneration += 1;
    this.snippetObserver?.disconnect();
    this.snippetTargets.clear();
    if (typeof IntersectionObserver !== 'function') {
      this.snippetObserver = null;
      return;
    }
    const generation = this.snippetGeneration;
    this.snippetObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLElement;
        const hit = this.snippetTargets.get(target);
        if (!hit) continue;
        this.snippetObserver?.unobserve(target);
        this.snippetTargets.delete(target);
        void this.handlers.onLoadSnippet(hit).then((text) => {
          if (generation !== this.snippetGeneration || !target.isConnected) return;
          target.textContent = text
            ? `עמוד ${hit.firstHitPage} · ${text}`
            : `לא ניתן היה לחלץ גזיר טקסט מעמוד ${hit.firstHitPage}`;
        });
      }
    }, { rootMargin: '300px 0px' });
  }
}

/// קיצורי האפשרויות של HebrewBooks, במסך החיפוש העצמאי של התוסף.
const hebrewBooksOptionAbbreviations: ReadonlyArray<{ key: keyof SearchOptions; abbr: string }> = [
  { key: 'hybur', abbr: 'או"ש' },
  { key: 'roots', abbr: 'שר' },
  { key: 'spelling', abbr: 'מח' },
  { key: 'gematria', abbr: 'גמ' },
  { key: 'numberGender', abbr: 'זנ' },
  { key: 'aramaic', abbr: 'אר' },
  { key: 'rashetevot', abbr: 'ר"ת' },
  { key: 'rashiOcr', abbr: 'OCR' },
  { key: 'requireWordOrder', abbr: 'סדר' },
  { key: 'firstWord', abbr: 'ראש' },
  { key: 'lastWord', abbr: 'סוף' },
];

/// הקיצורים ואפשרויות־הסיומת זהים ל-SearchTermsDisplay של אוצריא.
const otzariaOptionAbbreviations: Readonly<Record<string, string>> = {
  'קידומות': 'ק',
  'סיומות': 'ס',
  'קידומות דקדוקיות': 'קד',
  'סיומות דקדוקיות': 'סד',
  'כתיב מלא/חסר': 'מח',
  'חלק ממילה': 'ש',
  'קידומות ארמיות': 'קא',
  'סיומות ארמיות': 'סא',
  'התעלם מגרשיים': 'גר',
  'תרגום ארמי': 'תא',
  'ראשי תיבות': 'רת',
};

const otzariaSuffixOptions = new Set(['סיומות', 'סיומות דקדוקיות', 'סיומות ארמיות']);

function buildSearchTerms(query: string, searchTerms: SearchTerms | null): HTMLElement[] {
  if (!searchTerms) {
    return [element('span', 'search-term-word', query)];
  }
  if (searchTerms.source === 'otzaria') return buildOtzariaSearchTerms(searchTerms.request);
  return buildHebrewBooksSearchTerms(query, searchTerms.options);
}

function buildHebrewBooksSearchTerms(query: string, options: SearchOptions): HTMLElement[] {
  const activeAbbrs = hebrewBooksOptionAbbreviations
    .filter(({ key }) => options[key] === true)
    .map(({ abbr }) => abbr);

  const container = element('span', 'search-terms');

  // קיצורי אפשרויות לפני מילת החיפוש
  if (activeAbbrs.length > 0) {
    container.append(element('span', 'search-term-abbr', `(${activeAbbrs.join(',')})`));
  }

  // מילת החיפוש עצמה
  container.append(element('span', 'search-term-word', query));

  // proximity — מרחק בין מילים (רלוונטי רק כשיש יותר ממילה אחת)
  const words = query.trim().split(/\s+/);
  if (options.proximity > 1 && words.length > 1) {
    container.append(element('span', 'search-term-abbr', `מרחק: ${options.proximity}`));
  }

  // fuzziness — רמת קירוב
  if (options.fuzziness > 0) {
    container.append(element('span', 'search-term-abbr', `קירוב: ${options.fuzziness}`));
  }

  return [container];
}

/// מציג את בקשת אוצריא המקורית, ולא את ההמרה החלקית שנשלחה ל-HebrewBooks.
/// כך אפשרויות שאינן נתמכות ב-HebrewBooks נשארות גלויות עבור תוצאות אוצריא,
/// אך אינן מוצגות כאילו הן הופעלו במנוע השני.
function buildOtzariaSearchTerms(request: HostSearchRequest): HTMLElement[] {
  const words = request.query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [element('span', 'search-term-word', request.query)];

  const container = element('span', 'search-terms');
  for (const [index, word] of words.entries()) {
    const enabled = enabledOtzariaOptions(request, word, index);
    const prefixes = enabled.filter((option) => !otzariaSuffixOptions.has(option));
    const suffixes = enabled.filter((option) => otzariaSuffixOptions.has(option));
    if (prefixes.length > 0) {
      container.append(element('span', 'search-term-abbr', `(${prefixes.map(abbreviateOtzariaOption).join(',')})`));
    }
    container.append(element('span', 'search-term-word', word));
    if (suffixes.length > 0) {
      container.append(element('span', 'search-term-abbr', `(${suffixes.map(abbreviateOtzariaOption).join(',')})`));
    }
    if (index < words.length - 1) {
      const spacing = request.customSpacing?.[`${index}-${index + 1}`];
      container.append(element('span', 'search-term-word', spacing ? `+${spacing}` : '+'));
    }
  }
  return [container];
}

function enabledOtzariaOptions(request: HostSearchRequest, word: string, index: number): string[] {
  // wordOptions גובר על options עבור המילה כולה, בדיוק כמו ב-PluginSearchApi.
  const effectiveOptions = request.wordOptions?.[`${word}_${index}`] ?? request.options ?? {};
  return Object.entries(effectiveOptions)
    .filter(([, enabled]) => enabled === true)
    .map(([option]) => option);
}

function abbreviateOtzariaOption(option: string): string {
  return otzariaOptionAbbreviations[option] ?? option;
}

/// בניית עץ הקטגוריות מתוך התוצאות עצמן — המקבילה של פריסת ספריית אוצריא
/// לפי facetCounts. סדר הענפים הוא סדר ההופעה הראשונה בתוצאות, כלומר סדר
/// הקטלוג שבו הגיעו מהמנוע.
export function buildCategoryTree(results: readonly UnifiedSearchResult[]): CategoryTreeNode[] {
  interface MutableNode {
    path: string;
    label: string;
    depth: number;
    count: number;
    children: Map<string, MutableNode>;
    books: Map<string, CategoryTreeBook & { count: number }>;
  }

  const roots = new Map<string, MutableNode>();

  for (const result of results) {
    const ancestors = categoryAncestors(result.categoryPath);
    let siblings = roots;
    let leaf: MutableNode | undefined;
    for (const [depth, path] of ancestors.entries()) {
      let node = siblings.get(path);
      if (!node) {
        node = { path, label: categoryLabel(path), depth, count: 0, children: new Map(), books: new Map() };
        siblings.set(path, node);
      }
      node.count += 1;
      siblings = node.children;
      leaf = node;
    }
    if (!leaf) continue;
    const descriptor = describeBook(result);
    const existing = leaf.books.get(descriptor.facet);
    if (existing) existing.count += 1;
    else leaf.books.set(descriptor.facet, { ...descriptor, count: 1 });
  }

  const freeze = (nodes: Map<string, MutableNode>): CategoryTreeNode[] =>
    [...nodes.values()].map((node) => ({
      path: node.path,
      label: node.label,
      depth: node.depth,
      count: node.count,
      children: freeze(node.children),
      books: [...node.books.values()],
    }));

  return freeze(roots);
}

/// כל הספרים שבעץ, בסדר ההופעה — הבסיס לרשימת הסינון השטוחה.
export function collectBooks(nodes: readonly CategoryTreeNode[]): CategoryTreeBook[] {
  const books: CategoryTreeBook[] = [];
  for (const node of nodes) {
    books.push(...node.books, ...collectBooks(node.children));
  }
  return books;
}

function describeBook(result: UnifiedSearchResult): Omit<CategoryTreeBook, 'count'> {
  const title = result.source === 'otzaria' ? result.hit.book : result.hit.bookName;
  const subtitle = result.source === 'otzaria' ? null : result.hit.authorName;
  const icon: IconName =
    result.source === 'hebrewbooks' || result.hit.type === 'pdf'
      ? 'document_pdf_24_regular'
      : 'document_text_24_regular';
  return { facet: `${result.categoryPath}${BOOK_FACET_SEPARATOR}${title}`, title, subtitle, icon };
}

function bookFacet(result: UnifiedSearchResult): string {
  return describeBook(result).facet;
}

/// האם התוצאה נמצאת בתחום ה-facet הנבחר — קטגוריה (כולל צאצאיה) או ספר יחיד.
export function facetMatches(facet: string | null, result: UnifiedSearchResult): boolean {
  if (facet === null) return true;
  if (facet.includes(BOOK_FACET_SEPARATOR)) return facet === bookFacet(result);
  return categoryContains(facet, result.categoryPath);
}

function categoryAncestors(path: string): string[] {
  if (!path.startsWith('/')) return [path];
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`);
}

function categoryContains(selected: string, resultPath: string): boolean {
  return selected.startsWith('/')
    ? resultPath === selected || resultPath.startsWith(`${selected}/`)
    : resultPath === selected;
}

function categoryLabel(path: string): string {
  return path.startsWith('/') ? path.split('/').filter(Boolean).at(-1) ?? path : path;
}

function buildWarningBanner(message: string): HTMLElement {
  const banner = element('div', 'source-warning-banner');
  banner.append(iconElement('warning_24_regular', 18), element('span', undefined, message));
  return banner;
}

function buildProgressBanner(message: string): HTMLElement {
  const banner = element('div', 'source-progress-banner');
  banner.append(element('div', 'progress-indicator'), element('span', undefined, message));
  return banner;
}

function buildTruncatedBanner(): HTMLElement {
  const banner = element('div', 'truncated-banner');
  banner.append(
    iconElement('warning_24_regular', 18),
    element('span', undefined, 'ייתכן שהתוצאות חלקיות: אחד ממנועי החיפוש הגיע למגבלת התוצאות.'),
  );
  return banner;
}
