// @vitest-environment jsdom

/// מצבי מסך התוצאות של התוסף: טעינה, ריק, שגיאה, אזהרות, טעינת עוד וסינון.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HebrewBooksResult,
  HostSearchRequest,
  UnifiedSearchResponse,
  UnifiedSearchResult,
} from '../src/models';
import { ResultsScreen } from '../src/screens/results-screen';
import { defaultSearchOptions } from '../src/models';

function otzariaResult(book: string, categoryPath = '/תנ"ך'): UnifiedSearchResult {
  return {
    source: 'otzaria',
    categoryPath,
    hit: {
      book,
      bookId: book,
      categoryPath,
      reference: 'פרק א',
      text: 'בראשית ברא',
      index: 0,
      mergedCount: 1,
    },
  };
}

function hebrewBooksResult(overrides: Partial<HebrewBooksResult> = {}): UnifiedSearchResult {
  return {
    source: 'hebrewbooks',
    categoryPath: 'ספרי היברובוקס',
    hit: {
      fileId: '1',
      bookName: 'ספר חסידים',
      authorName: 'מחבר',
      printPlace: null,
      printYear: null,
      countPage: 120,
      categories: null,
      sourceType: 'PDF',
      relativePath: null,
      hitCount: 4,
      firstHitPage: 2,
      ...overrides,
    },
  };
}

function response(overrides: Partial<UnifiedSearchResponse> = {}): UnifiedSearchResponse {
  return {
    results: [otzariaResult('בראשית'), hebrewBooksResult()],
    otzariaTotal: 1,
    hebrewBooksTotal: 4,
    truncated: false,
    warnings: [],
    nextCursor: null,
    ...overrides,
  };
}

interface Handlers {
  onBack: ReturnType<typeof vi.fn>;
  onEditSearch: ReturnType<typeof vi.fn>;
  onLoadMore: ReturnType<typeof vi.fn>;
  onOpenResult: ReturnType<typeof vi.fn>;
  onOpenWebsite: ReturnType<typeof vi.fn>;
  onCopyDetails: ReturnType<typeof vi.fn>;
  onLoadSnippet: ReturnType<typeof vi.fn>;
}

function createScreen(
  onLoadSnippet: (result: HebrewBooksResult) => Promise<string | null> = async () => null,
): { screen: ResultsScreen; handlers: Handlers } {
  const handlers: Handlers = {
    onBack: vi.fn(),
    onEditSearch: vi.fn(),
    onLoadMore: vi.fn(),
    onOpenResult: vi.fn(),
    onOpenWebsite: vi.fn(),
    onCopyDetails: vi.fn(),
    onLoadSnippet: vi.fn(onLoadSnippet),
  };
  return { screen: new ResultsScreen(handlers), handlers };
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`אין כפתור עם הטקסט ${text}`);
  return button;
}

describe('ResultsScreen — מצבים', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('מצב טעינה מציג מחוון בלבד', () => {
    const { screen } = createScreen();
    screen.setSearch('בדיקה', null, false);
    screen.showLoading();
    expect(screen.root.querySelector('.centered-progress')).not.toBeNull();
    expect(screen.root.textContent).toContain('מחפש בשני המאגרים…');
  });

  it('מצב "אין תוצאות" מציע לערוך את החיפוש רק כשהוא ניתן לעריכה', () => {
    const { screen, handlers } = createScreen();
    screen.setSearch('בדיקה', 0, false);
    screen.showNoResults();
    expect(screen.root.querySelector('.informative-state h3')?.textContent).toBe('אין תוצאות');
    expect(() => buttonByText(screen.root, 'ערוך חיפוש')).toThrow();

    screen.setSearch('בדיקה', 0, true);
    screen.showNoResults();
    buttonByText(screen.root, 'ערוך חיפוש').click();
    expect(handlers.onEditSearch).toHaveBeenCalledTimes(1);
  });

  it('מצב שגיאה מציג את הודעת המנוע', () => {
    const { screen } = createScreen();
    screen.setSearch('בדיקה', 0, true);
    screen.showError('השרת עסוק, נסה שוב');
    expect(screen.root.querySelector('.informative-state h3')?.textContent).toBe(
      'לא ניתן להשלים את החיפוש',
    );
    expect(screen.root.querySelector('.informative-state p')?.textContent).toBe(
      'השרת עסוק, נסה שוב',
    );
  });

  it('אזהרות ובאנר קטיעה מוצגים מעל הרשימה', () => {
    const { screen } = createScreen();
    screen.showResults(
      response({ warnings: ['החיפוש באוצריא נכשל: אין אינדקס'], truncated: true }),
    );
    expect(screen.root.querySelector('.source-warning-banner')?.textContent).toContain(
      'החיפוש באוצריא נכשל',
    );
    expect(screen.root.querySelector('.truncated-banner')?.textContent).toContain(
      'ייתכן שהתוצאות חלקיות',
    );
  });

  it('הודעת ההתקדמות מוצגת בתוצאות חלקיות ונעלמת בסיום', () => {
    const { screen } = createScreen();
    screen.showPartialResults(response(), 'מוצגות תוצאות שהתקבלו; החיפוש ממשיך…');
    expect(screen.root.querySelector('.source-progress-banner')?.textContent).toContain(
      'החיפוש ממשיך',
    );
    screen.showResults(response());
    expect(screen.root.querySelector('.source-progress-banner')).toBeNull();
  });

  it('כותרת התוצאות מונה את הפריטים המוצגים בקטגוריה הנבחרת', () => {
    const { screen } = createScreen();
    screen.showResults(response());
    expect(screen.root.querySelector('.category-results-heading')?.textContent).toBe(
      'כל התוצאות · 2',
    );
  });
});

