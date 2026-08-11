import { describe, expect, it } from 'vitest';
import type { HostBridge } from '../src/bridge';
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
  it('allows two minutes for a HebrewBooks search', async () => {
    let payload: Record<string, unknown> | undefined;
    const bridge: HostBridge = {
      call: (async <T>(_method: string, request?: Record<string, unknown>) => {
        payload = request;
        return {
          success: true,
          data: { status: 200, ok: true, body: '' } as T,
          error: null,
        };
      }) as HostBridge['call'],
      on: () => undefined,
    };

    await new HebrewBooksRepository(bridge).search(snapshot);

    expect(payload?.timeoutMs).toBe(120_000);
  });
});
