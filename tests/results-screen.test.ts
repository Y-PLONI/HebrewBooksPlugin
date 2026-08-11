// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { UnifiedSearchResponse } from '../src/models';
import { ResultsScreen } from '../src/screens/results-screen';

const nativeResponse: UnifiedSearchResponse = {
  results: [
    {
      source: 'otzaria',
      categoryPath: '/תנ״ך',
      hit: {
        book: 'בראשית',
        bookId: 'בראשית',
        categoryPath: '/תנ״ך',
        reference: 'פרק א',
        text: '<font color=red>בראשית</font> ברא',
        index: 0,
        mergedCount: 1,
      },
    },
  ],
  otzariaTotal: 1,
  hebrewBooksTotal: 0,
  truncated: false,
  warnings: [],
  nextCursor: null,
};

describe('ResultsScreen partial unified search', () => {
  it('shows HebrewBooks progress after native results and removes it on completion', () => {
    const screen = new ResultsScreen({
      onBack: () => undefined,
      onEditSearch: () => undefined,
      onLoadMore: () => undefined,
      onOpenResult: () => undefined,
      onOpenWebsite: () => undefined,
      onCopyDetails: () => undefined,
    });

    screen.showPartialResults(nativeResponse, 'החיפוש בהיברובוקס ממשיך…');

    expect(screen.root.querySelector('.source-progress-banner')?.textContent).toContain('ממשיך');
    expect(screen.root.querySelector('.result-snippet')?.textContent).toBe('בראשית ברא');
    screen.showResults(nativeResponse);
    expect(screen.root.querySelector('.source-progress-banner')).toBeNull();
  });
});