describe('ResultsScreen — טעינת עוד תוצאות', () => {
  const paged = response({
    nextCursor: {
      otzariaOffset: 1,
      hebrewBooksOffset: 1,
      otzariaComplete: false,
      hebrewBooksComplete: true,
    },
  });

  it('שורת "טען עוד" מוצגת רק כשיש עמוד המשך', () => {
    const { screen } = createScreen();
    screen.showResults(response());
    expect(screen.root.querySelector('.load-more-row')).toBeNull();
    screen.showResults(paged);
    expect(screen.root.querySelector('.load-more-row')).not.toBeNull();
  });

  it('לחיצה מבקשת עמוד נוסף, והמצב "טוען" נועל את הכפתור', () => {
    const { screen, handlers } = createScreen();
    screen.showResults(paged);
    const button = buttonByText(screen.root, 'טען עוד תוצאות');
    button.click();
    expect(handlers.onLoadMore).toHaveBeenCalledTimes(1);

    screen.setLoadingMore(true);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('טוען תוצאות נוספות…');

    screen.setLoadingMore(false);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('טען עוד תוצאות');
  });

  it('setLoadingMore אינו עושה דבר לפני שיש תוצאות', () => {
    const { screen } = createScreen();
    screen.setLoadingMore(true);
    expect(screen.root.querySelector('.load-more-row')).toBeNull();
  });
});

describe('ResultsScreen — סינון לפי מקור', () => {
  it('כיבוי מקור מסתיר אותו מהרשימה, ומקור אחרון אינו ניתן לכיבוי', () => {
    const { screen } = createScreen();
    document.body.append(screen.root);
    screen.showResults(response());

    screen.root.querySelector<HTMLButtonElement>('.nav-filter-button')?.click();
    const menu = screen.root.querySelector('.nav-filter-menu');
    expect(menu).not.toBeNull();

    buttonByText(menu!, 'אוצריא').click();
    expect(screen.root.querySelectorAll('.result-card')).toHaveLength(1);
    expect(screen.root.querySelector('.result-title')?.textContent).toBe('ספר חסידים');
    expect(screen.root.querySelector('.nav-filter-badge')?.textContent).toBe('1');

    // ניסיון לכבות גם את המקור השני (התפריט נשאר פתוח) אינו משנה דבר.
    buttonByText(screen.root.querySelector('.nav-filter-menu')!, 'היברובוקס').click();
    expect(screen.root.querySelectorAll('.result-card')).toHaveLength(1);
    expect(screen.root.querySelector('.result-title')?.textContent).toBe('ספר חסידים');
    screen.root.remove();
  });

  it('לחיצה מחוץ לתפריט סוגרת אותו', () => {
    const { screen } = createScreen();
    document.body.append(screen.root);
    screen.showResults(response());
    screen.root.querySelector<HTMLButtonElement>('.nav-filter-button')?.click();
    expect(screen.root.querySelector('.nav-filter-menu')).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(screen.root.querySelector('.nav-filter-menu')).toBeNull();
    screen.root.remove();
  });

  it('בחירת ספר בעץ מסננת את הרשימה, וכפתור "נקה סינון" מחזיר את הכול', () => {
    const { screen } = createScreen();
    screen.showResults(response());
    // קטגוריות נפתחות סגורות — קודם מרחיבים את "ספרי היברובוקס".
    [...screen.root.querySelectorAll<HTMLButtonElement>('.nav-tree-chevron')].at(-1)?.click();
    const chosen = [...screen.root.querySelectorAll<HTMLElement>('.nav-tree-row.book')].find(
      (row) => row.textContent?.includes('ספר חסידים'),
    );
    expect(chosen).toBeDefined();
    chosen?.click();
    expect(screen.root.querySelectorAll('.result-card')).toHaveLength(1);
    expect(screen.root.querySelector('.category-results-heading')?.textContent).toContain(
      'ספר חסידים',
    );

    buttonByText(screen.root.querySelector('.nav-tree-header')!, 'נקה סינון').click();
    expect(screen.root.querySelectorAll('.result-card')).toHaveLength(2);
  });

  it('שדה האיתור מודיע כשאין ספר תואם', () => {
    const { screen } = createScreen();
    screen.showResults(response());
    const field = screen.root.querySelector<HTMLInputElement>('.slim-search-field input')!;
    field.value = 'אין כזה';
    field.dispatchEvent(new Event('input'));
    expect(screen.root.querySelector('.nav-tree-empty')?.textContent).toBe(
      'לא נמצאו ספרים עם תוצאות',
    );
  });
});

