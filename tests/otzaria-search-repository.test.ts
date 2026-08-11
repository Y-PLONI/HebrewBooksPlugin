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
});
