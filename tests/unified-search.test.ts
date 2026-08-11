import { describe, expect, it } from 'vitest';
import type { HebrewBooksResult, HostSearchRequest, OtzariaSearchResponse } from '../src/models';
import { UnifiedSearchService, toHebrewBooksSnapshot } from '../src/services/unified-search-service';
import { buildCategoryEntries } from '../src/screens/results-screen';

const request: HostSearchRequest = {
  query: 'חכמה בינה',
  mode: 'advanced',
  distance: 4,
  limit: 100,
  wordOptions: {
    'חכמה_0': { 'קידומות דקדוקיות': true, 'כתיב מלא/חסר': true },
    'בינה_1': { 'ראשי תיבות': true },
  },
};

const hbResults: HebrewBooksResult[] = [
  {
    fileId: '10',
    bookName: 'ספר משויך',
    authorName: null,
    printPlace: null,
    printYear: null,
    countPage: 100,
    categories: null,
    sourceType: 'PDF',
    relativePath: null,
    hitCount: 3,
  },
  {
    fileId: '11',
    bookName: 'ספר ללא שיוך',
    authorName: null,
    printPlace: null,
    printYear: null,
    countPage: null,
    categories: null,
    sourceType: 'PDF',
    relativePath: null,
    hitCount: 2,
  },
];

const otzariaResponse: OtzariaSearchResponse = {
  results: [
    {
      id: 7,
      type: 'text',
      source: 'library',
      bookId: 'ספר אוצריא',
      book: 'ספר אוצריא',
      categoryPath: '/הלכה/אחרונים',
      reference: 'סימן א',
      text: 'חכמה ובינה',
      index: 12,
      mergedCount: 1,
    },
  ],
  total: 1,
  groupCount: null,
  truncated: false,
  limit: 100,
  offset: 0,
  facets: ['/'],
};

describe('UnifiedSearchService', () => {
  it('maps the host options supported by HebrewBooks and always preserves word order', () => {
    const snapshot = toHebrewBooksSnapshot(request);

    expect(snapshot.options).toMatchObject({
      proximity: 4,
      hybur: true,
      spelling: true,
      rashetevot: true,
      aramaic: false,
      requireWordOrder: true,
    });
  });

  it('places matched HebrewBooks results in the Otzaria category and unmatched results in their own category', async () => {
    const service = new UnifiedSearchService(
      { search: async () => hbResults },
      {
        search: async () => otzariaResponse,
        resolveBooks: async () => [{ id: 70, title: 'מקביל', categoryPath: '/מחשבה/מוסר' }],
      },
      { findBestOtzariaIds: async () => new Map([['10', 70]]) },
    );

    const response = await service.search(request);

    expect(response.results.map((result) => [result.source, result.categoryPath])).toEqual([
      ['otzaria', '/הלכה/אחרונים'],
      ['hebrewbooks', '/מחשבה/מוסר'],
      ['hebrewbooks', 'ספרי היברובוקס'],
    ]);
    expect(response.hebrewBooksTotal).toBe(5);
  });

  it('returns Otzaria results with a warning when the local HebrewBooks server fails', async () => {
    const service = new UnifiedSearchService(
      { search: async () => { throw new Error('לא מחובר'); } },
      { search: async () => otzariaResponse, resolveBooks: async () => [] },
      { findBestOtzariaIds: async () => new Map() },
    );

    const response = await service.search(request);

    expect(response.results).toHaveLength(1);
    expect(response.warnings.join(' ')).toContain('לא מחובר');
  });

  it('builds an ancestor-aware category tree with aggregate counts', () => {
    const entries = buildCategoryEntries([
      { source: 'otzaria', categoryPath: '/הלכה/אחרונים', hit: otzariaResponse.results[0]! },
      { source: 'hebrewbooks', categoryPath: '/הלכה/שו״ת', hit: hbResults[0]! },
      { source: 'hebrewbooks', categoryPath: 'ספרי היברובוקס', hit: hbResults[1]! },
    ]);

    expect(entries.find((entry) => entry.path === '/הלכה')?.count).toBe(2);
    expect(entries.find((entry) => entry.path === '/הלכה/אחרונים')?.depth).toBe(1);
    expect(entries.find((entry) => entry.path === 'ספרי היברובוקס')?.count).toBe(1);
  });
});
