// @vitest-environment jsdom

/// מרוץ ההתנעה: המאזין לחיפוש נרשם ב-constructor, בעוד יכולות הפרוטוקול
/// מתגלות רק ב-/health של boot — ושירות עם auto-start מושהה עולה בדיוק אז.

import { afterEach, describe, expect, it, vi } from 'vitest';

type NetworkReply = import('./helpers/mock-host').NetworkReply;

const { AppController } = await import('../src/app-controller');
const { HebrewBooksRepository } = await import('../src/repositories/hebrewbooks-repository');
const { defaultSearchOptions } = await import('../src/models');
const { bootPayload, createMockHost, hebrewBooksRow, MockHostError } = await import(
  './helpers/mock-host'
);

type MockHost = ReturnType<typeof createMockHost>;
type SearchSnapshot = import('../src/models').SearchSnapshot;

const streamId = 'C'.repeat(64);
const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
const v2Bodies = [
  line({ type: 'start', streamVersion: 2, streamId }),
  line({ type: 'reset', count: 1 })
    + line({ type: 'result', rank: 0, result: JSON.parse(hebrewBooksRow({ fileId: '901' })) })
    + line({ type: 'complete', count: 1 }),
];
const v2Health = {
  ok: true,
  service: 'hbsearch',
  apiVersion: 2,
  capabilities: ['pdf-range', 'search-stream-v2', 'search-cancel-v2'],
};
const legacyHealth = { ok: true, service: 'hbsearch', apiVersion: 1 };
const legacyRow = `${hebrewBooksRow({ fileId: '41' })}\n`;

const snapshot: SearchSnapshot = {
  query: 'בדיקה',
  fingerprint: 'negotiation',
  options: { ...defaultSearchOptions, limit: 10, max: 100 },
};

function requestsTo(host: MockHost, suffix: string): Array<Record<string, unknown> | undefined> {
  return host.payloadsOf('network.fetchStream').filter((p) => String(p?.url).endsWith(suffix));
}

function searchBodies(host: MockHost): Array<Record<string, unknown>> {
  return requestsTo(host, '/search').map((p) => JSON.parse(String(p?.body)) as Record<string, unknown>);
}

function cancelledStreamIds(host: MockHost): string[] {
  return requestsTo(host, '/search/cancel').map(
    (p) => JSON.parse(String(p?.body)).streamId as string,
  );
}

describe('גילוי יכולות הפרוטוקול', () => {
  it('חיפוש שקדם לכל בדיקת שירות עדיין נוחת על v2', async () => {
    const host = createMockHost({
      network: {
        '/health': () => ({ body: JSON.stringify(v2Health) }),
        '/search': () => ({ bodies: v2Bodies }),
      },
    });
    const repository = new HebrewBooksRepository(host.bridge);

    const page = await repository.search(snapshot);

    expect(searchBodies(host)[0]).toMatchObject({ streamVersion: 2 });
    expect(page.results.map((result) => result.fileId)).toEqual(['901']);
  });

  it('בדיקת שירות שנכשלה אינה נועלת את הסשן על המסלול הישן', async () => {
    let up = false;
    const host = createMockHost({
      network: {
        '/health': () =>
          up ? { body: JSON.stringify(v2Health) } : { status: 503, ok: false, body: 'starting' },
        '/search': () => ({ bodies: v2Bodies }),
      },
    });
    const repository = new HebrewBooksRepository(host.bridge);

    await expect(repository.health()).rejects.toThrow();
    up = true;
    await repository.search(snapshot);

    expect(searchBodies(host)[0]).toMatchObject({ streamVersion: 2 });
    expect(requestsTo(host, '/health')).toHaveLength(2);
  });

  it('שירות ישן אינו נבדק מחדש בכל חיפוש', async () => {
    const host = createMockHost({
      network: {
        '/health': () => ({ body: JSON.stringify(legacyHealth) }),
        '/search': () => ({ body: legacyRow }),
      },
    });
    const repository = new HebrewBooksRepository(host.bridge);

    for (const fingerprint of ['a', 'b', 'c', 'd']) {
      await repository.search({ ...snapshot, fingerprint });
    }

    expect(requestsTo(host, '/health')).toHaveLength(1);
    expect(searchBodies(host)).toHaveLength(4);
    expect(searchBodies(host).at(-1)).not.toHaveProperty('streamVersion');
  });

  it('שירות שאינו עולה נבדק מחדש בכל חיפוש, והחיפושים ממשיכים לרוץ', async () => {
    const host = createMockHost({
      network: {
        '/health': () => ({ status: 503, ok: false, body: 'down' }),
        '/search': () => ({ body: legacyRow }),
      },
    });
    const repository = new HebrewBooksRepository(host.bridge);

    for (const fingerprint of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const page = await repository.search({ ...snapshot, fingerprint });
      expect(page.results.map((result) => result.fileId)).toEqual(['41']);
    }

    expect(requestsTo(host, '/health')).toHaveLength(6);
    expect(searchBodies(host)).toHaveLength(6);
  });

  it('חיפושים מקבילים חולקים גילוי אחד', async () => {
    const host = createMockHost({
      network: {
        '/health': () => ({ body: JSON.stringify(v2Health) }),
        '/search': () => ({ bodies: v2Bodies }),
      },
    });
    const repository = new HebrewBooksRepository(host.bridge);

    await Promise.all([
      repository.search({ ...snapshot, fingerprint: 'a' }),
      repository.search({ ...snapshot, fingerprint: 'b' }),
    ]);

    expect(requestsTo(host, '/health')).toHaveLength(1);
    expect(searchBodies(host).map((body) => body.streamVersion)).toEqual([2, 2]);
  });

  /// התלונה עצמה: בקשה שהגיעה לפני boot רצה בלי אסימון זרם, ולכן נטישה
  /// של המארח לא הצליחה לעצור אותה והכונן המשיך לעבוד.
  it('בקשה שהגיעה לפני boot מבוטלת בשרת כשהמארח נוטש אותה', async () => {
    const host = createMockHost({
      methods: {
        'reader.respondExternalSearch': () => {
          throw new MockHostError('error.not_found', 'request does not belong to this plugin');
        },
      },
      network: {
        '/health': () => ({ body: JSON.stringify(v2Health) }),
        '/search': () => ({ bodies: v2Bodies, bodyDelaysMs: [0, 5_000] }),
        '/search/cancel': () => ({ body: '{"cancelled":true}' }),
      },
    });
    const controller = new AppController(host.bridge, document.createElement('div'));

    host.emit('search.external.requested', {
      requestId: 'xs-1',
      provider: 'hebrewbooks',
      query: 'ברכת המזון',
      mode: 'exact',
      distance: 2,
      offset: 0,
      limit: 20,
    });
    const booting = controller.boot(bootPayload());

    await vi.waitFor(() => expect(cancelledStreamIds(host)).toEqual([streamId]), { timeout: 4_000 });
    expect(searchBodies(host)[0]).toMatchObject({ streamVersion: 2 });
    await booting;
  });
});

