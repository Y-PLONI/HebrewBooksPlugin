import type { HostBridge, NetworkFetchParams, NetworkFetchStreamChunk } from '../bridge';
import type {
  HealthStatus,
  HebrewBooksResult,
  HebrewBooksSearchPage,
  InBookLocations,
  SearchSnapshot,
} from '../models';
import { SearchNdjsonDecoder, SearchStreamV2Decoder, type SearchStreamV2Event } from '../utils/ndjson';

interface NetworkResponse {
  status: number;
  ok: boolean;
  body: string;
}

const baseUrl = 'http://127.0.0.1:8080';
const searchTimeoutMs = 120_000;
const healthTimeoutMs = 10_000;
const pdfRefreshCooldownMs = 5_000;
const pdfRefreshGraceMs = 3_000;
const maximumResponseLength = 16 * 1024 * 1024;
/// כמה חיפוש ממתין לגילוי; מעבר לזה הבדיקה נמשכת ברקע לטובת החיפוש הבא.
const discoveryGraceMs = 2_000;
/// ורדיקט "ישן" נבדק מחדש, כדי שהתקנת שירות חדש תיתפס באותו סשן.
const capabilityRecheckMs = 120_000;

type SearchUpdate = (page: HebrewBooksSearchPage) => boolean | void;

interface CachedSearch {
  fingerprint: string;
  results: HebrewBooksResult[];
  totalHits: number;
  truncated: boolean;
}

/// יכולות פרוטוקול החיפוש כפי שהשירות הצהיר עליהן ב-/health.
interface SearchCapabilities {
  readonly streamV2: boolean;
  readonly cancelV2: boolean;
}

interface HealthProbe {
  readonly status: HealthStatus;
  readonly capabilities: SearchCapabilities;
  /// נוגע רק במצב התצוגה — אינו מבטל את זרם v2 ואת הביטול בשרת.
  readonly pdfRangeMissing: boolean;
}

interface CapabilityProbe {
  readonly result: Promise<HealthProbe>;
  readonly stop: AbortController;
  waiters: number;
}

/// המסלול הישן: בלי streamVersion, בלי heartbeat ובלי /search/cancel.
const legacyCapabilities: SearchCapabilities = { streamV2: false, cancelV2: false };

export class HebrewBooksRepository {
  private cachedSearch: CachedSearch | null = null;
  /// ננעל רק אחרי גילוי שהצליח; כישלון לעולם אינו ננעל.
  private capabilities: SearchCapabilities | null = null;
  /// אסימון גישה ל-/pdf לכל הרצה של השירות, נקרא מ-/health.
  private pdfToken: string | null = null;
  private pdfRefreshAt = 0;
  /// ריענון אחד בטיסה, משותף לכל מי שנכשל באותו רגע.
  private pdfRefresh: Promise<void> | null = null;
  /// גילוי אחד משותף — מצטרפים אליו במקום לפתוח שני.
  private capabilityProbe: CapabilityProbe | null = null;
  private capabilitiesAt = 0;

  constructor(private readonly bridge: HostBridge) {}

  async health(): Promise<HealthStatus> {
    const probe = this.beginCapabilityProbe();
    probe.waiters += 1;
    try {
      const result = await probe.result;
      if (result.pdfRangeMissing) throw new Error('גרסת השירות אינה מצהירה על תמיכה בקובצי PDF');
      return result.status;
    } finally {
      probe.waiters -= 1;
    }
  }

  /// פותחת בדיקה חדשה ומפרסמת אותה כגילוי הפעיל.
  private beginCapabilityProbe(): CapabilityProbe {
    const stop = new AbortController();
    const probe: CapabilityProbe = { result: this.requestHealth(stop.signal), stop, waiters: 0 };
    this.capabilityProbe = probe;
    const done = (): void => {
      if (this.capabilityProbe === probe) this.capabilityProbe = null;
    };
    void probe.result.then(
      (result) => {
        this.capabilities = result.capabilities;
        this.capabilitiesAt = Date.now();
        done();
      },
      done,
    );
    return probe;
  }

