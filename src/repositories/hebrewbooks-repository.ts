import type { HostBridge, NetworkFetchParams, NetworkFetchStreamChunk } from '../bridge';
import type {
  HealthStatus,
  HebrewBooksResult,
  HebrewBooksSearchPage,
  InBookLocations,
  SearchSnapshot,
} from '../models';
import { SearchNdjsonDecoder } from '../utils/ndjson';

interface NetworkResponse {
  status: number;
  ok: boolean;
  body: string;
}

const baseUrl = 'http://127.0.0.1:8080';
const searchTimeoutMs = 120_000;
const maximumResponseLength = 16 * 1024 * 1024;

type SearchUpdate = (page: HebrewBooksSearchPage) => boolean | void;

interface CachedSearch {
  fingerprint: string;
  results: HebrewBooksResult[];
  totalHits: number;
  truncated: boolean;
}

export class HebrewBooksRepository {
  private cachedSearch: CachedSearch | null = null;

  constructor(private readonly bridge: HostBridge) {}

  async health(): Promise<HealthStatus> {
    const response = await this.fetch('/health');
    const body = parseJsonRecord(response.body, 'בדיקת השירות');
    if (!response.ok || body.ok !== true || body.service !== 'hbsearch') {
      throw new Error('שירות החיפוש המקומי אינו זמין או אינו תואם');
    }

    const capabilities = Array.isArray(body.capabilities)
      ? body.capabilities.filter((item): item is string => typeof item === 'string')
      : [];
    const apiVersion = typeof body.apiVersion === 'number' ? body.apiVersion : null;
    if (apiVersion !== null && apiVersion >= 2 && !capabilities.includes('pdf-range')) {
      throw new Error('גרסת השירות אינה מצהירה על תמיכה בקובצי PDF');
    }

    return {
      kind: apiVersion !== null && apiVersion >= 2 && capabilities.includes('pdf-range')
        ? 'onlineFull'
        : 'onlineLegacy',
      serverVersion: typeof body.serverVersion === 'string' ? body.serverVersion : null,
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
    const stream = this.fetchStream('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        q: snapshot.query,
        ...snapshot.options,
        limit: snapshot.options.max,
      }),
      timeoutMs: searchTimeoutMs,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const decoder = new SearchNdjsonDecoder();
    const results: HebrewBooksResult[] = [];
    let response: Omit<NetworkResponse, 'body'> | null = null;
    let errorBody = '';
    let expectedSequence = 0;
    let finished = false;
    const cancel = (): void => {
      const cancellation = iterator.return?.();
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
        const batch = decoder.push(chunk.body);
        if (batch.length === 0) continue;
        results.push(...batch);
        if (onUpdate?.(pageFromResults(results, offset, snapshot.options)) === false) {
          return pageFromResults(results, offset, snapshot.options);
        }
      }
      if (signal?.aborted) return pageFromResults(results, offset, snapshot.options);
      if (response === null) throw new Error('השרת לא החזיר פרטי תגובה');
      ensureSuccessful({ ...response, body: errorBody }, 'החיפוש נכשל');
      const tail = decoder.finish();
      if (tail.length > 0) {
        results.push(...tail);
        onUpdate?.(pageFromResults(results, offset, snapshot.options));
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
      if (signal?.aborted) return pageFromResults(results, offset, snapshot.options);
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (!finished) await iterator.return?.();
    }
  }

  async inBook(snapshot: SearchSnapshot, fileId: string): Promise<InBookLocations> {
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
    });
    ensureSuccessful(response, 'לא ניתן היה לאתר עמודים בספר');
    const body = parseJsonRecord(response.body, 'תוצאות בתוך הספר');
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

  pdfUrl(fileId: string): string {
    if (!/^\d+$/.test(fileId) || Number(fileId) <= 0) throw new Error('מזהה הספר אינו תקין');
    return `${baseUrl}/pdf/${encodeURIComponent(fileId)}`;
  }

  private async fetch(
    path: string,
    init: Omit<NetworkFetchParams, 'url'> = {},
  ): Promise<NetworkResponse> {
    let response: Omit<NetworkResponse, 'body'> | null = null;
    let body = '';
    let expectedSequence = 0;
    for await (const value of this.fetchStream(path, init)) {
      const chunk = parseNetworkChunk(value, expectedSequence++);
      if (chunk.type === 'response') {
        if (response !== null) throw new Error('השרת החזיר כותרות תגובה כפולות');
        response = { status: chunk.status, ok: chunk.ok };
      } else {
        if (response === null) throw new Error('השרת החזיר גוף לפני כותרות התגובה');
        body = appendBody(body, chunk.body);
      }
    }
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
  try {
    const error = JSON.parse(response.body) as { error?: unknown };
    if (typeof error.error === 'string') throw new Error(error.error);
  } catch (error) {
    if (error instanceof Error && error.message !== response.body) throw error;
  }
  throw new Error(`${fallback} (HTTP ${response.status})`);
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
