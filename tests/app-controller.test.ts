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