  /// היכולות לחיפוש הנוכחי; חיפוש מוקדם ממתין לגילוי במקום להתחרות בו.
  private async searchCapabilities(signal?: AbortSignal): Promise<SearchCapabilities | null> {
    const latched = this.freshCapabilities();
    if (latched) return latched;
    // בלי ורדיקט אין לנו מידע לנחש לפיו — תמיד מנהלים משא ומתן מחדש.
    const probe = this.capabilityProbe ?? this.beginCapabilityProbe();
    probe.waiters += 1;
    try {
      const result = await untilAborted(withinGrace(probe.result, discoveryGraceMs), signal);
      if (signal?.aborted) return null;
      return result === null ? legacyCapabilities : result.capabilities;
    } catch {
      // החיפוש עצמו ייכשל מיד אחריו ויציג את השגיאה האמיתית.
      return legacyCapabilities;
    } finally {
      probe.waiters -= 1;
      // אין מי שממתין לבדיקה — אין טעם להחזיק את הבקשה פתוחה.
      if (probe.waiters === 0 && signal?.aborted) probe.stop.abort();
    }
  }

  /// ורדיקט v2 נשמר; ורדיקט "ישן" מתיישן, כדי שגרסה חדשה שהותקנה תיתפס.
  private freshCapabilities(): SearchCapabilities | null {
    const latched = this.capabilities;
    if (!latched || latched.streamV2) return latched;
    return Date.now() - this.capabilitiesAt < capabilityRecheckMs ? latched : null;
  }


  private async requestHealth(signal?: AbortSignal): Promise<HealthProbe> {
    const response = await this.fetch('/health', { timeoutMs: healthTimeoutMs }, signal);
    const body = parseJsonRecord(response.body, 'בדיקת השירות');
    if (!response.ok || body.ok !== true || body.service !== 'hbsearch') {
      throw new Error('שירות החיפוש המקומי אינו זמין או אינו תואם');
    }

    const capabilities = Array.isArray(body.capabilities)
      ? body.capabilities.filter((item): item is string => typeof item === 'string')
      : [];
    const apiVersion = typeof body.apiVersion === 'number' ? body.apiVersion : null;
    const modern = apiVersion !== null && apiVersion >= 2;
    const pdfRange = capabilities.includes('pdf-range');
    // /health מגיע דרך גשר המארח (קריאה נייטיבית), ולכן אתר זדוני אינו יכול לקרוא
    // את האסימון הזה — וגם iframe בארגז חול לא יוכל לזייף בקשת /pdf קריאה.
    this.pdfToken = typeof body.pdfToken === 'string' ? body.pdfToken : null;
    const streamV2 = modern && capabilities.includes('search-stream-v2');

    return {
      pdfRangeMissing: modern && !pdfRange,
      status: {
        kind: modern && pdfRange ? 'onlineFull' : 'onlineLegacy',
        serverVersion: typeof body.serverVersion === 'string' ? body.serverVersion : null,
      },
      capabilities: {
        streamV2,
        cancelV2: streamV2 && capabilities.includes('search-cancel-v2'),
      },
    };
  }

  /// כלל תוצאות החיפוש שבמטמון עבור [fingerprint], או null כשאין התאמה.
  /// משמש את המדור החיצוני לבניית אינדקס הקטגוריות ולעמודים לפי מזהים.
  cachedResultsFor(fingerprint: string): HebrewBooksResult[] | null {
    return this.cachedSearch?.fingerprint === fingerprint ? this.cachedSearch.results : null;
  }

