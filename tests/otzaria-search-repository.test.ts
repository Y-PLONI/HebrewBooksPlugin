import { describe, expect, it } from 'vitest';
import type { HostBridge } from '../src/bridge';
import type { OtzariaSearchChunk } from '../src/models';
import { OtzariaSearchRepository } from '../src/repositories/otzaria-search-repository';

describe('OtzariaSearchRepository', () => {
  it('consumes search.query as an async stream without awaiting one response envelope', async () => {
    const payloads: Record<string, unknown>[] = [];
    async function* chunks(): AsyncIterable<OtzariaSearchChunk> {
      yield {
        sequence: 0,
        results: [],
        total: 1,
        groupCount: null,
        truncated: false,
        limit: 100,
        offset: 0,
        facets: ['/'],
      };
      yield {
        sequence: 1,
        results: [{
          id: 7,
          type: 'text',
          source: 'library',
          bookId: 'ספר',
          book: 'ספר',
          categoryPath: '/הלכה',
          reference: 'א',
          text: 'בדיקה',
          index: 3,
          mergedCount: 1,
        }],
        total: 1,
        groupCount: null,
        truncated: false,
        limit: 100,
        offset: 0,
        facets: ['/'],
      };
    }
    const bridge: HostBridge = {
      call: ((method: string, payload?: Record<string, unknown>) => {
        expect(method).toBe('search.query');
        payloads.push(payload ?? {});
        return chunks();
      }) as HostBridge['call'],
      on: () => undefined,
    };
    const repository = new OtzariaSearchRepository(bridge);

    const received: OtzariaSearchChunk[] = [];
    for await (const chunk of repository.search({ query: 'בדיקה' })) received.push(chunk);

    expect(received.map((chunk) => [chunk.sequence, chunk.results.length])).toEqual([[0, 0], [1, 1]]);
    expect(payloads[0]).toMatchObject({ query: 'בדיקה', includeBookCounts: false });
  });

  it('forwards AbortSignal cancellation to the host iterator', async () => {
    let cancelled = false;
    const chunk: OtzariaSearchChunk = {
      sequence: 0,
      results: [],
      total: 0,
      groupCount: null,
      truncated: false,
      limit: 100,
      offset: 0,
      facets: [],
    };
    const bridge: HostBridge = {
      call: (() => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ value: chunk, done: false as const }),
            return: async () => {
              cancelled = true;
              return { value: undefined, done: true as const };
            },
          };
        },
      })) as unknown as HostBridge['call'],
      on: () => undefined,
    };
    const controller = new AbortController();
    const iterator = new OtzariaSearchRepository(bridge)
      .search({ query: 'בדיקה' }, controller.signal)
      [Symbol.asyncIterator]();

    await iterator.next();
    controller.abort();
    await Promise.resolve();

    expect(cancelled).toBe(true);
    await iterator.return?.();
  });

  describe('openSearchTab', () => {
    function bridgeRecording(payloads: Record<string, unknown>[]): HostBridge {
      return {
        call: (async <T>(method: string, payload?: Record<string, unknown>) => {
          expect(method).toBe('reader.openSearchTab');
          payloads.push(payload ?? {});
          return { success: true, data: true as T, error: null };
        }) as HostBridge['call'],
        on: () => undefined,
      };
    }

    it('מעביר את המרווח שנבחר בדיאלוג לטאב המובנה', async () => {
      const payloads: Record<string, unknown>[] = [];
      await new OtzariaSearchRepository(bridgeRecording(payloads)).openSearchTab('ברכת המזון', 30);
      expect(payloads).toEqual([
        { query: 'ברכת המזון', selectItems: ['include-hebrewbooks'], distance: 30 },
      ]);
    });

    it('בלי מרווח (או ערך לא-מספרי) השדה מושמט — תאימות למארח ותיק', async () => {
      const payloads: Record<string, unknown>[] = [];
      const repository = new OtzariaSearchRepository(bridgeRecording(payloads));
      await repository.openSearchTab('ברכת המזון');
      await repository.openSearchTab('ברכת המזון', Number.NaN);
      expect(payloads).toEqual([
        { query: 'ברכת המזון', selectItems: ['include-hebrewbooks'] },
        { query: 'ברכת המזון', selectItems: ['include-hebrewbooks'] },
      ]);
    });
  });

  describe('resolveCategoryPaths', () => {
    it('שולח קריאה אחת ומחזיר נתיבים מיושרים לקלט', async () => {
      const payloads: Record<string, unknown>[] = [];
      const bridge: HostBridge = {
        call: (async <T>(method: string, payload?: Record<string, unknown>) => {
          expect(method).toBe('library.resolveCategoryPaths');
          payloads.push(payload ?? {});
          return { success: true, data: ['/הלכה', null, '  '] as T, error: null };
        }) as HostBridge['call'],
        on: () => undefined,
      };
      const paths = await new OtzariaSearchRepository(bridge).resolveCategoryPaths([7, 8, 9]);
      // מחרוזת ריקה מנורמלת ל-null, וכל קריאה אחת לכל האצווה.
      expect(paths).toEqual(['/הלכה', null, null]);
      expect(payloads).toEqual([{ ids: [7, 8, 9] }]);
    });

    it('קלט ריק אינו פונה למארח; אורך תשובה שגוי — שגיאה', async () => {
      let calls = 0;
      const bridge: HostBridge = {
        call: (async <T>() => {
          calls += 1;
          return { success: true, data: ['/אחד'] as T, error: null };
        }) as unknown as HostBridge['call'],
        on: () => undefined,
      };
      const repository = new OtzariaSearchRepository(bridge);
      expect(await repository.resolveCategoryPaths([])).toEqual([]);
      expect(calls).toBe(0);
      await expect(repository.resolveCategoryPaths([1, 2])).rejects.toThrow(
        'נתיבי קטגוריות לא תקינים',
      );
    });
  });
});
