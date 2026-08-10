import type { HebrewBooksResult, SearchOptions, SearchSnapshot } from '../models';
import {
  barButton,
  centeredProgress,
  compactIconButton,
  dropdownField,
  element,
  iconElement,
  informativeState,
  topBar,
  topBarDivider,
} from '../ui/widgets';

const sortEntries = [
  { value: 'hitcount', label: 'לפי מספר מופעים' },
  { value: 'bookname', label: 'לפי שם הספר' },
  { value: 'author', label: 'לפי מחבר' },
  { value: 'place', label: 'לפי מקום דפוס' },
  { value: 'year', label: 'לפי שנת דפוס' },
  { value: 'id', label: 'לפי מזהה' },
] as const satisfies ReadonlyArray<{ value: SearchOptions['sort']; label: string }>;

/// קיצורי אפשרויות ההרחבה, בסגנון הקיצורים שאוצריא מציגה ליד מילות החיפוש
/// (SearchTermsDisplay — 10px בצבע primary בתוך סוגריים).
const optionAbbreviations: ReadonlyArray<[keyof SearchOptions, string]> = [
  ['hybur', 'ק'],
  ['roots', 'שר'],
  ['spelling', 'מח'],
  ['gematria', 'גמ'],
  ['numberGender', 'זנ'],
  ['aramaic', 'ארמ'],
  ['rashetevot', 'רת'],
  ['rashiOcr', 'רש'],
  ['firstWord', 'רא'],
  ['lastWord', 'אח'],
];

interface ResultsHandlers {
  readonly onBack: () => void;
  readonly onEditSearch: () => void;
  readonly onSortChanged: (sort: SearchOptions['sort']) => void;
  readonly onOpenBook: (result: HebrewBooksResult) => void;
  readonly onOpenWebsite: (result: HebrewBooksResult) => void;
  readonly onCopyDetails: (result: HebrewBooksResult) => void;
}

/// מסך תוצאות החיפוש — שיקוף של TantivyFullTextSearch במסך רחב:
/// AppTopBar עם מילות החיפוש במרכזו ומונה התוצאות ובורר המיון בקצהו, ומתחתיו
/// רשימת כרטיסי התוצאות של TantivySearchResults.
export class ResultsScreen {
  readonly root = element('main', 'screen results-screen');
  private readonly body = element('div', 'screen-body results-body');
  private readonly center = element('div', 'top-bar-center');
  private readonly trailing = element('div', 'top-bar-trailing');
  private snapshot: SearchSnapshot | null = null;

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

  /// עדכון הסרגל העליון לחיפוש הנוכחי. count === null בזמן טעינה.
  setSearch(snapshot: SearchSnapshot, count: number | null): void {
    this.snapshot = snapshot;
    this.center.replaceChildren(
      element('span', 'top-bar-count', 'מוצגות תוצאות של חיפוש: '),
      this.buildSearchTerms(snapshot),
      barButton({ tooltip: 'ערוך חיפוש', icon: 'edit_24_regular', onClick: this.handlers.onEditSearch }),
    );
    this.trailing.replaceChildren(
      element('span', 'top-bar-count', count === null ? 'מחפש…' : `${count} תוצאות`),
      topBarDivider(),
      dropdownField('מיון', sortEntries, snapshot.options.sort, this.handlers.onSortChanged),
    );
  }

  showLoading(): void {
    this.body.replaceChildren(centeredProgress());
  }

  showNoResults(): void {
    this.body.replaceChildren(
      informativeState({
        icon: 'document_search_24_regular',
        title: 'אין תוצאות',
        message: 'נסה לשנות את מילות החיפוש, להרחיב את המקורות או לעדכן את אפשרויות החיפוש.',
        action: { text: 'ערוך חיפוש', icon: 'edit_24_regular', onClick: this.handlers.onEditSearch },
      }),
    );
  }

  showError(message: string): void {
    this.body.replaceChildren(
      informativeState({
        icon: 'warning_24_regular',
        title: 'לא ניתן להשלים את החיפוש',
        message,
        action: { text: 'ערוך חיפוש', icon: 'edit_24_regular', onClick: this.handlers.onEditSearch },
      }),
    );
  }

  showResults(results: HebrewBooksResult[], truncated: boolean): void {
    const list = element('ol', 'results-list');
    results.forEach((result, index) => list.append(this.buildResultCard(result, index)));
    this.body.replaceChildren(...(truncated ? [buildTruncatedBanner(), list] : [list]));
  }

  private buildSearchTerms(snapshot: SearchSnapshot): HTMLElement {
    const terms = element('div', 'search-terms');
    const abbreviations = optionAbbreviations
      .filter(([option]) => snapshot.options[option] === true)
      .map(([, abbreviation]) => abbreviation);
    if (abbreviations.length > 0) {
      terms.append(element('span', 'search-term-abbr', `(${abbreviations.join(',')})`));
    }
    terms.append(element('span', 'search-term-word', snapshot.query));
    return terms;
  }

  private buildResultCard(result: HebrewBooksResult, index: number): HTMLLIElement {
    const item = element('li', 'result-card');
    const card = element('div', 'result-card-body');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const open = (): void => this.handlers.onOpenBook(result);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    card.append(element('span', 'result-index', String(index + 1)));

    const content = element('div', 'result-content');
    const titleRow = element('div', 'result-title-row');
    titleRow.append(iconElement('document_pdf_24_regular', 16, 'icon result-kind-icon'));
    titleRow.append(element('h3', 'result-title', result.bookName));
    titleRow.append(
      compactIconButton('copy_24_regular', 'העתק את פרטי הספר', () => this.handlers.onCopyDetails(result)),
    );
    titleRow.append(
      compactIconButton('open_24_regular', 'פתח באתר היברובוקס', () => this.handlers.onOpenWebsite(result)),
    );
    content.append(titleRow);

    const reference = [result.authorName, result.printPlace, result.printYear].filter(Boolean).join(' · ');
    if (reference.length > 0) content.append(element('p', 'result-reference', reference));

    const meta = element('div', 'result-meta');
    meta.append(iconElement('layer_24_regular', 16));
    const pages = result.countPage ? ` · ${result.countPage} עמודים` : '';
    meta.append(element('span', undefined, `נמצאו ${result.hitCount} מופעים${pages}`));
    content.append(meta);

    card.append(content);
    item.append(card);
    return item;
  }

  get currentSnapshot(): SearchSnapshot | null {
    return this.snapshot;
  }
}

/// באנר "ייתכן שהתוצאות חלקיות" — TantivySearchResults._buildTruncatedBanner.
function buildTruncatedBanner(): HTMLElement {
  const banner = element('div', 'truncated-banner');
  banner.append(iconElement('warning_24_regular', 18));
  banner.append(
    element(
      'span',
      undefined,
      'ייתכן שהתוצאות חלקיות: החיפוש הגיע למספר התוצאות המבוקש ולכן הוצגו רק חלק ' +
        'מההתאמות. צמצמו את החיפוש (למשל הוסיפו מילה) או הגדילו את מספר התוצאות.',
    ),
  );
  return banner;
}