  async search(
    snapshot: SearchSnapshot,
    onUpdate?: SearchUpdate,
    signal?: AbortSignal,
    offset = 0,
  ): Promise<HebrewBooksSearchPage> {
    const cached = this.cachedSearch;
    if (cached?.fingerprint === snapshot.fingerprint) {
      return pageFromCache(cached, offset, snapshot.options.limit);
    }
    if (signal?.aborted) return emptySearchPage();
    // הגילוי מוכרע לפני שהבקשה יוצאת, ולא במרוץ מולה; ביטול קוטע אותו מיד.
    const negotiated = await this.searchCapabilities(signal);
    if (negotiated === null || signal?.aborted) return emptySearchPage();
    const { streamV2: useV2, cancelV2 } = negotiated;
    const useCancelV2 = useV2 && cancelV2;
    const stream = this.fetchStream('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        q: snapshot.query,
        ...snapshot.options,
        limit: snapshot.options.max,
        ...(useV2 ? { streamVersion: 2 } : {}),
      }),
      timeoutMs: searchTimeoutMs,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const legacyDecoder = useV2 ? null : new SearchNdjsonDecoder();
    const v2Decoder = useV2 ? new SearchStreamV2Decoder() : null;
    let results: HebrewBooksResult[] = [];
    let response: Omit<NetworkResponse, 'body'> | null = null;
    let errorBody = '';
    let expectedSequence = 0;
    let finished = false;
    let completed = false;
    let abandoned = false;
    let streamId: string | null = null;
    let cancelSent = false;
    let closing: Promise<IteratorResult<NetworkFetchStreamChunk>> | undefined;
    const provisionalIds = new Set<string>();
    let revision = 0;
    let publishedRevision = -1;
    let lastPublishedAt: number | null = null;
    /// חיפוש שבוטל מחזיר את מה שהספיק להצטבר, כמו המסלול הישן: עמוד ריק
    /// נקרא אצל הקורא כחיפוש שהסתיים בלי תוצאות, ומוחק מהמסך ספרים שכבר
    /// הוצגו. מי שביטל הוא זה שיחליט אם התשובה עוד מעניינת אותו.
    const abortedPage = (): HebrewBooksSearchPage =>
      pageFromResults(results, offset, snapshot.options);
    const requestCancel = (): void => {
      if (!useCancelV2 || !abandoned || completed || cancelSent || streamId === null) return;
      cancelSent = true;
      // This request must run independently of the original iterator's return(),
      // which may be waiting for a pending network read.
      void this.fetch('/search/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ streamId }),
        timeoutMs: 10_000,
      }).catch(() => undefined);
    };
    const abandon = (): void => {
      abandoned = true;
      requestCancel();
    };
    const closeIterator = (): Promise<IteratorResult<NetworkFetchStreamChunk>> | undefined => {
      closing ??= iterator.return?.();
      return closing;
    };
    const keepAlive = (): boolean => {
      // start מגיע לפני נעילת מנוע החיפוש; heartbeat נשלח גם בעת המתנה בתור.
      // שניהם שומרים על בקשת אוצריא פעילה בלי לשנות את הרשימה המוצגת.
      if (!onUpdate) return true;
      if (onUpdate(pageFromResults(results, offset, snapshot.options)) === false) {
        abandon();
        return false;
      }
      return true;
    };
    const publish = (force = false): boolean => {
      if (useV2) {
        if (revision === publishedRevision) return true;
        // אל תרנדר מחדש את כל תוצאות ה-DOM עבור כל אחת מ-10,000 שורות דירוג.
        // גילוי ראשון ו-reset נשלחים מיד; complete מכריח פרסום של סוף התמונה.
        if (!force && lastPublishedAt !== null && Date.now() - lastPublishedAt < 100) return true;
        publishedRevision = revision;
        lastPublishedAt = Date.now();
      }
      if (onUpdate?.(pageFromResults(results, offset, snapshot.options)) === false) {
        abandon();
        return false;
      }
      return true;
    };
    const processV2 = (events: SearchStreamV2Event[]): boolean => {
      for (const event of events) {
        switch (event.type) {
          case 'start':
            if (useCancelV2 && event.streamId === null) {
              throw new Error('אירוע start מפר את פרוטוקול זרם החיפוש v2');
            }
            streamId = event.streamId;
            if (signal?.aborted) {
              abandon();
              return false;
            }
            if (!keepAlive()) return false;
            break;
          case 'heartbeat':
            if (!keepAlive()) return false;
            break;
          case 'provisional':
            if (provisionalIds.has(event.result.fileId)) break;
            provisionalIds.add(event.result.fileId);
            results.push(event.result);
            revision += 1;
            if (!publish()) return false;
            break;
          case 'reset':
            results = [];
            provisionalIds.clear();
            revision += 1;
            if (!publish(true)) return false;
            break;
          case 'result':
            results.push(event.result);
            revision += 1;
            if (!publish()) return false;
            break;
          case 'complete':
            completed = true;
            if (!publish(true)) return false;
            break;
          case 'error':
            throw new Error(event.message);
        }
      }
      return true;
    };
    const cancel = (): void => {
      abandon();
      const cancellation = closeIterator();
      if (cancellation) void cancellation.catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });

    try {
      if (signal?.aborted) return emptySearchPage();
      while (!signal?.aborted) {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          break;
        }
        const chunk = parseNetworkChunk(next.value, expectedSequence++);
        if (chunk.type === 'response') {
          if (response !== null) throw new Error('השרת החזיר כותרות תגובה כפולות');
          response = { status: chunk.status, ok: chunk.ok };
          continue;
        }
        if (response === null) throw new Error('השרת החזיר גוף לפני כותרות התגובה');
        if (!response.ok) {
          errorBody = appendBody(errorBody, chunk.body);
          continue;
        }
        if (v2Decoder) {
          let shouldContinue = true;
          v2Decoder.push(chunk.body, (event) => {
            shouldContinue = processV2([event]);
            return shouldContinue;
          });
          if (!shouldContinue) return pageFromResults(results, offset, snapshot.options);
        } else {
          const batch = legacyDecoder!.push(chunk.body);
          if (batch.length === 0) continue;
          results.push(...batch);
          if (!publish()) return pageFromResults(results, offset, snapshot.options);
        }
      }
      if (signal?.aborted) return abortedPage();
      if (response === null) throw new Error('השרת לא החזיר פרטי תגובה');
      ensureSuccessful({ ...response, body: errorBody }, 'החיפוש נכשל');
      if (v2Decoder) {
        let shouldContinue = true;
        v2Decoder.finish((event) => {
          shouldContinue = processV2([event]);
          return shouldContinue;
        });
        if (!shouldContinue) return pageFromResults(results, offset, snapshot.options);
        if (!completed) throw new Error('זרם החיפוש הסתיים ללא אישור תוצאות סופיות');
      } else {
        const tail = legacyDecoder!.finish();
        if (tail.length > 0) {
          results.push(...tail);
          publish();
        }
      }
      const totalHits = countHits(results);
      this.cachedSearch = {
        fingerprint: snapshot.fingerprint,
        results,
        totalHits,
        truncated: results.length >= snapshot.options.max,
      };
      return pageFromCache(this.cachedSearch, offset, snapshot.options.limit);
    } catch (error) {
      if (useV2 && !completed) abandon();
      if (signal?.aborted) return abortedPage();
      // שגיאה אינה "אין תוצאות". כאן נדחף בעבר עמוד ריק כדי למחוק ספרים
      // זמניים שכבר הוצגו — והמשתמש נשאר מול מדור ריק במקום מול הודעת
      // התקלה. הספרים שכבר נמצאו נשארים במקומם, והשגיאה עולה לקורא כדי
      // שיציג אותה לצידם; רק reset (שמקדים תוצאות מדורגות) מנקה רשימה.
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (!finished) {
        const closing = closeIterator();
        if (abandoned || signal?.aborted) {
          if (closing) void closing.catch(() => undefined);
        } else {
          await closing;
        }
      }
    }
  }

  async inBook(snapshot: SearchSnapshot, fileId: string, signal?: AbortSignal): Promise<InBookLocations> {
    const { options } = snapshot;
    const response = await this.fetch('/inbook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        fileName: fileId,
        q: snapshot.query,
        displayQuery: snapshot.query,
        proximity: options.proximity,
        fuzziness: options.fuzziness,
        hybur: options.hybur,
        roots: options.roots,
        gematria: options.gematria,
        spelling: options.spelling,
        numberGender: options.numberGender,
        aramaic: options.aramaic,
        rashetevot: options.rashetevot,
        requireWordOrder: options.requireWordOrder,
        rashiOcr: options.rashiOcr,
        compactCharClass: options.compactCharClass,
      }),
      timeoutMs: searchTimeoutMs,
    }, signal);
    ensureSuccessful(response, 'לא ניתן היה לאתר עמודים בספר');
    const body = parseJsonRecord(response.body, 'תוצאות בתוך הספר');
    /// תקלה שאירעה אחרי שהשרת כבר שלח 200 מדווחת בגוף בלבד — בלי הבדיקה הזו
    /// היא נקראת כ"הספר בלי מופעים" במקום כשגיאה.
    if (body.ok === false) {
      throw new Error(typeof body.error === 'string' && body.error !== '' ? body.error : 'לא ניתן היה לאתר עמודים בספר');
    }
    const pages = Array.isArray(body.pages)
      ? [...new Set(body.pages.filter((page): page is number => Number.isInteger(page) && Number(page) > 0))].sort((a, b) => a - b)
      : [];
    const matchedTerms = Array.isArray(body.matchedTerms)
      ? [...new Set(body.matchedTerms.filter((term): term is string => typeof term === 'string' && term.trim() !== '').map((term) => term.slice(0, 80)))].slice(0, 50)
      : [];
    return {
      hitCount: Number.isInteger(body.hitCount) ? Number(body.hitCount) : 0,
      pages,
      matchedTerms,
    };
  }

  /// הרצת פעולה שקוראת /pdf. הניסיון השני נקבע מול האסימון שהבקשה הזו באמת שלחה,
  /// ולא מול זה שהיה בזמן הריענון — אחרת רענון מקביל היה מבטל את הניסיון.
  async withPdfAccess<T>(fileId: string, run: (url: string) => Promise<T>): Promise<T> {
    const used = this.pdfToken;
    try {
      return await run(this.pdfUrl(fileId));
    } catch (error) {
      await this.refreshPdfToken();
      if (this.pdfToken === null || this.pdfToken === used) throw error;
      return run(this.pdfUrl(fileId));
    }
  }

  /// קורא /health מחדש. ריענון אחד משותף לכל הקוראים במקביל — אחרת גזיר אחד היה
  /// מתאושש והשאר נחסמים על תקרת הקצב.
  private refreshPdfToken(): Promise<void> {
    if (this.pdfToken === null) return Promise.resolve();
    const shared = this.pdfRefresh;
    if (shared) return shared;
    const now = Date.now();
    if (now - this.pdfRefreshAt < pdfRefreshCooldownMs) return Promise.resolve();
    this.pdfRefreshAt = now;
    const refresh = (async () => {
      try {
        // requestHealth ולא beginCapabilityProbe: הבדיקה המשותפת נעצרת כשחיפוש
        // שאין לו ממתינים מבוטל, וריענון של גזיר אינו אמור למות איתו.
        await withinGrace(this.requestHealth(), pdfRefreshGraceMs);
      } catch {
        // האסימון פשוט לא התחדש; הקורא ישווה ויזרוק את השגיאה המקורית.
      }
    })();
    this.pdfRefresh = refresh;
    return refresh.finally(() => {
      if (this.pdfRefresh === refresh) this.pdfRefresh = null;
    });
  }

  pdfUrl(fileId: string): string {
    if (!/^\d+$/.test(fileId) || Number(fileId) <= 0) throw new Error('מזהה הספר אינו תקין');
    const url = `${baseUrl}/pdf/${encodeURIComponent(fileId)}`;
    // שרת ישן אינו מנפיק אסימון ומתיר את התגובה בלעדיו; נוסיף רק כשקיים.
    return this.pdfToken === null ? url : `${url}?pdfToken=${encodeURIComponent(this.pdfToken)}`;
  }

  private async fetch(
    path: string,
    init: Omit<NetworkFetchParams, 'url'> = {},
    signal?: AbortSignal,
  ): Promise<NetworkResponse> {
    let response: Omit<NetworkResponse, 'body'> | null = null;
    let body = '';
    let expectedSequence = 0;
    const iterator = this.fetchStream(path, init)[Symbol.asyncIterator]();
    const stop = (): void => {
      void iterator.return?.()?.catch(() => undefined);
    };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const chunk = parseNetworkChunk(next.value, expectedSequence++);
        if (chunk.type === 'response') {
          if (response !== null) throw new Error('השרת החזיר כותרות תגובה כפולות');
          response = { status: chunk.status, ok: chunk.ok };
        } else {
          if (response === null) throw new Error('השרת החזיר גוף לפני כותרות התגובה');
          body = appendBody(body, chunk.body);
        }
      }
    } catch (error) {
      stop();
      throw error;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    if (signal?.aborted) throw new Error('בדיקת השירות בוטלה');
    if (response === null) throw new Error('השרת לא החזיר פרטי תגובה');
    return { ...response, body };
  }

  private fetchStream(
    path: string,
    init: Omit<NetworkFetchParams, 'url'> = {},
  ): AsyncIterable<NetworkFetchStreamChunk> {
    return this.bridge.call('network.fetchStream', { url: `${baseUrl}${path}`, ...init });
  }
}

