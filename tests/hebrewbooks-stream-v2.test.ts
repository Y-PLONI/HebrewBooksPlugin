import { describe, expect, it } from 'vitest';
import { defaultSearchOptions, type SearchSnapshot } from '../src/models';
import { HebrewBooksRepository } from '../src/repositories/hebrewbooks-repository';
import { createMockHost, hebrewBooksRow } from './helpers/mock-host';

const snapshot: SearchSnapshot = {
  query: 'בדיקה',
  fingerprint: 'stream-v2',
  options: { ...defaultSearchOptions, limit: 10, max: 100 },
};

const row = (fileId: string, hitCount = 1): Record<string, unknown> =>
  JSON.parse(hebrewBooksRow({ fileId, hitCount })) as Record<string, unknown>;
const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;
const start = { type: 'start', streamVersion: 2, streamId: 'A'.repeat(64) };
const reset = (count: number) => ({ type: 'reset', count });
const result = (rank: number, fileId: string, hitCount = 1) =>
  ({ type: 'result', rank, result: row(fileId, hitCount) });
const complete = (count: number) => ({ type: 'complete', count });

function v2Host(bodies: readonly string[]) {
  return createMockHost({ network: {
    '/health': () => ({ body: JSON.stringify({
      ok: true, service: 'hbsearch', apiVersion: 2,
      capabilities: ['pdf-range', 'search-stream-v2'],
    }) }),
    '/search': () => ({ bodies }),
  } });
}

