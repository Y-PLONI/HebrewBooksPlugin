import { describe, expect, it, vi } from 'vitest';
import type { HostBridge, NetworkFetchParams, NetworkFetchStreamChunk } from '../src/bridge';
import { defaultSearchOptions, type SearchSnapshot } from '../src/models';
import { HebrewBooksRepository } from '../src/repositories/hebrewbooks-repository';
import { createMockHost, hebrewBooksRow } from './helpers/mock-host';

// The service spells its tokens in upper-case hex; tokenB stays lower-case so
// the suite covers both spellings a client can legitimately be handed.
const tokenA = 'A'.repeat(64);
const tokenB = 'b'.repeat(64);
const snapshot: SearchSnapshot = {
  query: 'בדיקה', fingerprint: 'cancel-v2',
  options: { ...defaultSearchOptions, max: 100, limit: 10 },
};
const line = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;
const start = (streamId: string) => line({ type: 'start', streamVersion: 2, streamId });
const provisional = line({ type: 'provisional', result: JSON.parse(hebrewBooksRow()) });
const end = [line({ type: 'reset', count: 0 }), line({ type: 'complete', count: 0 })];

function hostWithSearch(bodies: readonly string[], capabilities = ['pdf-range', 'search-stream-v2', 'search-cancel-v2']) {
  return createMockHost({ network: {
    '/health': () => ({ body: JSON.stringify({ ok: true, service: 'hbsearch', apiVersion: 2, capabilities }) }),
    '/search': () => ({ bodies }),
    '/search/cancel': () => ({ body: '{"cancelled":true}' }),
  } });
}