describe('ResultsScreen — כרטיס היברובוקס', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('מציג מונה מופעים, מספר עמודים ופרטי הדפסה', () => {
    const { screen } = createScreen();
    screen.showResults(
      response({
        results: [hebrewBooksResult({ printPlace: 'ורשה', printYear: 'תרל"ה', hitCount: 9 })],
      }),
    );
    expect(screen.root.querySelector('.result-meta')?.textContent).toContain(
      'נמצאו 9 מופעים · 120 עמודים',
    );
    expect(screen.root.querySelector('.result-reference')?.textContent).toBe('מחבר · ורשה · תרל"ה');
  });

  it('ספר בלי עמוד התאמה אינו מנסה לחלץ גזיר', () => {
    const { screen, handlers } = createScreen();
    screen.showResults(response({ results: [hebrewBooksResult({ firstHitPage: null })] }));
    expect(screen.root.querySelector('.hebrewbooks-snippet')?.textContent).toBe(
      'לא התקבל מיקום לגזיר הטקסט',
    );
    expect(handlers.onLoadSnippet).not.toHaveBeenCalled();
  });

  it('גזיר שלא נחלץ מוצג כהודעה במקום להישאר ב"טוען"', async () => {
    class ImmediateIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element): void {
        this.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver);
    const { screen } = createScreen(async () => null);
    document.body.append(screen.root);
    screen.showResults(response({ results: [hebrewBooksResult()] }));
    await vi.waitFor(() =>
      expect(screen.root.querySelector('.hebrewbooks-snippet')?.textContent).toBe(
        'לא ניתן היה לחלץ גזיר טקסט מעמוד 2',
      ),
    );
    screen.root.remove();
  });
});

describe('ResultsScreen — תצוגת מילות החיפוש', () => {
  it('חיפוש היברובוקס מציג קיצורי אפשרויות, מרחק וקירוב', () => {
    const { screen } = createScreen();
    screen.setSearch('ברכת המזון', 2, true, undefined, false, {
      source: 'hebrewbooks',
      options: { ...defaultSearchOptions, hybur: true, proximity: 5, fuzziness: 2 },
    });
    const terms = screen.root.querySelector('.search-terms')?.textContent ?? '';
    expect(terms).toContain('(או"ש)');
    expect(terms).toContain('מרחק: 5');
    expect(terms).toContain('קירוב: 2');
  });

  it('מילה בודדת אינה מציגה מרחק בין מילים', () => {
    const { screen } = createScreen();
    screen.setSearch('ברכה', 1, true, undefined, false, {
      source: 'hebrewbooks',
      options: { ...defaultSearchOptions, proximity: 5 },
    });
    expect(screen.root.querySelector('.search-terms')?.textContent).not.toContain('מרחק');
  });

  it('ריווח מותאם בין מילים של אוצריא מוצג כפי שהוגדר', () => {
    const { screen } = createScreen();
    const request: HostSearchRequest = {
      query: 'חכמה בינה',
      mode: 'advanced',
      customSpacing: { '0-1': '3' },
    };
    screen.setSearch('חכמה בינה', 2, false, undefined, false, { source: 'otzaria', request });
    expect(screen.root.querySelector('.search-terms')?.textContent).toBe('חכמה+3בינה');
  });

  it('בלי פירוט אפשרויות מוצגת השאילתה כפי שהיא', () => {
    const { screen } = createScreen();
    screen.setSearch('ברכת המזון', 2, false);
    expect(screen.root.querySelector('.search-term-word')?.textContent).toBe('ברכת המזון');
  });

  it('ספירה כוללת שהיא רף תחתון מסומנת כ"לפחות"', () => {
    const { screen } = createScreen();
    screen.setSearch('ברכה', 20, false, 10_000, true);
    expect(screen.root.querySelector('.top-bar-trailing')?.textContent).toContain(
      'לפחות 10000 תוצאות',
    );
  });
});
