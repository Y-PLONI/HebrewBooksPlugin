// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/app-controller';
import type { HostBridge } from '../src/bridge';

describe('AppController HebrewBooks path setting integration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches key-hebrew-books-path setting on boot and updates home page', async () => {
    const listeners: Record<string, (payload: unknown) => void> = {};
    const mockBridge: HostBridge = {
      call: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
        if (method === 'settings.get' && payload?.key === 'key-hebrew-books-path') {
          return { success: true, data: '/configured/hebrewbooks/path', error: null };
        }
        return { success: true, data: null, error: null };
      }) as unknown as HostBridge['call'],
      on: (event: string, callback: (payload: never) => void) => {
        listeners[event] = callback as (payload: unknown) => void;
      },
    };

    const shell = document.createElement('div');
    const controller = new AppController(mockBridge, shell);

    await controller.boot({
      app: { platform: 'macos', version: '0.9.97', locale: 'he', textDirection: 'rtl' },
      plugin: { id: 'hebrewbooks', version: '0.5.4' },
      theme: {
        mode: 'light',
        colorScheme: {},
        typography: { fontFamily: 'Roboto', fontSize: 14, lineHeight: 1.4 },
      },
      permissions: ['settings.read', 'events.subscribe:settings.changed'],
    });

    const statusEl = shell.querySelector('.library-hebrewbooks-path-status');
    expect(statusEl?.textContent).toBe(
      'מיקום ספרי היברובוקס באוצריא: הוגדר (/configured/hebrewbooks/path)',
    );

    // Simulate settings.changed event from host
    listeners['settings.changed']?.({
      key: 'key-hebrew-books-path',
      newValue: '/new/updated/path',
    });

    expect(statusEl?.textContent).toBe('מיקום ספרי היברובוקס באוצריא: הוגדר (/new/updated/path)');

    listeners['settings.changed']?.({
      key: 'key-hebrew-books-path',
      newValue: '',
    });

    expect(statusEl?.textContent).toBe('מיקום ספרי היברובוקס באוצריא: לא הוגדר');
  });

  it('מתעלם מבקשות חיפוש שאינן מיועדות לספק hebrewbooks', async () => {
    const listeners: Record<string, (payload: unknown) => void> = {};
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const mockBridge: HostBridge = {
      call: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
        calls.push({ method, payload });
        return { success: true, data: null, error: null };
      }) as unknown as HostBridge['call'],
      on: (event: string, callback: (payload: never) => void) => {
        listeners[event] = callback as (payload: unknown) => void;
      },
    };

    const controller = new AppController(mockBridge, document.createElement('div'));
    await controller.boot({
      app: { platform: 'macos', version: '0.9.97', locale: 'he', textDirection: 'rtl' },
      plugin: { id: 'hebrewbooks', version: '0.5.6' },
      theme: {
        mode: 'light',
        colorScheme: {},
        typography: { fontFamily: 'Roboto', fontSize: 14, lineHeight: 1.4 },
      },
      permissions: [],
    });
    await Promise.resolve();
    calls.length = 0;

    listeners['search.external.requested']?.({
      requestId: 'xs-foreign',
      provider: 'other-provider',
      query: 'שלום',
    });
    listeners['reader.inBookSearch.requested']?.({
      requestId: 'ibs-foreign',
      provider: 'other-provider',
      externalId: 1,
      query: 'שלום',
    });
    await Promise.resolve();

    expect(calls).toEqual([]);
  });

  it('נרשם כספק תוצאות חיצוני ועונה לבקשת search.external.requested בעמוד ממופה', async () => {
    const listeners: Record<string, (payload: unknown) => void> = {};
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const searchRow = JSON.stringify({
      fileId: '43558',
      bookName: 'קובץ שיטות קמאי',
      authorName: 'מחבר',
      printPlace: 'ירושלים',
      printYear: 'תשס"ד',
      sourceType: 'PDF',
      categories: 'גאונים|שו"ת',
      hitCount: 7,
    });
    const mockBridge: HostBridge = {
      call: vi.fn((method: string, payload?: Record<string, unknown>) => {
        calls.push({ method, payload });
        if (method === 'network.fetchStream') {
          return (async function* () {
            yield { sequence: 0, type: 'response', status: 200, ok: true, headers: {} };
            yield { sequence: 1, type: 'data', body: `${searchRow}\n` };
          })();
        }
        return Promise.resolve({ success: true, data: true, error: null });
      }) as unknown as HostBridge['call'],
      on: (event: string, callback: (payload: never) => void) => {
        listeners[event] = callback as (payload: unknown) => void;
      },
    };

    const shell = document.createElement('div');
    const controller = new AppController(mockBridge, shell);
    await controller.boot({
      app: { platform: 'macos', version: '0.9.97', locale: 'he', textDirection: 'rtl' },
      plugin: { id: 'hebrewbooks', version: '0.5.4' },
      theme: {
        mode: 'light',
        colorScheme: {},
        typography: { fontFamily: 'Roboto', fontSize: 14, lineHeight: 1.4 },
      },
      permissions: [],
    });
    // ה-boot רושם את הספק (מיקרוטסקים של הרישום רצים אחרי await).
    await Promise.resolve();
    expect(calls).toContainEqual({
      method: 'reader.registerExternalSearchProvider',
      payload: { provider: 'hebrewbooks' },
    });

    listeners['search.external.requested']?.({
      requestId: 'xs-1',
      provider: 'hebrewbooks',
      query: 'ברכת המזון',
      mode: 'exact',
      distance: 2,
      offset: 0,
      limit: 20,
    });
    await vi.waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'reader.respondExternalSearch' && call.payload?.done !== false,
        ),
      ).toBe(true);
    });

    const responses = calls.filter((call) => call.method === 'reader.respondExternalSearch');
    // הזרמה: עדכון חלקי (done: false, בלי קטעי טקסט) לפני התשובה הסופית.
    expect(responses[0]?.payload).toMatchObject({
      requestId: 'xs-1',
      done: false,
      hasMore: true,
      results: [{ title: 'קובץ שיטות קמאי', externalId: 43558 }],
    });
    expect(responses.at(-1)?.payload).toMatchObject({
      requestId: 'xs-1',
      totalBooks: 1,
      totalHits: 7,
      hasMore: false,
      results: [
        {
          title: 'קובץ שיטות קמאי',
          meta: 'מחבר · ירושלים · תשס"ד',
          hitCount: 7,
          externalId: 43558,
        },
      ],
      // אינדקס הקטגוריות: כלל התוצאות עם קטגוריית אוצריא מתגיות הקטלוג.
      index: [[43558, 7, '/שו"ת']],
    });

    // עמוד לפי מזהים מוגש מהמטמון — בלי פנייה נוספת לשרת החיפוש.
    const fetchCallsBefore = calls.filter((call) => call.method === 'network.fetchStream').length;
    listeners['search.external.requested']?.({
      requestId: 'xs-2',
      provider: 'hebrewbooks',
      query: 'ברכת המזון',
      mode: 'exact',
      distance: 2,
      ids: [43558],
    });
    await vi.waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'reader.respondExternalSearch' &&
            call.payload?.requestId === 'xs-2' &&
            call.payload?.done !== false,
        ),
      ).toBe(true);
    });
    const idsResponse = [...calls]
      .reverse()
      .find(
        (call) =>
          call.method === 'reader.respondExternalSearch' && call.payload?.requestId === 'xs-2',
      );
    expect(idsResponse?.payload).toMatchObject({
      hasMore: false,
      results: [{ externalId: 43558, hitCount: 7 }],
    });
    expect(idsResponse?.payload?.index).toBeUndefined();
    expect(calls.filter((call) => call.method === 'network.fetchStream')).toHaveLength(
      fetchCallsBefore,
    );
  });

  it('מעדן את אינדקס הקטגוריות דרך מיפוי ההשוואות ומסלול ה-bulk של המארח', async () => {
    const listeners: Record<string, (payload: unknown) => void> = {};
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const searchRow = JSON.stringify({
      fileId: '43558',
      bookName: 'קובץ שיטות קמאי',
      sourceType: 'PDF',
      categories: 'גאונים|שו"ת',
      hitCount: 7,
    });
    const mockBridge: HostBridge = {
      call: vi.fn((method: string, payload?: Record<string, unknown>) => {
        calls.push({ method, payload });
        if (method === 'network.fetchStream') {
          return (async function* () {
            yield { sequence: 0, type: 'response', status: 200, ok: true, headers: {} };
            yield { sequence: 1, type: 'data', body: `${searchRow}\n` };
          })();
        }
        if (method === 'database.batchQuery') {
          return Promise.resolve({
            success: true,
            data: { results: [{ rows: [{ hb_id: 43558, otzaria_id: 2001 }] }] },
            error: null,
          });
        }
        if (method === 'library.resolveCategoryPaths') {
          expect(payload?.ids).toEqual([2001]);
          return Promise.resolve({ success: true, data: ['/הלכה/שולחן ערוך'], error: null });
        }
        return Promise.resolve({ success: true, data: true, error: null });
      }) as unknown as HostBridge['call'],
      on: (event: string, callback: (payload: never) => void) => {
        listeners[event] = callback as (payload: unknown) => void;
      },
    };

    const shell = document.createElement('div');
    const controller = new AppController(mockBridge, shell);
    await controller.boot({
      app: { platform: 'macos', version: '0.9.97', locale: 'he', textDirection: 'rtl' },
      plugin: { id: 'hebrewbooks', version: '0.5.5' },
      theme: {
        mode: 'light',
        colorScheme: {},
        typography: { fontFamily: 'Roboto', fontSize: 14, lineHeight: 1.4 },
      },
      permissions: [],
    });

    listeners['search.external.requested']?.({
      requestId: 'xs-1',
      provider: 'hebrewbooks',
      query: 'ברכת המזון',
      mode: 'exact',
      distance: 2,
      offset: 0,
      limit: 20,
    });
    await vi.waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'reader.respondExternalSearch' && call.payload?.done !== false,
        ),
      ).toBe(true);
    });

    // ספר ממופה מקבל את נתיב הקטגוריה המדויק מהספרייה — לא את הצעת התגיות.
    const responses = calls.filter((call) => call.method === 'reader.respondExternalSearch');
    expect(responses.at(-1)?.payload).toMatchObject({
      index: [[43558, 7, '/הלכה/שולחן ערוך']],
    });
    // התוצאות עצמן לא המתינו לעידון: עדכון עם התוצאות נשלח לפני שהאינדקס מוכן.
    const firstWithResults = responses.find(
      (call) => Array.isArray(call.payload?.results) && (call.payload.results as unknown[]).length > 0,
    );
    expect(firstWithResults?.payload?.index).toBeUndefined();

    // חיפוש חוזר זהה מוגש ממטמון האינדקס המעודן — בלי מיפוי נוסף על הגשר.
    const mappingCallsBefore = calls.filter((call) => call.method === 'database.batchQuery').length;
    listeners['search.external.requested']?.({
      requestId: 'xs-2',
      provider: 'hebrewbooks',
      query: 'ברכת המזון',
      mode: 'exact',
      distance: 2,
      offset: 0,
      limit: 20,
    });
    await vi.waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'reader.respondExternalSearch' &&
            call.payload?.requestId === 'xs-2' &&
            call.payload?.done !== false,
        ),
      ).toBe(true);
    });
    expect(calls.filter((call) => call.method === 'database.batchQuery')).toHaveLength(
      mappingCallsBefore,
    );
  });

  it('does not let a delayed settings.get response overwrite a newer settings.changed event', async () => {
    const listeners: Record<string, (payload: unknown) => void> = {};
    let resolveSetting!: (value: { success: boolean; data: string | null; error: null }) => void;
    const mockBridge: HostBridge = {
      call: vi.fn((method: string, payload?: Record<string, unknown>) => {
        if (method === 'settings.get' && payload?.key === 'key-hebrew-books-path') {
          return new Promise((resolve) => { resolveSetting = resolve; });
        }
        return Promise.resolve({ success: true, data: null, error: null });
      }) as unknown as HostBridge['call'],
      on: (event: string, callback: (payload: never) => void) => {
        listeners[event] = callback as (payload: unknown) => void;
      },
    };
    const shell = document.createElement('div');
    const controller = new AppController(mockBridge, shell);
    const boot = controller.boot({
      app: { platform: 'macos', version: '0.9.97', locale: 'he', textDirection: 'rtl' },
      plugin: { id: 'hebrewbooks', version: '0.5.4' },
      theme: {
        mode: 'light',
        colorScheme: {},
        typography: { fontFamily: 'Roboto', fontSize: 14, lineHeight: 1.4 },
      },
      permissions: ['settings.read', 'events.subscribe:settings.changed'],
    });

    listeners['settings.changed']?.({ key: 'key-hebrew-books-path', newValue: '/newer/path' });
    resolveSetting({ success: true, data: '/stale/path', error: null });
    await boot;

    expect(shell.querySelector('.library-hebrewbooks-path-status')?.textContent).toBe(
      'מיקום ספרי היברובוקס באוצריא: הוגדר (/newer/path)',
    );
  });
});
