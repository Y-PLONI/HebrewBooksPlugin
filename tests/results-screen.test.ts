// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HebrewBooksResult, HostSearchRequest, UnifiedSearchResponse } from '../src/models';
import { ResultsScreen } from '../src/screens/results-screen';

function otzariaResult(book: string, categoryPath: string) {
  return {
    source: 'otzaria',
    categoryPath,
    hit: {
      book,
      bookId: book,
      categoryPath,
      reference: 'פרק א',
      text: '<font color=red>בראשית</font> ברא',
      index: 0,
      mergedCount: 1,
    },
  } as const;
}

function hebrewBooksResult(bookName: string) {
  return {
    source: 'hebrewbooks',
    categoryPath: 'ספרי היברובוקס',
    hit: {
      fileId: '1',
      bookName,
      authorName: 'מחבר',
      printPlace: null,
      printYear: null,
      countPage: null,
      categories: null,
      sourceType: 'PDF',
      relativePath: null,
      hitCount: 4,
      firstHitPage: 2,
    },
  } as const;
}

const nativeResponse: UnifiedSearchResponse = {
  results: [otzariaResult('בראשית', '/תנ״ך')],
  otzariaTotal: 1,
  hebrewBooksTotal: 0,
  truncated: false,
  warnings: [],
  nextCursor: null,
};

const mixedResponse: UnifiedSearchResponse = {
  results: [
    otzariaResult('בראשית', '/תנ״ך/תורה'),
    otzariaResult('תהילים', '/תנ״ך/כתובים'),
    hebrewBooksResult('ספר חסידים'),
  ],
  otzariaTotal: 2,
  hebrewBooksTotal: 1,
  truncated: false,
  warnings: [],
  nextCursor: null,
};

function createScreen(
  onLoadSnippet: (result: HebrewBooksResult) => Promise<string | null> = async () => null,
): ResultsScreen {
  return new ResultsScreen({
    onBack: () => undefined,
    onEditSearch: () => undefined,
    onLoadMore: () => undefined,
    onOpenResult: () => undefined,
    onOpenWebsite: () => undefined,
    onCopyDetails: () => undefined,
    onLoadSnippet,
  });
}

function rowTitles(screen: ResultsScreen): string[] {
  return [...screen.root.querySelectorAll('.nav-tree-row .nav-tree-title')].map(
    (node) => node.textContent ?? '',
  );
}

describe('ResultsScreen partial unified search', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows HebrewBooks progress after native results and removes it on completion', () => {
    const screen = createScreen();

    screen.showPartialResults(nativeResponse, 'החיפוש בהיברובוקס ממשיך…');

    expect(screen.root.querySelector('.source-progress-banner')?.textContent).toContain('ממשיך');
    expect(screen.root.querySelector('.result-snippet')?.textContent).toBe('בראשית ברא');
    screen.showResults(nativeResponse);
    expect(screen.root.querySelector('.source-progress-banner')).toBeNull();
  });

  it('shows the complete count separately from the rendered item count', () => {
    const screen = createScreen();

    screen.setSearch('בדיקה', 3, false, 42);

    expect(screen.root.textContent).toContain('42 תוצאות');
    expect(screen.root.textContent).toContain('3 פריטים מוצגים');
  });

  it('renders the original Otzaria options per word, rather than HebrewBooks defaults', () => {
    const screen = createScreen();
    const request: HostSearchRequest = {
      query: 'חכמה בינה',
      mode: 'advanced',
      options: { 'כתיב מלא/חסר': true },
      wordOptions: {
        'חכמה_0': { 'קידומות דקדוקיות': true },
        'בינה_1': { 'ראשי תיבות': true },
      },
    };

    screen.setSearch('חכמה בינה', 2, false, undefined, false, { source: 'otzaria', request });

    expect(screen.root.querySelector('.search-terms')?.textContent).toBe('(קד)חכמה+(רת)בינה');
    expect(screen.root.textContent).not.toContain('סדר');
  });

  it('loads a HebrewBooks PDF text snippet only when its card approaches the viewport', async () => {
    class ImmediateIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [0];

      constructor(private readonly callback: IntersectionObserverCallback) {}

      observe(target: Element): void {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }

      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver);
    const load = vi.fn(async () => 'בראשית ברא אלהים');
    const screen = createScreen(load);
    document.body.append(screen.root);

    screen.showResults(mixedResponse);

    expect(load).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(screen.root.querySelector('.hebrewbooks-snippet')?.textContent).toContain(
        'עמוד 2 · בראשית ברא אלהים',
      );
    });
    screen.root.remove();
  });
});

describe('ResultsScreen navigation tree', () => {
  it('renders collapsed top categories with their aggregate counts', () => {
    const screen = createScreen();
    screen.showResults(mixedResponse);

    expect(rowTitles(screen)).toEqual(['תנ״ך', 'ספרי היברובוקס']);
    expect(screen.root.querySelector('.nav-tree-row .nav-tree-count')?.textContent).toBe('(2)');
    expect(screen.root.querySelector('.nav-tree-header .nav-tree-count')?.textContent).toBe('(3)');
    expect(screen.root.querySelector('.nav-tree-header-title')?.textContent).toBe('כל התוצאות');
  });

  it('reveals sub categories and book leaves when a category is expanded', () => {
    const screen = createScreen();
    screen.showResults(mixedResponse);

    screen.root.querySelector<HTMLButtonElement>('.nav-tree-chevron')?.click();

    expect(rowTitles(screen)).toEqual(['תנ״ך', 'תורה', 'כתובים', 'ספרי היברובוקס']);
  });

  it('limits the results list to the selected book and clears the filter from the header', () => {
    const screen = createScreen();
    screen.showResults(mixedResponse);

    screen.root.querySelector<HTMLElement>('.nav-tree-row')?.click();
    expect(screen.root.querySelectorAll('.result-card')).toHaveLength(2);

    screen.root.querySelector<HTMLButtonElement>('.clear-filter-button')?.click();
    expect(screen.root.querySelectorAll('.result-card')).toHaveLength(3);
  });

  it('replaces the tree with a flat book list once the filter field has two characters', () => {
    const screen = createScreen();
    screen.showResults(mixedResponse);

    const input = screen.root.querySelector<HTMLInputElement>('.slim-search-field input')!;
    input.value = 'חסי';
    input.dispatchEvent(new Event('input'));

    expect(rowTitles(screen)).toEqual(['ספר חסידים']);
    expect(screen.root.querySelector('.nav-tree-header')).toBeNull();
  });

  it('hides a source from both the tree and the results when it is unchecked', () => {
    const screen = createScreen();
    screen.showResults(mixedResponse);

    screen.root.querySelector<HTMLButtonElement>('.nav-filter-button')?.click();
    const hebrewBooksItem = [...screen.root.querySelectorAll<HTMLButtonElement>('.nav-filter-menu-item')].at(-1);
    hebrewBooksItem?.click();

    expect(rowTitles(screen)).toEqual(['תנ״ך']);
    expect(screen.root.querySelectorAll('.result-card')).toHaveLength(2);
  });
});
