import { describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '../src/bridge';
import { defaultSearchOptions, type SearchSnapshot } from '../src/models';
import { HebrewBooksRepository } from '../src/repositories/hebrewbooks-repository';
import { createMockHost, hebrewBooksNdjson, hebrewBooksRow, type NetworkReply } from './helpers/mock-host';

function snapshot(query = 'ברכת המזון'): SearchSnapshot {
  return { query, options: defaultSearchOptions, fingerprint: `${query}\0default` };
}

/// גשר שמחזיר מקטעי רשת גולמיים — לבדיקת הפרות פרוטוקול שהמארח לא אמור לייצר.
function rawBridge(chunks: readonly unknown[]): HostBridge {
  return {
    call: vi.fn(() =>
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    ) as unknown as HostBridge['call'],
    on: () => undefined,
  };
}

describe('HebrewBooksRepository.health', () => {
  it('שירות עם apiVersion 2 ו-pdf-range הוא "חיפוש ועיון"', async () => {
    const host = createMockHost({
      network: {
        '/health': () => ({
          body: JSON.stringify({
            ok: true,
            service: 'hbsearch',
            apiVersion: 2,
            capabilities: ['pdf-range', 'inbook'],
            serverVersion: '2.1.0',
          }),
        }),
      },
    });
    await expect(new HebrewBooksRepository(host.bridge).health()).resolves.toEqual({
      kind: 'onlineFull',
      serverVersion: '2.1.0',
    });
  });

  it('שירות ללא apiVersion הוא "חיפוש בלבד", וגרסה חסרה היא null', async () => {
    const host = createMockHost({
      network: {
        '/health': () => ({ body: JSON.stringify({ ok: true, service: 'hbsearch' }) }),
      },
    });
    await expect(new HebrewBooksRepository(host.bridge).health()).resolves.toEqual({
      kind: 'onlineLegacy',
      serverVersion: null,
    });
  });

  it('apiVersion 2 בלי pdf-range נחשב לגרסה לא תואמת', async () => {
    const host = createMockHost({
      network: {
        '/health': () => ({
          body: JSON.stringify({ ok: true, service: 'hbsearch', apiVersion: 2, capabilities: [] }),
        }),
      },
    });
    await expect(new HebrewBooksRepository(host.bridge).health()).rejects.toThrow(
      'גרסת השירות אינה מצהירה על תמיכה בקובצי PDF',
    );
  });

  it('שירות אחר שמאזין על אותו פורט נדחה', async () => {
    const host = createMockHost({
      network: { '/health': () => ({ body: JSON.stringify({ ok: true, service: 'something-else' }) }) },
    });
    await expect(new HebrewBooksRepository(host.bridge).health()).rejects.toThrow(
      'שירות החיפוש המקומי אינו זמין או אינו תואם',
    );
  });

  it('ok: false נדחה גם כשה-HTTP הצליח', async () => {
    const host = createMockHost({
      network: { '/health': () => ({ body: JSON.stringify({ ok: false, service: 'hbsearch' }) }) },
    });
    await expect(new HebrewBooksRepository(host.bridge).health()).rejects.toThrow(
      'שירות החיפוש המקומי אינו זמין או אינו תואם',
    );
  });

  it('תשובה שאינה JSON מדווחת כתשובה לא תקינה', async () => {
    const host = createMockHost({ network: { '/health': () => ({ body: '<html>502</html>' }) } });
    await expect(new HebrewBooksRepository(host.bridge).health()).rejects.toThrow(
      'בדיקת השירות: התקבלה תשובה לא תקינה',
    );
  });

  it('מערך במקום אובייקט אינו נחשב לתשובה תקינה', async () => {
    const host = createMockHost({ network: { '/health': () => ({ body: '[{"ok":true}]' }) } });
    await expect(new HebrewBooksRepository(host.bridge).health()).rejects.toThrow(
      'בדיקת השירות: התקבלה תשובה לא תקינה',
    );
  });
});

describe('HebrewBooksRepository.pdfUrl', () => {
  const repository = new HebrewBooksRepository(createMockHost().bridge);

  it('בונה כתובת לשירות המקומי לפי מזהה הספר', () => {
    expect(repository.pdfUrl('43558')).toBe('http://127.0.0.1:8080/pdf/43558');
  });

  it('דוחה מזהה שאינו מספר חיובי', () => {
    expect(() => repository.pdfUrl('0')).toThrow('מזהה הספר אינו תקין');
    expect(() => repository.pdfUrl('')).toThrow('מזהה הספר אינו תקין');
    expect(() => repository.pdfUrl('12a')).toThrow('מזהה הספר אינו תקין');
    expect(() => repository.pdfUrl('../secret')).toThrow('מזהה הספר אינו תקין');
  });
});

/// /health הוא המקור היחיד לאסימון, והוא מתחלף בכל הפעלה של השירות.
function healthHost(tokens: readonly (string | null)[], slowFromCall = Number.MAX_SAFE_INTEGER) {
  let call = 0;
  return createMockHost({
    network: {
      '/health': () => {
        const index = call++;
        const token = tokens[Math.min(index, tokens.length - 1)];
        const body = JSON.stringify({
          ok: true,
          service: 'hbsearch',
          apiVersion: 2,
          capabilities: ['pdf-range'],
          ...(token === null ? {} : { pdfToken: token }),
        });
        // מאיטים קריאה מסוימת כדי שהריענון יהיה באוויר בזמן שבודקים אותו.
        return index + 1 >= slowFromCall ? { bodies: [body], bodyDelaysMs: [40] } : { body };
      },
    },
  });
}

const flush = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

/// כל קריאה ל-/health ממתינה עד ששחרור מפורש קובע את סדר הנחיתה.
function gatedHealthHost() {
  const gates: Array<(reply: NetworkReply) => void> = [];
  const host = createMockHost({
    network: {
      '/health': () =>
        new Promise<NetworkReply>((resolve) => {
          gates.push(resolve);
        }),
    },
  });
  const release = (index: number, pdfToken: string): void => {
    gates[index]!({
      body: JSON.stringify({
        ok: true,
        service: 'hbsearch',
        apiVersion: 2,
        capabilities: ['pdf-range'],
        pdfToken,
      }),
    });
  };
  return { host, release };
}

describe('אסימון הגישה ל-/pdf', () => {
  it('מצורף לכתובת אחרי שנקרא מ-/health', async () => {
    const repository = new HebrewBooksRepository(healthHost(['ABC123']).bridge);
    await repository.health();
    expect(repository.pdfUrl('43558')).toBe('http://127.0.0.1:8080/pdf/43558?pdfToken=ABC123');
  });

  it('שרת בלי אסימון מקבל כתובת נקייה, בלי pdfToken=undefined', async () => {
    const repository = new HebrewBooksRepository(healthHost([null]).bridge);
    await repository.health();
    const url = repository.pdfUrl('43558');
    expect(url).toBe('http://127.0.0.1:8080/pdf/43558');
    expect(url).not.toContain('pdfToken');
  });

  it('הפעלה מחדש של השירות מחליפה אסימון — נעשה ניסיון שני עם החדש', async () => {
    const repository = new HebrewBooksRepository(healthHost(['OLD', 'NEW']).bridge);
    await repository.health();
    const seen: string[] = [];
    const text = await repository.withPdfAccess('7', async (url) => {
      seen.push(url);
      if (url.includes('OLD')) throw new Error('rejected');
      return 'גזיר';
    });
    expect(text).toBe('גזיר');
    expect(seen).toEqual([
      'http://127.0.0.1:8080/pdf/7?pdfToken=OLD',
      'http://127.0.0.1:8080/pdf/7?pdfToken=NEW',
    ]);
  });

  it('כל הגזירים המקבילים מתאוששים מהחלפת אסימון, לא רק הראשון', async () => {
    const host = healthHost(['OLD', 'NEW']);
    const repository = new HebrewBooksRepository(host.bridge);
    await repository.health();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repository.withPdfAccess(String(i + 1), async (url) => {
          if (url.includes('OLD')) throw new Error('rejected');
          return 'recovered';
        }).catch(() => 'failed'),
      ),
    );
    expect(outcomes).toEqual(Array.from({ length: 8 }, () => 'recovered'));
    // ריענון אחד משותף, לא שמונה קריאות /health.
    expect(host.countOf('network.fetchStream')).toBe(2);
  });

  it('ריענון אסימון אינו מתפרסם כבדיקת היכולות המשותפת, ולכן ביטול חיפוש אינו הורג אותו', async () => {
    const repository = new HebrewBooksRepository(healthHost(['OLD', 'NEW'], 2).bridge);
    await repository.health();
    let publishedWhileRefreshing = false;
    const outcome = await repository.withPdfAccess('7', async (url) => {
      if (url.includes('OLD')) {
        // בזמן שהריענון באוויר: בדיקה משותפת שפורסמה הייתה נעצרת ע"י חיפוש מבוטל.
        setTimeout(() => {
          const probe = (repository as unknown as { capabilityProbe: { stop: AbortController } | null })
            .capabilityProbe;
          if (probe) {
            publishedWhileRefreshing = true;
            probe.stop.abort();
          }
        }, 10);
        throw new Error('rejected');
      }
      return 'recovered';
    }).catch(() => 'stale');
    expect(publishedWhileRefreshing).toBe(false);
    expect(outcome).toBe('recovered');
  });

  it('ריענון מקביל שכבר החליף אסימון אינו מבטל את הניסיון השני', async () => {
    const repository = new HebrewBooksRepository(healthHost(['OLD', 'NEW']).bridge);
    await repository.health();
    const outcome = await repository.withPdfAccess('7', async (url) => {
      if (url.includes('OLD')) {
        // בקשה באוויר עם OLD, בעוד health() אחר כבר נועל את NEW.
        await repository.health();
        throw new Error('rejected');
      }
      return 'recovered';
    }).catch(() => 'stale');
    expect(outcome).toBe('recovered');
  });

  /// מרוץ הבדיקות: בדיקה שיצאה ראשונה ונחתה אחרונה נושאת אסימון מיושן.
  it('בדיקת שירות ישנה שנחתה אחרי חדשה אינה דורסת את האסימון החדש', async () => {
    const { host, release } = gatedHealthHost();
    const repository = new HebrewBooksRepository(host.bridge);

    const first = repository.health();
    await flush();
    const second = repository.health();
    await flush();
    release(1, 'NEW');
    await second;
    expect(repository.pdfUrl('7')).toBe('http://127.0.0.1:8080/pdf/7?pdfToken=NEW');

    release(0, 'OLD');
    await first;

    expect(repository.pdfUrl('7')).toBe('http://127.0.0.1:8080/pdf/7?pdfToken=NEW');
    expect(host.countOf('network.fetchStream')).toBe(2);
  });

  it('אסימון שלא התחלף אינו מצדיק ניסיון שני', async () => {
    const repository = new HebrewBooksRepository(healthHost(['SAME']).bridge);
    await repository.health();
    let runs = 0;
    await expect(
      repository.withPdfAccess('7', async () => {
        runs += 1;
        throw new Error('הקובץ אינו זמין');
      }),
    ).rejects.toThrow('הקובץ אינו זמין');
    expect(runs).toBe(1);
  });
});

