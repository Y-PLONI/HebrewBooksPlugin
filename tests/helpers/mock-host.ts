/// מארח אוצריא מדומה — גשר יחיד שכל הטסטים מקצה-לקצה נשענים עליו: אוסף את
/// קריאות ה-API, מדמה את שירות היברובוקס המקומי מעל network.fetchStream,
/// ומאפשר לשגר אירועים אל התוסף בדיוק כפי שאוצריא משגרת אותם.

import type { HostBridge } from '../../src/bridge';
import type { HebrewBooksResult } from '../../src/models';

export interface HostCall {
  readonly method: string;
  readonly payload?: Record<string, unknown>;
}

/// תשובת HTTP של השירות המקומי. `bodies` מפצל את הגוף למקטעי הזרמה, כפי
/// שהשירות מחזיר NDJSON תוך כדי החיפוש.
export interface NetworkReply {
  readonly status?: number;
  readonly ok?: boolean;
  readonly body?: string;
  readonly bodies?: readonly string[];
}

export type NetworkHandler = (
  payload: Record<string, unknown>,
) => NetworkReply | Promise<NetworkReply>;

export type MethodHandler = (
  payload: Record<string, unknown> | undefined,
) => unknown | Promise<unknown>;

export interface MockHostConfig {
  /// מתודות רגילות של ה-SDK. הערך המוחזר הוא ה-data של המעטפה; זריקה
  /// מתורגמת לתשובת כישלון, ו-null ל-data ריק (כמו מארח שלא מצא את הפריט).
  readonly methods?: Record<string, MethodHandler>;
  /// נתיבי השירות המקומי (`/search`, `/inbook`, `/health`, `/pdf`).
  readonly network?: Record<string, NetworkHandler>;
  /// זרם האינדקס של אוצריא (search.query).
  readonly searchQuery?: (
    payload: Record<string, unknown> | undefined,
  ) => AsyncIterable<unknown> | readonly unknown[];
}

export interface MockHost {
  readonly bridge: HostBridge;
  readonly calls: HostCall[];
  /// כל המנות שנשלחו למתודה מסוימת, בסדר הקריאה.
  payloadsOf(method: string): Array<Record<string, unknown> | undefined>;
  countOf(method: string): number;
  /// המנה האחרונה שנשלחה למתודה, או undefined אם לא נקראה.
  lastPayload(method: string): Record<string, unknown> | undefined;
  emit(event: string, payload: unknown): void;
  hasListener(event: string): boolean;
}

const healthyLegacy: NetworkReply = {
  status: 200,
  ok: true,
  body: JSON.stringify({ ok: true, service: 'hbsearch', apiVersion: 1, serverVersion: '1.4.0' }),
};

export function createMockHost(config: MockHostConfig = {}): MockHost {
  const calls: HostCall[] = [];
  const listeners = new Map<string, Array<(payload: unknown) => void>>();

  const resolveNetwork = (path: string): NetworkHandler | null => {
    const handlers = config.network ?? {};
    const exact = handlers[path];
    if (exact) return exact;
    for (const [key, handler] of Object.entries(handlers)) {
      if (path.startsWith(`${key}/`)) return handler;
    }
    if (path === '/health') return () => healthyLegacy;
    return null;
  };

  async function* networkStream(
    payload: Record<string, unknown> | undefined,
  ): AsyncIterable<unknown> {
    const url = String(payload?.url ?? '');
    const path = new URL(url).pathname;
    const handler = resolveNetwork(path);
    const reply: NetworkReply = handler
      ? await handler(payload ?? {})
      : { status: 404, ok: false, body: JSON.stringify({ error: `אין נתיב ${path}` }) };
    const status = reply.status ?? 200;
    let sequence = 0;
    yield {
      sequence: sequence++,
      type: 'response',
      status,
      ok: reply.ok ?? (status >= 200 && status < 300),
      headers: { 'content-type': 'application/x-ndjson' },
    };
    const bodies = reply.bodies ?? (reply.body === undefined ? [] : [reply.body]);
    for (const body of bodies) yield { sequence: sequence++, type: 'data', body };
  }

  async function* otzariaStream(
    payload: Record<string, unknown> | undefined,
  ): AsyncIterable<unknown> {
    const chunks = config.searchQuery?.(payload) ?? [];
    if (Symbol.asyncIterator in chunks) {
      yield* chunks as AsyncIterable<unknown>;
      return;
    }
    for (const chunk of chunks as readonly unknown[]) yield chunk;
  }

  const call = ((method: string, payload?: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method === 'network.fetchStream') return networkStream(payload);
    if (method === 'search.query') return otzariaStream(payload);
    const handler = config.methods?.[method];
    if (!handler) return Promise.resolve({ success: true, data: true, error: null });
    return Promise.resolve()
      .then(() => handler(payload))
      .then((data) => ({ success: true, data: data === undefined ? true : data, error: null }))
      .catch((error: unknown) => ({
        success: false,
        data: null,
        error: {
          code: 'plugin_error',
          message: error instanceof Error ? error.message : 'שגיאה במארח',
        },
      }));
  }) as HostBridge['call'];

  const bridge: HostBridge = {
    call,
    on: (event: string, callback: (payload: never) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(callback as (payload: unknown) => void);
      listeners.set(event, existing);
    },
  };

  return {
    bridge,
    calls,
    payloadsOf: (method) => calls.filter((entry) => entry.method === method).map((entry) => entry.payload),
    countOf: (method) => calls.filter((entry) => entry.method === method).length,
    lastPayload: (method) => calls.filter((entry) => entry.method === method).at(-1)?.payload,
    emit: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    hasListener: (event) => (listeners.get(event) ?? []).length > 0,
  };
}

/// שורת NDJSON של תוצאת חיפוש, עם שדות החובה מלאים כברירת מחדל.
export function hebrewBooksRow(overrides: Partial<HebrewBooksResult> = {}): string {
  return JSON.stringify({
    fileId: '43558',
    bookName: 'קובץ שיטות קמאי',
    authorName: 'מחבר',
    printPlace: 'ירושלים',
    printYear: 'תשס"ד',
    sourceType: 'PDF',
    categories: 'גאונים|שו"ת',
    hitCount: 7,
    ...overrides,
  });
}

export function hebrewBooksNdjson(rows: readonly string[]): string {
  return rows.map((row) => `${row}\n`).join('');
}

export function bootPayload(overrides: Partial<OtzariaBootPayload> = {}): OtzariaBootPayload {
  return {
    app: { platform: 'windows', version: '0.9.97', locale: 'he', textDirection: 'rtl' },
    plugin: { id: 'org.hebrewbooks2026.otzaria-search', version: '0.5.5' },
    theme: {
      mode: 'light',
      colorScheme: {},
      typography: { fontFamily: 'Roboto', fontSize: 14, lineHeight: 1.4 },
    },
    permissions: [],
    ...overrides,
  };
}
