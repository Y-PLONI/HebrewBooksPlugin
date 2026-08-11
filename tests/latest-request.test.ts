import { describe, expect, it } from 'vitest';
import { LatestRequest } from '../src/services/latest-request';

describe('LatestRequest', () => {
  it('מבטל את תוצאת הבקשה הקודמת כשמתחילה בקשה חדשה', () => {
    const latest = new LatestRequest();
    const first = latest.begin();
    const second = latest.begin();

    expect(latest.isCurrent(first)).toBe(false);
    expect(latest.isCurrent(second)).toBe(true);
  });

  it('מתעלם מתשובה ישנה שהגיעה אחרי התשובה החדשה', async () => {
    const latest = new LatestRequest();
    const committed: string[] = [];
    let resolveFirst!: (value: string) => void;
    const firstResult = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const apply = async (requestId: number, result: Promise<string>): Promise<void> => {
      const value = await result;
      if (latest.isCurrent(requestId)) committed.push(value);
    };

    const firstTask = apply(latest.begin(), firstResult);
    await apply(latest.begin(), Promise.resolve('חדש'));
    resolveFirst('ישן');
    await firstTask;

    expect(committed).toEqual(['חדש']);
  });
});