describe('HebrewBooksRepository.inBook', () => {
  it('שולח את אפשרויות החיפוש ומנרמל עמודים ומונחים', async () => {
    const host = createMockHost({
      network: {
        '/inbook': () => ({
          body: JSON.stringify({
            hitCount: 12,
            pages: [7, 3, 3, 0, -2, 5.5, 5],
            matchedTerms: ['ברכת', 'ברכת', '  ', 'המזון'],
          }),
        }),
      },
    });
    const locations = await new HebrewBooksRepository(host.bridge).inBook(snapshot(), '43558');
    expect(locations).toEqual({ hitCount: 12, pages: [3, 5, 7], matchedTerms: ['ברכת', 'המזון'] });

    const payload = host.lastPayload('network.fetchStream');
    expect(payload?.url).toBe('http://127.0.0.1:8080/inbook');
    expect(JSON.parse(String(payload?.body))).toMatchObject({
      fileName: '43558',
      q: 'ברכת המזון',
      displayQuery: 'ברכת המזון',
      proximity: defaultSearchOptions.proximity,
      fuzziness: 0,
      requireWordOrder: false,
      compactCharClass: true,
    });
  });

  it('גוזם מונח ארוך ל-80 תווים ומגביל ל-50 מונחים', async () => {
    const terms = Array.from({ length: 60 }, (_, index) => `מונח-${index}`);
    const host = createMockHost({
      network: {
        '/inbook': () => ({
          body: JSON.stringify({ pages: [1], matchedTerms: ['א'.repeat(200), ...terms] }),
        }),
      },
    });
    const locations = await new HebrewBooksRepository(host.bridge).inBook(snapshot(), '1');
    expect(locations.matchedTerms).toHaveLength(50);
    expect(locations.matchedTerms[0]).toHaveLength(80);
  });

  it('שדות חסרים בתשובה אינם מפילים את הבקשה', async () => {
    const host = createMockHost({ network: { '/inbook': () => ({ body: '{}' }) } });
    await expect(new HebrewBooksRepository(host.bridge).inBook(snapshot(), '1')).resolves.toEqual({
      hitCount: 0,
      pages: [],
      matchedTerms: [],
    });
  });

  it('שגיאת שרת עם גוף JSON מציגה את הודעת השרת', async () => {
    const host = createMockHost({
      network: {
        '/inbook': () => ({ status: 400, ok: false, body: JSON.stringify({ error: 'proximity expects a positive integer' }) }),
      },
    });
    await expect(new HebrewBooksRepository(host.bridge).inBook(snapshot(), '1')).rejects.toThrow(
      'proximity expects a positive integer',
    );
  });

  it('שגיאת שרת בלי JSON נופלת להודעה עם קוד ה-HTTP', async () => {
    const host = createMockHost({
      network: { '/inbook': () => ({ status: 503, ok: false, body: 'service unavailable' }) },
    });
    await expect(new HebrewBooksRepository(host.bridge).inBook(snapshot(), '1')).rejects.toThrow(
      'לא ניתן היה לאתר עמודים בספר (HTTP 503)',
    );
  });
});

