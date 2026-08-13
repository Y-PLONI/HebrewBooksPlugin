// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHostBridge, requireHostData, type HostBridge } from '../src/bridge';

function bridgeReturning(response: unknown): HostBridge {
  return {
    call: vi.fn(() => Promise.resolve(response)) as unknown as HostBridge['call'],
    on: () => undefined,
  };
}

describe('getHostBridge', () => {
  afterEach(() => {
    delete (window as { Otzaria?: unknown }).Otzaria;
  });

  it('מחזיר null כשהדף נפתח מחוץ לאוצריא', () => {
    expect(getHostBridge()).toBeNull();
  });

  it('מחזיר את ה-SDK שאוצריא הזריקה ל-window', () => {
    const sdk = { call: () => undefined, on: () => undefined };
    (window as { Otzaria?: unknown }).Otzaria = sdk;
    expect(getHostBridge()).toBe(sdk);
  });
});

describe('requireHostData', () => {
  it('מחזיר את ה-data של תשובה מוצלחת', async () => {
    const bridge = bridgeReturning({ success: true, data: { title: 'ספר' }, error: null });
    await expect(requireHostData<{ title: string }>(bridge, 'library.findBooks')).resolves.toEqual({
      title: 'ספר',
    });
  });

  it('מעביר את המנה כפי שהיא למארח', async () => {
    const bridge = bridgeReturning({ success: true, data: true, error: null });
    await requireHostData(bridge, 'reader.openBook', { bookId: 'abc', index: 3 });
    expect(bridge.call).toHaveBeenCalledWith('reader.openBook', { bookId: 'abc', index: 3 });
  });

  it('נכשל בהודעת השגיאה של המארח', async () => {
    const bridge = bridgeReturning({
      success: false,
      data: null,
      error: { code: 'denied', message: 'אין הרשאה' },
    });
    await expect(requireHostData(bridge, 'database.batchQuery')).rejects.toThrow('אין הרשאה');
  });

  it('נכשל בהודעה גנרית כשהמארח לא פירט שגיאה', async () => {
    const bridge = bridgeReturning({ success: false, data: null, error: null });
    await expect(requireHostData(bridge, 'reader.openSearchTab')).rejects.toThrow(
      'הפעולה reader.openSearchTab נכשלה',
    );
  });

  it('data ריק נחשב לכישלון גם כשהמארח דיווח על הצלחה', async () => {
    const bridge = bridgeReturning({ success: true, data: null, error: null });
    await expect(requireHostData(bridge, 'library.resolveCategoryPaths')).rejects.toThrow(
      'הפעולה library.resolveCategoryPaths נכשלה',
    );
  });

  it('false הוא נתון תקין — פעולה שהמארח דחה אינה שגיאה', async () => {
    const bridge = bridgeReturning({ success: true, data: false, error: null });
    await expect(requireHostData<boolean>(bridge, 'reader.openBook')).resolves.toBe(false);
  });
});