function cancels(host: ReturnType<typeof createMockHost>): string[] {
  return host.payloadsOf('network.fetchStream')
    .filter((payload) => String(payload?.url).endsWith('/search/cancel'))
    .map((payload) => JSON.parse(String(payload?.body)).streamId as string);
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('v2 explicit server cancellation', () => {
  it('cancels a queued search as soon as start is received, without awaiting iterator.return', async () => {
    const host = hostWithSearch([start(tokenA), line({ type: 'heartbeat' }), ...end]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const controller = new AbortController();
    await repository.search(snapshot, () => { controller.abort(); }, controller.signal);
    await flush();
    expect(cancels(host)).toEqual([tokenA]);
  });

  it('cancels an active search when a provisional update is rejected', async () => {
    const host = hostWithSearch([start(tokenA), provisional, ...end]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await repository.search(snapshot, (page) => page.totalBooks === 0);
    await flush();
    expect(cancels(host)).toEqual([tokenA]);
  });

  it('retains the request capability when another health check starts during search', async () => {
    const host = hostWithSearch([start(tokenA), provisional, ...end]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    let refreshed: Promise<unknown> | undefined;
    await repository.search(snapshot, (page) => {
      if (page.totalBooks === 0) return true;
      refreshed = repository.health();
      return false;
    });
    await refreshed;
    await flush();
    expect(cancels(host)).toEqual([tokenA]);
  });

  it.each([
    ['invalid event', start(tokenA) + line({ type: 'unexpected' })],
    ['malformed JSON', start(tokenA) + '{oops}\n'],
  ])('cancels after a valid start followed by %s in the same chunk', async (_case, body) => {
    const host = hostWithSearch([body]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await expect(repository.search(snapshot)).rejects.toThrow();
    await flush();
    expect(cancels(host)).toEqual([tokenA]);
  });

  it.each([
    ['start', start(tokenA).trimEnd(), 0],
    ['provisional', start(tokenA) + provisional.trimEnd(), 1],
  ])('returns a partial page after rejecting a %s event in the unterminated tail', async (_case, body, stopAtBooks) => {
    const host = hostWithSearch([body]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await expect(repository.search(snapshot, (page) => page.totalBooks !== stopAtBooks))
      .resolves.toMatchObject({ totalBooks: stopAtBooks });
    await flush();
    expect(cancels(host)).toEqual([tokenA]);
  });

  it('does not cancel a completed stream, even if its signal is aborted afterward', async () => {
    const host = hostWithSearch([start(tokenA), ...end]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const controller = new AbortController();
    await repository.search(snapshot, undefined, controller.signal);
    controller.abort();
    await flush();
    expect(cancels(host)).toEqual([]);
  });

  it('does not send explicit cancel without the advertised capability', async () => {
    const host = hostWithSearch([start(tokenA), provisional, ...end], ['pdf-range', 'search-stream-v2']);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await repository.search(snapshot, (page) => page.totalBooks === 0);
    await flush();
    expect(cancels(host)).toEqual([]);
  });

  it('rejects a missing token when the server advertises explicit cancellation', async () => {
    const host = hostWithSearch([line({ type: 'start', streamVersion: 2 }), ...end]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await expect(repository.search(snapshot)).rejects.toThrow('פרוטוקול');
    expect(cancels(host)).toEqual([]);
  });

  it('tolerates a missing token from a v2 server without cancel capability', async () => {
    const host = hostWithSearch([line({ type: 'start', streamVersion: 2 }), ...end], ['pdf-range', 'search-stream-v2']);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await expect(repository.search(snapshot)).resolves.toMatchObject({ totalBooks: 0 });
    expect(cancels(host)).toEqual([]);
  });

  it('does not turn a failed cancel request into a search failure', async () => {
    const host = createMockHost({ network: {
      '/health': () => ({ body: JSON.stringify({ ok: true, service: 'hbsearch', apiVersion: 2,
        capabilities: ['pdf-range', 'search-stream-v2', 'search-cancel-v2'] }) }),
      '/search': () => ({ bodies: [start(tokenA), provisional, ...end] }),
      '/search/cancel': () => { throw new Error('connection lost'); },
    } });
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await expect(repository.search(snapshot, (page) => page.totalBooks === 0))
      .resolves.toMatchObject({ totalBooks: 1 });
    await flush();
    expect(cancels(host)).toEqual([tokenA]);
  });

  it('does not start a cancellation request for a signal already aborted before search', async () => {
    const host = hostWithSearch([start(tokenA), ...end]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const controller = new AbortController();
    controller.abort();
    await expect(repository.search(snapshot, undefined, controller.signal)).resolves.toMatchObject({ totalBooks: 0 });
    expect(cancels(host)).toEqual([]);
  });

  it.each(['short', 'x'.repeat(64), '../'.repeat(20)])('rejects malformed stream token %s without sending it', async (badToken) => {
    const host = hostWithSearch([start(badToken), ...end]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await expect(repository.search(snapshot)).rejects.toThrow('פרוטוקול');
    expect(cancels(host)).toEqual([]);
  });

  it('cancels only the abandoned request when searches use different tokens', async () => {
    let searchCount = 0;
    const host = createMockHost({ network: {
      '/health': () => ({ body: JSON.stringify({ ok: true, service: 'hbsearch', apiVersion: 2,
        capabilities: ['pdf-range', 'search-stream-v2', 'search-cancel-v2'] }) }),
      '/search': () => ({ bodies: [start(++searchCount === 1 ? tokenA : tokenB), ...end] }),
      '/search/cancel': () => ({ body: '{"cancelled":true}' }),
    } });
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await Promise.all([
      repository.search(snapshot, () => false),
      repository.search({ ...snapshot, fingerprint: 'other' }),
    ]);
    await flush();
    expect(cancels(host)).toEqual([tokenA]);
  });

  it('still cancels if AbortSignal fires while the start chunk is in flight', async () => {
    let deliverStart!: (value: IteratorResult<NetworkFetchStreamChunk>) => void;
    let releaseReturn!: () => void;
    const returnGate = new Promise<void>((resolve) => { releaseReturn = resolve; });
    const calls: NetworkFetchParams[] = [];
    let searchIterator!: AsyncIterator<NetworkFetchStreamChunk>;
    const bridge = {
      call: ((method: string, payload: NetworkFetchParams) => {
        expect(method).toBe('network.fetchStream');
        calls.push(payload);
        if (payload.url.endsWith('/health')) return (async function* () {
          yield { sequence: 0, type: 'response', status: 200, ok: true, headers: {} } as const;
          yield { sequence: 1, type: 'data', body: JSON.stringify({ ok: true, service: 'hbsearch', apiVersion: 2,
            capabilities: ['pdf-range', 'search-stream-v2', 'search-cancel-v2'] }) } as const;
        })();
        if (payload.url.endsWith('/search/cancel')) return (async function* () {
          yield { sequence: 0, type: 'response', status: 200, ok: true, headers: {} } as const;
        })();
        let count = 0;
        searchIterator = {
          next: () => count++ === 0
            ? Promise.resolve({ value: { sequence: 0, type: 'response', status: 200, ok: true, headers: {} }, done: false as const })
            : new Promise<IteratorResult<NetworkFetchStreamChunk>>((resolve) => { deliverStart = resolve; }),
          return: async () => { await returnGate; return { value: undefined, done: true as const }; },
        };
        return { [Symbol.asyncIterator]: () => searchIterator };
      }) as HostBridge['call'],
      on: vi.fn(),
    } satisfies HostBridge;
    const repository = new HebrewBooksRepository(bridge);
    await repository.health();
    const controller = new AbortController();
    const pending = repository.search(snapshot, undefined, controller.signal);
    await vi.waitFor(() => expect(deliverStart).toBeTypeOf('function'));
    controller.abort();
    deliverStart({ value: { sequence: 1, type: 'data', body: start(tokenA) }, done: false });
    await vi.waitFor(() => expect(calls.filter((request) => request.url.endsWith('/search/cancel'))).toHaveLength(1));
    expect(JSON.parse(String(calls.at(-1)?.body)).streamId).toBe(tokenA);
    releaseReturn();
    await pending;
  });
});