describe('HebrewBooksRepository.search protocol', () => {
  it('מסמן קטיעה כשמספר התוצאות הגיע לתקרת max', async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      hebrewBooksRow({ fileId: String(index + 1), hitCount: 2 }),
    );
    const host = createMockHost({
      network: { '/search': () => ({ body: hebrewBooksNdjson(rows) }) },
    });
    const page = await new HebrewBooksRepository(host.bridge).search({
      query: 'א',
      options: { ...defaultSearchOptions, max: 3, limit: 2 },
      fingerprint: 'capped',
    });
    expect(page).toMatchObject({ totalBooks: 3, totalHits: 6, truncated: true });
    expect(page.results).toHaveLength(2);
  });

  it('שולח את השאילתה והאפשרויות ומבקש max תוצאות מהשרת', async () => {
    const host = createMockHost({
      network: { '/search': () => ({ body: hebrewBooksNdjson([hebrewBooksRow()]) }) },
    });
    await new HebrewBooksRepository(host.bridge).search(snapshot('ברכת המזון'));
    const payload = host.lastPayload('network.fetchStream');
    expect(payload?.timeoutMs).toBe(120_000);
    expect(JSON.parse(String(payload?.body))).toMatchObject({
      q: 'ברכת המזון',
      limit: defaultSearchOptions.max,
      sort: 'hitcount',
      corpus: ['pdf'],
    });
  });

  it('דוחה מקטע רשת עם sequence לא צפוי', async () => {
    const bridge = rawBridge([
      { sequence: 0, type: 'response', status: 200, ok: true, headers: {} },
      { sequence: 5, type: 'data', body: `${hebrewBooksRow()}\n` },
    ]);
    await expect(new HebrewBooksRepository(bridge).search(snapshot())).rejects.toThrow(
      'אוצריא החזירה מקטע רשת לא תקין',
    );
  });

  it('דוחה כותרות תגובה כפולות', async () => {
    const bridge = rawBridge([
      { sequence: 0, type: 'response', status: 200, ok: true, headers: {} },
      { sequence: 1, type: 'response', status: 200, ok: true, headers: {} },
    ]);
    await expect(new HebrewBooksRepository(bridge).search(snapshot())).rejects.toThrow(
      'השרת החזיר כותרות תגובה כפולות',
    );
  });

  it('דוחה מקטע שאינו אובייקט תקין', async () => {
    const bridge = rawBridge([{ sequence: 0, type: 'unknown' }]);
    await expect(new HebrewBooksRepository(bridge).search(snapshot())).rejects.toThrow(
      'אוצריא החזירה מקטע רשת לא תקין',
    );
  });

  it('זרם ריק לגמרי — השרת לא החזיר פרטי תגובה', async () => {
    const bridge = rawBridge([]);
    await expect(new HebrewBooksRepository(bridge).search(snapshot())).rejects.toThrow(
      'השרת לא החזיר פרטי תגובה',
    );
  });

  it('גוף תשובה שחורג מ-16MB נעצר במקום להיצבר', async () => {
    const megabyte = 'x'.repeat(1024 * 1024);
    const bridge = rawBridge([
      { sequence: 0, type: 'response', status: 500, ok: false, headers: {} },
      ...Array.from({ length: 17 }, (_, index) => ({
        sequence: index + 1,
        type: 'data',
        body: megabyte,
      })),
    ]);
    await expect(new HebrewBooksRepository(bridge).search(snapshot())).rejects.toThrow(
      'תשובת השרת גדולה מהמגבלה המותרת',
    );
  });
});
