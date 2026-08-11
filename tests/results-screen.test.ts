// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { UnifiedSearchResponse } from '../src/models';
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

function createScreen(): ResultsScreen {
  return new ResultsScreen({
    onBack: () => undefined,
    onEditSearch: () => undefined,
    onLoadMore: () => undefined,
    onOpenResult: () => undefined,
    onOpenWebsite: () => undefined,
    onCopyDetails: () => undefined,
  });
}

function rowTitles(screen: ResultsScreen): string[] {
  return [...screen.root.querySelectorAll('.nav-tree-row .nav-tree-title')].map(
    (node) => node.textContent ?? '',
  );
}

describe('ResultsScreen partial unified search', () => {
  it('shows HebrewBooks progress after native results and removes it on completion', () => {
    const screen = createScreen();

    screen.showPartialResults(nativeResponse, 'החיפוש בהיברובוקס ממשיך…');

    expect(screen.root.querySelector('.source-progress-banner')?.textContent).toContain('ממשיך');
    expect(screen.root.querySelector('.result-snippet')?.textContent).toBe('בראשית ברא');
    screen.showResults(nativeResponse);
    expect(screen.root.querySelector('.source-progress-banner')).toBeNull();
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
