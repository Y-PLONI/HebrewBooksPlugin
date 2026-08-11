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
});