describe('HebrewBooksRepository search-stream-v2', () => {
  it('requests v2 only when health explicitly advertises its capability', async () => {
    const modern = v2Host([line(start), line(reset(0)), line(complete(0))]);
    const modernRepository = new HebrewBooksRepository(modern.bridge);
    await modernRepository.health();
    await modernRepository.search(snapshot);
    const modernRequest = modern.payloadsOf('network.fetchStream').find((p) => String(p?.url).endsWith('/search'));
    expect(JSON.parse(String(modernRequest?.body))).toMatchObject({ streamVersion: 2 });

    const legacy = createMockHost({ network: {
      '/health': () => ({ body: JSON.stringify({
        ok: true, service: 'hbsearch', apiVersion: 2, capabilities: ['pdf-range'],
      }) }),
      '/search': () => ({ body: `${hebrewBooksRow({ fileId: '41' })}\n` }),
    } });
    const legacyRepository = new HebrewBooksRepository(legacy.bridge);
    await legacyRepository.health();
    expect((await legacyRepository.search(snapshot)).results.map((r) => r.fileId)).toEqual(['41']);
    const legacyRequest = legacy.payloadsOf('network.fetchStream').find((p) => String(p?.url).endsWith('/search'));
    expect(JSON.parse(String(legacyRequest?.body))).not.toHaveProperty('streamVersion');
  });

  it('shows discovery results then discards them and publishes the ranked final snapshot', async () => {
    const body = [
      start,
      { type: 'provisional', result: row('41', 1) },
      { type: 'provisional', result: row('42', 2) },
      { type: 'heartbeat' },
      reset(2),
      result(0, '42', 7),
      result(1, '43', 3),
      complete(2),
    ].map(line).join('');
    const host = v2Host([body.slice(0, 3), body.slice(3, 71), body.slice(71, 159), body.slice(159)]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const updates: string[][] = [];
    const page = await repository.search(snapshot, (partial) => {
      updates.push(partial.results.map((r) => r.fileId));
    });
    expect(updates).toEqual([[], ['41'], ['41', '42'], [], ['42', '43']]);
    expect(page.results.map((r) => [r.fileId, r.hitCount])).toEqual([['42', 7], ['43', 3]]);
    expect(page).toMatchObject({ totalBooks: 2, totalHits: 10, truncated: false });
    expect(repository.cachedResultsFor(snapshot.fingerprint)?.map((r) => r.fileId)).toEqual(['42', '43']);
  });

  it('deduplicates provisional file IDs and caches only after complete', async () => {
    const host = v2Host([
      line(start),
      line({ type: 'provisional', result: row('41') }),
      line({ type: 'provisional', result: row('41', 9) }),
      line(reset(1)),
      line(result(0, '42')),
      line(complete(1)),
    ]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const updates: string[][] = [];
    await repository.search(snapshot, (page) => {
      updates.push(page.results.map((r) => r.fileId));
      expect(repository.cachedResultsFor(snapshot.fingerprint)).toBeNull();
    });
    expect(updates).toEqual([[], ['41'], [], ['42']]);
  });

  it('reports start and heartbeat as activity without changing displayed results', async () => {
    const host = v2Host([
      line(start),
      line({ type: 'provisional', result: row('41') }),
      line({ type: 'heartbeat' }),
      line(reset(0)),
      line(complete(0)),
    ]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const updates: string[][] = [];
    await repository.search(snapshot, (page) => { updates.push(page.results.map((r) => r.fileId)); });
    expect(updates).toEqual([[], ['41'], ['41'], []]);
  });

  it('throttles 10,000 ranked rows and still publishes the first and complete snapshot', async () => {
    const count = 10_000;
    const host = v2Host([
      line(start),
      line({ type: 'provisional', result: row('first') }),
      line(reset(count)),
      ...Array.from({ length: count }, (_, rank) => line(result(rank, String(rank + 1)))),
      line(complete(count)),
    ]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const sizes: number[] = [];
    const page = await repository.search({ ...snapshot, options: { ...snapshot.options, max: count } },
      (partial) => { sizes.push(partial.totalBooks); });
    expect(sizes[0]).toBe(0);
    expect(sizes[1]).toBe(1);
    expect(sizes).toContain(0);
    expect(sizes.at(-1)).toBe(count);
    expect(sizes.length).toBeLessThan(100);
    expect(page.totalBooks).toBe(count);
    expect(page.results.map((r) => r.fileId)).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
  });

  // A stream error used to push an empty page before rethrowing, so the books
  // already on screen vanished and the caller reported "no results" instead of
  // the failure. Only reset — which precedes the ranked list — clears results.
  it('reports a server error without wiping the results already published', async () => {
    const host = v2Host([
      line(start), line({ type: 'provisional', result: row('41') }),
      line({ type: 'error', message: 'dtSearch failed' }),
    ]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const updates: string[][] = [];
    await expect(repository.search(snapshot, (page) => { updates.push(page.results.map((r) => r.fileId)); }))
      .rejects.toThrow('dtSearch failed');
    expect(updates).toEqual([[], ['41']]);
    expect(repository.cachedResultsFor(snapshot.fingerprint)).toBeNull();
  });

  // Cancellation is not an empty result set either: the v2 path used to resolve
  // with an empty page where the legacy path handed back what it had collected.
  it('resolves with the results collected so far when the caller cancels mid-stream', async () => {
    const host = v2Host([
      line(start),
      line({ type: 'provisional', result: row('41', 5) }),
      line(reset(1)) + line(result(0, '42')) + line(complete(1)),
    ]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const cancellation = new AbortController();
    const page = await repository.search(snapshot, (partial) => {
      if (partial.results.length > 0) cancellation.abort();
    }, cancellation.signal);
    expect(page.results.map((r) => r.fileId)).toEqual(['41']);
    expect(page).toMatchObject({ totalBooks: 1, totalHits: 5 });
    expect(repository.cachedResultsFor(snapshot.fingerprint)).toBeNull();
  });

  it('rejects an interrupted final snapshot and never caches it', async () => {
    const host = v2Host([line(start), line(reset(2)), line(result(0, '41'))]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const updates: string[][] = [];
    await expect(repository.search(snapshot, (page) => { updates.push(page.results.map((r) => r.fileId)); }))
      .rejects.toThrow('ללא אישור תוצאות סופיות');
    expect(updates).toEqual([[], []]);
    expect(repository.cachedResultsFor(snapshot.fingerprint)).toBeNull();
  });

  it.each([
    ['result before start', [result(0, '41')], 'פרוטוקול'],
    ['provisional after reset', [start, reset(0), { type: 'provisional', result: row('41') }, complete(0)], 'פרוטוקול'],
    ['out of order rank', [start, reset(1), result(1, '41'), complete(1)], 'פרוטוקול'],
    ['mismatched final count', [start, reset(2), result(0, '41'), complete(1)], 'פרוטוקול'],
    ['duplicate reset', [start, reset(0), reset(0), complete(0)], 'פרוטוקול'],
    ['missing reset', [start, complete(0)], 'פרוטוקול'],
    ['event after complete', [start, reset(0), complete(0), { type: 'heartbeat' }], 'פרוטוקול'],
    ['malformed result', [start, reset(1), { type: 'result', rank: 0, result: { fileId: '41' } }, complete(1)], 'שדות חובה'],
  ])('rejects %s', async (_name, events, expectedError) => {
    const host = v2Host([(events as Array<Record<string, unknown>>).map(line).join('')]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await expect(repository.search(snapshot)).rejects.toThrow(expectedError);
    expect(repository.cachedResultsFor(snapshot.fingerprint)).toBeNull();
  });

  // אירוע לא מוכר אינו הפרה: שירות חדש יותר שמוסיף סוג אירוע לא אמור
  // להפיל חיפוש שכל שאר שורותיו תקינות.
  it('skips an unknown event type and keeps the results around it', async () => {
    const host = v2Host([[
      start,
      { type: 'other', detail: 'from a newer service' },
      reset(1),
      result(0, '41', 3),
      complete(1),
    ].map(line).join('')]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const page = await repository.search(snapshot);
    expect(page.results.map((r) => r.fileId)).toEqual(['41']);
  });

  // אזהרה היא אירוע לא סופי: התוצאות שאחריה אמיתיות והחיפוש מסתיים כרגיל.
  it('keeps the stream running through a warning event', async () => {
    const host = v2Host([[
      start,
      { type: 'warning', code: 'partial-results', message: 'Otzraya reported $E 0001', indexes: ['Otzraya'] },
      reset(1),
      result(0, '41', 3),
      complete(1),
    ].map(line).join('')]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const page = await repository.search(snapshot);
    expect(page.results.map((r) => r.fileId)).toEqual(['41']);
  });

  it.each([
    ['missing code', { type: 'warning', message: 'x', indexes: [] }],
    ['empty message', { type: 'warning', code: 'partial-results', message: '  ', indexes: [] }],
    ['indexes not a string array', { type: 'warning', code: 'partial-results', message: 'x', indexes: [7] }],
  ])('rejects a malformed warning: %s', async (_name, warning) => {
    const host = v2Host([[start, warning, reset(0), complete(0)].map(line).join('')]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await expect(repository.search(snapshot)).rejects.toThrow('פרוטוקול');
  });

  // הדילוג על סוג לא מוכר אינו מכשיר זרם משובש: בלי reset/complete תקינים
  // החיפוש עדיין נכשל.
  it('still fails a stream that is only unknown events', async () => {
    const host = v2Host([[start, { type: 'other' }, { type: 'other' }].map(line).join('')]);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    await expect(repository.search(snapshot)).rejects.toThrow('ללא אישור תוצאות סופיות');
  });
});