/// ארבע רגרסיות מסבב QA: כל אחת נכשלה לפני התיקון והוכחה במדידה.
describe('גילוי יכולות — עמידות', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const flush = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

  it('ביטול בזמן בדיקת שירות שנתקעה מסיים את החיפוש מיד', async () => {
    const host = createMockHost({
      network: {
        '/health': () => new Promise<NetworkReply>(() => undefined),
        '/search': () => ({ bodies: v2Bodies }),
      },
    });
    const repository = new HebrewBooksRepository(host.bridge);
    const controller = new AbortController();

    let settled = false;
    const search = repository.search(snapshot, undefined, controller.signal).then(() => {
      settled = true;
    });
    await flush();
    controller.abort();
    await search;

    expect(settled).toBe(true);
    expect(requestsTo(host, '/search')).toHaveLength(0);
  });

  it('שירות שחזר לפעול אחרי רצף כשלונות חוזר ל-v2 ולביטול בשרת', async () => {
    let up = false;
    const host = createMockHost({
      network: {
        '/health': () =>
          up ? { body: JSON.stringify(v2Health) } : { status: 503, ok: false, body: 'down' },
        '/search': () => (up ? { bodies: v2Bodies, bodyDelaysMs: [0, 400] } : { body: legacyRow }),
        '/search/cancel': () => ({ body: '{"cancelled":true}' }),
      },
    });
    const repository = new HebrewBooksRepository(host.bridge);

    for (const fingerprint of ['a', 'b', 'c']) {
      await repository.search({ ...snapshot, fingerprint });
    }
    up = true;
    const controller = new AbortController();
    await repository.search({ ...snapshot, fingerprint: 'd' }, () => {
      controller.abort();
    }, controller.signal);
    await flush();

    expect(searchBodies(host).at(-1)).toMatchObject({ streamVersion: 2 });
    expect(cancelledStreamIds(host)).toEqual([streamId]);
  });

  it('שדרוג השירות באמצע הסשן נתפס בלי הפעלה מחדש של אוצריא', async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let modern = false;
    const host = createMockHost({
      network: {
        '/health': () => ({ body: JSON.stringify(modern ? v2Health : legacyHealth) }),
        '/search': () => (modern ? { bodies: v2Bodies } : { body: legacyRow }),
      },
    });
    const repository = new HebrewBooksRepository(host.bridge);

    await repository.health();
    await repository.search({ ...snapshot, fingerprint: 'a' });
    expect(searchBodies(host).at(-1)).not.toHaveProperty('streamVersion');

    modern = true;
    clock += 5 * 60_000;
    await repository.search({ ...snapshot, fingerprint: 'b' });

    expect(searchBodies(host).at(-1)).toMatchObject({ streamVersion: 2 });
    expect(requestsTo(host, '/health')).toHaveLength(2);
  });

  it('היעדר pdf-range אינו מבטל את זרם v2 ואת הביטול בשרת', async () => {
    const host = createMockHost({
      network: {
        '/health': () => ({
          body: JSON.stringify({
            ok: true,
            service: 'hbsearch',
            apiVersion: 2,
            capabilities: ['search-stream-v2', 'search-cancel-v2'],
          }),
        }),
        '/search': () => ({ bodies: v2Bodies, bodyDelaysMs: [0, 400] }),
        '/search/cancel': () => ({ body: '{"cancelled":true}' }),
      },
    });
    const repository = new HebrewBooksRepository(host.bridge);

    await expect(repository.health()).rejects.toThrow('קובצי PDF');
    const controller = new AbortController();
    await repository.search(snapshot, () => {
      controller.abort();
    }, controller.signal);
    await flush();

    expect(searchBodies(host)[0]).toMatchObject({ streamVersion: 2 });
    expect(cancelledStreamIds(host)).toEqual([streamId]);
    expect(requestsTo(host, '/health')).toHaveLength(1);
  });
});
