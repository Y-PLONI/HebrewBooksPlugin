import type { HebrewBooksResult, UnifiedSearchResponse, UnifiedSearchResult } from '../models';
import {
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
  readonly onOpenResult: (result: UnifiedSearchResult) => void;
  readonly onOpenWebsite: (result: HebrewBooksResult) => void;
  readonly onCopyDetails: (result: HebrewBooksResult) => void;
}

interface CategoryEntry {
  path: string;
  label: string;
  depth: number;
  count: number;
}

export class ResultsScreen {
  readonly root = element('main', 'screen results-screen');
  private readonly body = element('div', 'screen-body results-body');
  private readonly center = element('div', 'top-bar-center');
  private readonly trailing = element('div', 'top-bar-trailing');
  private query = '';
  private response: UnifiedSearchResponse | null = null;
  private selectedCategory: string | null = null;
  private editable = false;

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

  setSearch(query: string, count: number | null, editable: boolean): void {
    this.query = query;
    this.editable = editable;
    this.center.replaceChildren(
      element('span', 'top-bar-count', 'מוצגות תוצאות של חיפוש: '),
      element('span', 'search-term-word', query),
      ...(editable
        ? [barButton({ tooltip: 'ערוך חיפוש', icon: 'edit_24_regular', onClick: this.handlers.onEditSearch })]
        : []),
    );
    this.trailing.replaceChildren(
      element('span', 'top-bar-count', count === null ? 'מחפש בשני המאגרים…' : `${count} תוצאות מוצגות`),
      topBarDivider(),
      element('span', 'source-label', 'אוצריא + היברובוקס'),
    );
  }

  showLoading(): void {
    this.response = null;
    this.body.replaceChildren(centeredProgress());
  }

  showNoResults(): void {
    this.response = null;
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
    this.response = null;
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
    this.response = response;
    this.selectedCategory = null;
    this.renderResults();
  }

  private renderResults(): void {
    const response = this.response;
    if (!response) return;
    const layout = element('div', 'unified-results-layout');
    const navigation = element('aside', 'category-navigation');
    navigation.setAttribute('aria-label', 'קטגוריות תוצאות');
    navigation.append(element('h2', undefined, 'קטגוריות'));
    navigation.append(this.categoryButton(null, 'כל התוצאות', response.results.length, 0));
    for (const entry of buildCategoryEntries(response.results)) {
      navigation.append(this.categoryButton(entry.path, entry.label, entry.count, entry.depth));
    }

    const content = element('section', 'categorized-results');
    const visible = response.results.filter((result) => categoryContains(this.selectedCategory, result.categoryPath));
    const heading = element(
      'div',
      'category-results-heading',
      this.selectedCategory ? categoryLabel(this.selectedCategory) : 'כל התוצאות',
    );
    heading.append(element('span', undefined, ` · ${visible.length}`));
    content.append(heading);
    for (const warning of response.warnings) content.append(buildWarningBanner(warning));
    if (response.truncated) content.append(buildTruncatedBanner());
    const list = element('ol', 'results-list');
    visible.forEach((result, index) => list.append(this.buildResultCard(result, index)));
    content.append(list);
    layout.append(navigation, content);
    this.body.replaceChildren(layout);
  }

  private categoryButton(path: string | null, label: string, count: number, depth: number): HTMLButtonElement {
    const selected = this.selectedCategory === path;
    const button = element('button', selected ? 'category-button selected' : 'category-button');
    button.type = 'button';
    button.style.setProperty('--category-depth', String(depth));
    button.setAttribute('aria-pressed', String(selected));
    button.append(element('span', 'category-label', label), element('span', 'category-count', String(count)));
    button.addEventListener('click', () => {
      this.selectedCategory = path;
      this.renderResults();
    });
    return button;
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
    content.append(element('p', 'result-snippet', result.hit.text));
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
    content.append(meta);
    return content;
  }
}

export function buildCategoryEntries(results: UnifiedSearchResult[]): CategoryEntry[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const path of categoryAncestors(result.categoryPath)) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, count]) => ({ path, label: categoryLabel(path), depth: categoryDepth(path), count }))
    .sort((left, right) => left.path.localeCompare(right.path, 'he'));
}

function categoryAncestors(path: string): string[] {
  if (!path.startsWith('/')) return [path];
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`);
}

function categoryContains(selected: string | null, resultPath: string): boolean {
  if (selected === null) return true;
  return selected.startsWith('/') ? resultPath === selected || resultPath.startsWith(`${selected}/`) : resultPath === selected;
}

function categoryLabel(path: string): string {
  return path.startsWith('/') ? path.split('/').filter(Boolean).at(-1) ?? path : path;
}

function categoryDepth(path: string): number {
  return path.startsWith('/') ? Math.max(0, path.split('/').filter(Boolean).length - 1) : 0;
}

function buildWarningBanner(message: string): HTMLElement {
  const banner = element('div', 'source-warning-banner');
  banner.append(iconElement('warning_24_regular', 18), element('span', undefined, message));
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
