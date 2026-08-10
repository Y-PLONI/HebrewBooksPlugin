import type { HostBridge } from '../bridge';
import { requireHostData } from '../bridge';
import type { HealthStatus, HebrewBooksResult, InBookLocations, SearchSnapshot } from '../models';
import { parseSearchNdjson } from '../utils/ndjson';

interface NetworkResponse {
  status: number;
  ok: boolean;
  body: string;
}

const baseUrl = 'http://127.0.0.1:8080';

export class HebrewBooksRepository {
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

  async search(snapshot: SearchSnapshot): Promise<HebrewBooksResult[]> {
    const response = await this.fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ q: snapshot.query, ...snapshot.options }),
    });
    ensureSuccessful(response, 'החיפוש נכשל');
    return parseSearchNdjson(response.body);
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

  private fetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<NetworkResponse> {
    return requireHostData<NetworkResponse>(this.bridge, 'network.fetch', { url: `${baseUrl}${path}`, ...init });
  }
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
