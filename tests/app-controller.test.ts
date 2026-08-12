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
      expect(calls.some((call) => call.method === 'reader.respondExternalSearch')).toBe(true);
    });

    const response = calls.find((call) => call.method === 'reader.respondExternalSearch');
    expect(response?.payload).toMatchObject({
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
    });
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
