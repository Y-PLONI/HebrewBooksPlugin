import { describe, expect, it } from 'vitest';
import type {
  HostBridge,
  NetworkFetchParams,
  NetworkFetchStreamChunk,
} from '../src/bridge';
import { defaultSearchOptions, type SearchSnapshot } from '../src/models';
import { HebrewBooksRepository } from '../src/repositories/hebrewbooks-repository';

const snapshot: SearchSnapshot = {
  query: 'בדיקה',
  fingerprint: 'בדיקה',
  options: {
    ...defaultSearchOptions,
    proximity: 1,
    requireWordOrder: true,
  },
};

describe('HebrewBooksRepository', () => {
  it('uses network.fetchStream and allows two minutes for a search', async () => {
    let payload: NetworkFetchParams | undefined;
    const bridge = bridgeWith((request) => {
      payload = request;
      return networkChunks([]);
    });

    await new HebrewBooksRepository(bridge).search(snapshot);

    expect(payload).toMatchObject({
      url: 'http://127.0.0.1:8080/search',
      method: 'POST',
      timeoutMs: 120_000,
    });
    expect(JSON.parse(payload?.body ?? '{}')).toMatchObject({ limit: 10_000 });
  });

  it('publishes every complete NDJSON batch while the response is open', async () => {
    const first = resultLine('41', 'ספר ראשון');
    const second = resultLine('42', 'ספר שני');
    const bridge = bridgeWith(() => networkChunks([
      `${first}\n${second.slice(0, 20)}`,
      `${second.slice(20)}\n`,
    ]));
    const updates: string[][] = [];

    const results = await new HebrewBooksRepository(bridge).search(
      snapshot,
      (partial) => {
        updates.push(partial.results.map((result) => result.fileId));
      },
    );

    expect(updates).toEqual([['41'], ['41', '42']]);
    expect(results.results.map((result) => result.fileId)).toEqual(['41', '42']);
    expect(results).toMatchObject({ totalBooks: 2, totalHits: 2, truncated: false });
  });

  it('keeps compact metadata for paging without repeating the server search', async () => {
    let calls = 0;
    const bridge = bridgeWith(() => {
      calls += 1;
      return networkChunks([
        `${resultLine('41', 'ספר ראשון', 2)}\n`,
        `${resultLine('42', 'ספר שני', 3)}\n`,
        `${resultLine('43', 'ספר שלישי', 1)}\n`,
      ]);
    });
    const repository = new HebrewBooksRepository(bridge);
    const pagedSnapshot: SearchSnapshot = {
      ...snapshot,
      fingerprint: 'paged',
      options: { ...snapshot.options, limit: 1, max: 3 },
    };

    const first = await repository.search(pagedSnapshot);
    const second = await repository.search(pagedSnapshot, undefined, undefined, 1);

    expect(first.results.map((result) => result.fileId)).toEqual(['41']);
    expect(second.results.map((result) => result.fileId)).toEqual(['42']);
    expect(first).toMatchObject({ totalBooks: 3, totalHits: 6, truncated: true });
    expect(second).toMatchObject({ totalBooks: 3, totalHits: 6, truncated: true });
    expect(calls).toBe(1);
  });

  it('closes the host iterator when the caller rejects a stale update', async () => {
    let cancelled = false;
    let index = 0;
    const chunks: NetworkFetchStreamChunk[] = [
      { sequence: 0, type: 'response', status: 200, ok: true, headers: {} },
      { sequence: 1, type: 'data', body: `${resultLine('41', 'ספר')}\n` },
    ];
    const stream: AsyncIterable<NetworkFetchStreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            const value = chunks[index++];
            return value
              ? { value, done: false as const }
              : { value: undefined, done: true as const };
          },
          return: async () => {
            cancelled = true;
            return { value: undefined, done: true as const };
          },
        };
      },
    };
    const bridge = bridgeWith(() => stream);

    await new HebrewBooksRepository(bridge).search(snapshot, () => false);

    expect(cancelled).toBe(true);
  });

  it('forwards AbortSignal while waiting for the next network chunk', async () => {
    let cancelled = false;
    let resolveWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resolveWaiting = resolve;
    });
    let resolveNext!: (result: IteratorResult<NetworkFetchStreamChunk>) => void;
    let index = 0;
    const stream: AsyncIterable<NetworkFetchStreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (index++ === 0) {
              return {
                value: { sequence: 0, type: 'response', status: 200, ok: true, headers: {} } as const,
                done: false as const,
              };
            }
            resolveWaiting();
            return new Promise<IteratorResult<NetworkFetchStreamChunk>>((resolve) => {
              resolveNext = resolve;
            });
          },
          return: async () => {
            cancelled = true;
            resolveNext?.({ value: undefined, done: true });
            return { value: undefined, done: true as const };
          },
        };
      },
    };
    const controller = new AbortController();
    const search = new HebrewBooksRepository(bridgeWith(() => stream)).search(
      snapshot,
      undefined,
      controller.signal,
    );
    await waiting;

    controller.abort();
    await search;

    expect(cancelled).toBe(true);
  });

  it('collects streamed JSON for health and in-book requests', async () => {
    const requests: NetworkFetchParams[] = [];
    const bridge = bridgeWith((request) => {
      requests.push(request);
      if (request.url.endsWith('/health')) {
        return networkChunks(['{"ok":true,"service":"hb', 'search","apiVersion":2,"capabilities":["pdf-range"]}']);
      }
      return networkChunks(['{"hitCount":2,"pages":[4,2,4],', '"matchedTerms":["בדיקה"]}']);
    });
    const repository = new HebrewBooksRepository(bridge);

    await expect(repository.health()).resolves.toMatchObject({ kind: 'onlineFull' });
    await expect(repository.inBook(snapshot, '41')).resolves.toEqual({
      hitCount: 2,
      pages: [2, 4],
      matchedTerms: ['בדיקה'],
    });
    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:8080/health',
      'http://127.0.0.1:8080/inbook',
    ]);
  });

  it('rejects data that arrives before response metadata', async () => {
    const bridge = bridgeWith(() => (async function* () {
      yield { sequence: 0, type: 'data', body: `${resultLine('41', 'ספר')}\n` } as const;
    })());

    await expect(new HebrewBooksRepository(bridge).search(snapshot)).rejects.toThrow(
      'גוף לפני כותרות',
    );
  });

  it('preserves a streamed HTTP error message', async () => {
    const bridge = bridgeWith(() => (async function* () {
      yield { sequence: 0, type: 'response', status: 500, ok: false, headers: {} } as const;
      yield { sequence: 1, type: 'data', body: '{"error":"השרת עסוק' } as const;
      yield { sequence: 2, type: 'data', body: ', נסה שוב"}' } as const;
    })());

    await expect(new HebrewBooksRepository(bridge).search(snapshot)).rejects.toThrow(
      'השרת עסוק, נסה שוב',
    );
  });
});

function bridgeWith(
  stream: (payload: NetworkFetchParams) => AsyncIterable<NetworkFetchStreamChunk>,
): HostBridge {
  return {
    call: ((method: string, payload?: Record<string, unknown>) => {
      expect(method).toBe('network.fetchStream');
      return stream(payload as NetworkFetchParams);
    }) as HostBridge['call'],
    on: () => undefined,
  };
}

async function* networkChunks(body: string[]): AsyncIterable<NetworkFetchStreamChunk> {
  yield { sequence: 0, type: 'response', status: 200, ok: true, headers: {} };
  for (const [index, part] of body.entries()) {
    yield { sequence: index + 1, type: 'data', body: part };
  }
}

function resultLine(fileId: string, bookName: string, hitCount = 1): string {
  return JSON.stringify({
    fileId,
    bookName,
    sourceType: 'PDF',
    hitCount,
    firstHitPage: 3,
  });
}