/// מחזיר null כשחלף [ms]; ההבטחה עצמה ממשיכה לרוץ ברקע.
function withinGrace<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/// מחזיר null ברגע הביטול, בלי להמתין ל-[promise] שאולי לעולם לא ייענה.
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function pageFromResults(
  results: HebrewBooksResult[],
  offset: number,
  options: SearchSnapshot['options'],
): HebrewBooksSearchPage {
  return {
    results: results.slice(offset, offset + options.limit),
    totalBooks: results.length,
    totalHits: countHits(results),
    truncated: results.length >= options.max,
  };
}

function pageFromCache(
  cached: CachedSearch,
  offset: number,
  limit: number,
): HebrewBooksSearchPage {
  return {
    results: cached.results.slice(offset, offset + limit),
    totalBooks: cached.results.length,
    totalHits: cached.totalHits,
    truncated: cached.truncated,
  };
}

function emptySearchPage(): HebrewBooksSearchPage {
  return { results: [], totalBooks: 0, totalHits: 0, truncated: false };
}

function countHits(results: readonly HebrewBooksResult[]): number {
  return results.reduce((total, result) => total + result.hitCount, 0);
}

function parseNetworkChunk(value: unknown, expectedSequence: number): NetworkFetchStreamChunk {
  if (!isRecord(value) || value.sequence !== expectedSequence) {
    throw new Error('אוצריא החזירה מקטע רשת לא תקין');
  }
  if (
    value.type === 'response' &&
    Number.isInteger(value.status) &&
    typeof value.ok === 'boolean' &&
    isStringRecord(value.headers)
  ) {
    return {
      sequence: expectedSequence,
      type: 'response',
      status: Number(value.status),
      ok: value.ok,
      headers: value.headers,
    };
  }
  if (value.type === 'data' && typeof value.body === 'string') {
    return { sequence: expectedSequence, type: 'data', body: value.body };
  }
  throw new Error('אוצריא החזירה מקטע רשת לא תקין');
}

function appendBody(current: string, chunk: string): string {
  if (current.length + chunk.length > maximumResponseLength) {
    throw new Error('תשובת השרת גדולה מהמגבלה המותרת');
  }
  return current + chunk;
}

function ensureSuccessful(response: NetworkResponse, fallback: string): void {
  if (response.ok && response.status >= 200 && response.status < 300) return;
  // גוף שגיאה של hbsearch הוא {"error": "..."}; כל גוף אחר (HTML של פרוקסי,
  // טקסט חופשי, גוף ריק) נופל להודעה עם קוד ה-HTTP ולא לשגיאת הפירסור עצמה.
  let serverMessage: string | null = null;
  try {
    const parsed = JSON.parse(response.body) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim() !== '') serverMessage = parsed.error;
  } catch {
    serverMessage = null;
  }
  throw new Error(serverMessage ?? `${fallback} (HTTP ${response.status})`);
}

function parseJsonRecord(body: string, context: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // The single error below keeps protocol failures consistent.
  }
  throw new Error(`${context}: התקבלה תשובה לא תקינה`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}
