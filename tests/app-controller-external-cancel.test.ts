// @vitest-environment jsdom

/// אוצריא אינה משגרת אירוע ביטול כשטאב החיפוש נסגר. הסימן היחיד שהיא כן
/// מוסרת הוא דחיית עדכון חלקי בקוד `error.not_found`, ובליעתו היא מה שהשאיר
/// חיפוש רץ בשירות — ואת הכונן עובד — דקות אחרי שהמדור שביקש אותו נעלם.
/// הטסטים כאן שומרים על שני הכיוונים: דחייה כזו מבטלת את החיפוש בשרת,
/// ותקלה חולפת אינה מבטלת דבר.

import { describe, expect, it, vi } from 'vitest';

const { AppController } = await import('../src/app-controller');
const { bootPayload, createMockHost, hebrewBooksRow, MockHostError } = await import(
  './helpers/mock-host'
);

type MockHost = ReturnType<typeof createMockHost>;
type MockHostConfig = import('./helpers/mock-host').MockHostConfig;

const streamId = 'D'.repeat(64);
const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;

/// זרם v2 שמגלה תוצאה ואז משתהה — בדיוק כמו חיפוש רחב שעוד עובד על הכונן
/// כשהמדור שביקש אותו כבר אינו שם.
function slowStreamHost(
  respond: (payload: Record<string, unknown> | undefined) => unknown,
): MockHostConfig {
  return {
    methods: { 'reader.respondExternalSearch': respond },
    network: {
      '/health': () => ({
        body: JSON.stringify({
          ok: true,
          service: 'hbsearch',
          apiVersion: 2,
          capabilities: ['pdf-range', 'search-stream-v2', 'search-cancel-v2'],
        }),
      }),
      '/search': () => ({
        bodies: [
          line({ type: 'start', streamVersion: 2, streamId })
            + line({ type: 'provisional', result: JSON.parse(hebrewBooksRow({ fileId: '901' })) }),
          line({ type: 'reset', count: 1 })
            + line({ type: 'result', rank: 0, result: JSON.parse(hebrewBooksRow({ fileId: '901' })) })
            + line({ type: 'complete', count: 1 }),
        ],
        // הזרם נשאר פתוח מספיק זמן כדי שהדחייה תגיע באמצע החיפוש.
        bodyDelaysMs: [0, 5_000],
      }),
      '/search/cancel': () => ({ body: '{"cancelled":true}' }),
    },
  };
}

async function bootController(config: MockHostConfig): Promise<MockHost> {
  const host = createMockHost(config);
  const controller = new AppController(host.bridge, document.createElement('div'));
  await controller.boot(bootPayload());
  await Promise.resolve();
  return host;
}

function cancelledStreamIds(host: MockHost): string[] {
  return host
    .payloadsOf('network.fetchStream')
    .filter((payload) => String(payload?.url).endsWith('/search/cancel'))
    .map((payload) => JSON.parse(String(payload?.body)).streamId as string);
}

describe('ספק התוצאות החיצוני — נטישת המארח', () => {
  it('דחיית עדכון חלקי ב-error.not_found מבטלת את החיפוש בשירות', async () => {
    const host = await bootController(
      slowStreamHost(() => {
        throw new MockHostError('error.not_found', 'request does not belong to this plugin');
      }),
    );
    host.emit('search.external.requested', {
      requestId: 'xs-1',
      provider: 'hebrewbooks',
      query: 'ברכת המזון',
      mode: 'exact',
      distance: 2,
      offset: 0,
      limit: 20,
    });
    await vi.waitFor(() => expect(cancelledStreamIds(host)).toEqual([streamId]), { timeout: 4_000 });
  });

  it('תקלה חולפת בגשר אינה מבטלת חיפוש שעדיין מבוקש', async () => {
    let rejections = 0;
    const host = await bootController(
      slowStreamHost(() => {
        // רק העדכון הראשון נכשל, וללא קוד מזוהה — הבקשה עדיין פתוחה.
        if (++rejections === 1) throw new Error('הגשר עמוס');
        return true;
      }),
    );
    host.emit('search.external.requested', {
      requestId: 'xs-2',
      provider: 'hebrewbooks',
      query: 'ברכת המזון',
      mode: 'exact',
      distance: 2,
      offset: 0,
      limit: 20,
    });
    await vi.waitFor(() => expect(rejections).toBeGreaterThan(0), { timeout: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cancelledStreamIds(host)).toEqual([]);
  });
});
