// @vitest-environment jsdom

/// מצבי מסך התוצאות של התוסף: טעינה, ריק, שגיאה, אזהרות, טעינת עוד וסינון.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HebrewBooksResult,
  HostSearchRequest,
  ResultSnippet,
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
  onLoadSnippet: (result: HebrewBooksResult) => Promise<ResultSnippet> = async (result) => ({ page: result.firstHitPage, text: null }),
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
    expect(screen.root.textContent).toContain('מחפש בהיברובוקס…');
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

  it('עדכון חלקי חוזר משמר את מיקום הגלילה ברשימת התוצאות', () => {
    const { screen } = createScreen();
    screen.showPartialResults(response(), 'החיפוש ממשיך…');
    const list = screen.root.querySelector<HTMLElement>('.results-list')!;
    list.scrollTop = 123;
    screen.showPartialResults(response(), 'החיפוש ממשיך…');
    expect(screen.root.querySelector<HTMLElement>('.results-list')?.scrollTop).toBe(123);
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

  /// מסך התוסף נושא תוצאות היברובוקס בלבד. תפריט עם "אוצריא" היה מבטיח
  /// מקור שאינו שם, וכיבוי היברובוקס היה מרוקן את המסך בלי חיווי.
  it('מקור יחיד — אין כפתור סינון כלל', () => {
    const { screen } = createScreen();
    document.body.append(screen.root);
    screen.showResults(response({ results: [hebrewBooksResult()], otzariaTotal: 0 }));

    expect(screen.root.querySelector('.nav-filter-button')).toBeNull();
    expect(screen.root.querySelectorAll('.result-card')).toHaveLength(1);
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

  it('ספר בלי עמוד התאמה מאתר עמוד רק כשהכרטיס נראה', async () => {
    const observed: { callback?: IntersectionObserverCallback } = {};
    class DeferredIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) { observed.callback = callback; }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    vi.stubGlobal('IntersectionObserver', DeferredIntersectionObserver);
    const { screen, handlers } = createScreen(async () => ({ page: 12, text: 'ברכת המזון' }));
    document.body.append(screen.root);
    screen.showResults(response({ results: [hebrewBooksResult({ firstHitPage: null })] }));
    const snippet = screen.root.querySelector<HTMLElement>('.hebrewbooks-snippet')!;
    expect(handlers.onLoadSnippet).not.toHaveBeenCalled();
    expect(snippet.textContent).toContain('מאתר עמוד');
    observed.callback?.([{ isIntersecting: true, target: snippet } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    await vi.waitFor(() => expect(snippet.textContent).toBe('עמוד 12 · ברכת המזון'));
    expect(handlers.onLoadSnippet).toHaveBeenCalledTimes(1);
    screen.root.remove();
  });

  it('ללא IntersectionObserver מציג חיווי סופי ואינו מפעיל איתור המוני', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { screen, handlers } = createScreen();
    const results = Array.from({ length: 100 }, (_, index) =>
      hebrewBooksResult({ fileId: String(index + 1), firstHitPage: null }),
    );
    screen.showResults(response({ results }));
    expect(screen.root.querySelectorAll('.hebrewbooks-snippet')).toHaveLength(100);
    expect(screen.root.querySelector('.hebrewbooks-snippet')?.textContent).toBe('גזיר טקסט אינו זמין בתצוגה זו');
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
    const { screen } = createScreen(async () => ({ page: 2, text: null }));
    document.body.append(screen.root);
    screen.showResults(response({ results: [hebrewBooksResult()] }));
    await vi.waitFor(() =>
      expect(screen.root.querySelector('.hebrewbooks-snippet')?.textContent).toBe(
        'עמוד 2 · אין גזיר טקסט זמין',
      ),
    );
    screen.root.remove();
  });

  it('גזיר שנשלם אחרי החלפת התוצאות אינו כותב לכרטיס החדש', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    class DeferredIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    vi.stubGlobal('IntersectionObserver', DeferredIntersectionObserver);
    let complete: ((preview: ResultSnippet) => void) | undefined;
    const { screen } = createScreen(() => new Promise((resolve) => { complete = resolve; }));
    document.body.append(screen.root);
    screen.showResults(response({ results: [hebrewBooksResult({ fileId: '1' })] }));
    const oldTarget = screen.root.querySelector<HTMLElement>('.hebrewbooks-snippet')!;
    callbacks[0]?.([{ target: oldTarget, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    screen.showResults(response({ results: [hebrewBooksResult({ fileId: '2' })] }));
    complete?.({ page: 12, text: 'תוכן ישן' });
    await Promise.resolve();
    expect(screen.root.querySelector('.hebrewbooks-snippet')?.textContent).toBe('טוען גזיר טקסט מעמוד 2…');
    expect(screen.root.textContent).not.toContain('תוכן ישן');
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

  /// החיפוש שהתוסף מריץ בעצמו שואל את היברובוקס בלבד — הכותרות ומצב
  /// "אין תוצאות" אינם רשאים לנקוב גם באוצריא.
  it('חיפוש של התוסף נוקב בהיברובוקס בלבד; חיפוש מאוחד — בשני המאגרים', () => {
    const { screen } = createScreen();
    screen.setSearch('ברכה', null, true, undefined, false, {
      source: 'hebrewbooks',
      options: defaultSearchOptions,
    });
    screen.showNoResults();
    expect(screen.root.querySelector('.source-label')?.textContent).toBe('היברובוקס');
    expect(screen.root.querySelector('.top-bar-trailing')?.textContent).toContain(
      'מחפש בהיברובוקס…',
    );
    expect(screen.root.querySelector('.informative-state p')?.textContent).toBe(
      'לא נמצאו תוצאות בהיברובוקס. נסה לשנות את מילות החיפוש.',
    );

    const request: HostSearchRequest = { query: 'ברכה', mode: 'exact' };
    screen.setSearch('ברכה', null, false, undefined, false, { source: 'otzaria', request });
    screen.showNoResults();
    expect(screen.root.querySelector('.source-label')?.textContent).toBe('אוצריא + היברובוקס');
    expect(screen.root.querySelector('.informative-state p')?.textContent).toContain('באוצריא');
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
