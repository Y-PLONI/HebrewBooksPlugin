import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';

// דפי התוסף נטענים מ-file://, שם WebView2 חוסם גם יצירת Worker וגם את
// ה-import הדינמי שה-fake worker מנסה — כל getDocument היה נכשל. הצבת
// המודול (המצורף ל-bundle) ב-globalThis גורמת ל-pdf.js להשתמש בו ישירות
// על ה-main thread בלי שום טעינה דינמית.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

const rangeChunkSize = 256 * 1024;
const maximumCacheEntries = 300;
const snippetLength = 260;

interface SnippetRequest {
  readonly key: string;
  readonly url: string;
  readonly pageNumber: number;
  readonly query: string;
  readonly resolve: (value: string | null) => void;
}

export class HebrewBooksSnippetRepository {
  private readonly cache = new Map<string, string | null>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly queue: SnippetRequest[] = [];
  private active = 0;

  constructor(private readonly concurrency = 2) {}

  load(url: string, fileId: string, pageNumber: number | null, query: string): Promise<string | null> {
    if (pageNumber === null || pageNumber < 1) return Promise.resolve(null);
    const key = `${fileId}\u0000${pageNumber}\u0000${query}`;
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key) ?? null);
    const existing = this.pending.get(key);
    if (existing) return existing;

    const request = new Promise<string | null>((resolve) => {
      this.queue.push({ key, url, pageNumber, query, resolve });
      this.drain();
    });
    this.pending.set(key, request);
    return request;
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const request = this.queue.shift();
      if (!request) return;
      this.active += 1;
      void this.extract(request)
        .then((snippet) => {
          if (this.cache.size >= maximumCacheEntries) {
            this.cache.delete(this.cache.keys().next().value as string);
          }
          this.cache.set(request.key, snippet);
          request.resolve(snippet);
        })
        .catch((error: unknown) => {
          // כשל חילוץ (רשת/PDF פגום) שקוף למשתמש — קטע פשוט לא מוצג; הרישום
          // כאן הוא העדות היחידה, כי המבטיח של load מיושב עם null.
          console.warn(
            `snippet extract failed (page ${request.pageNumber}): ${error instanceof Error ? error.message : String(error)}`,
          );
          request.resolve(null);
        })
        .finally(() => {
          this.pending.delete(request.key);
          this.active -= 1;
          this.drain();
        });
    }
  }

  private async extract(request: SnippetRequest): Promise<string | null> {
    const loading = getDocument({
      url: request.url,
      disableRange: false,
      disableStream: true,
      disableAutoFetch: true,
      rangeChunkSize,
    });
    const document = await loading.promise;
    try {
      if (request.pageNumber > document.numPages) return null;
      const page = await document.getPage(request.pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ');
      return extractTextSnippet(text, request.query);
    } finally {
      await document.destroy();
    }
  }
}

export function extractTextSnippet(text: string, query: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;
  const searchable = normalized.toLocaleLowerCase('he');
  // A query can use a regular hyphen or Hebrew maqaf where extracted PDF text
  // has spaces. Keep combining marks with their base letter for pointed text.
  const terms = query.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  const phrases = [
    ...(terms.length > 0 ? [query.replace(/\s+/g, ' ').trim()] : []),
    ...terms.filter((term) => term.length > 1),
  ].filter(Boolean);
  const match = phrases
    .map((phrase) => searchable.indexOf(phrase.toLocaleLowerCase('he')))
    .find((index) => index >= 0);
  // PDF text may exist without containing the indexed term (OCR differences,
  // inflection, or a different page). Its opening words are not a search hit.
  if (match === undefined) return null;
  const start = Math.max(0, match - 90);
  const end = Math.min(normalized.length, start + snippetLength);
  const body = normalized.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${body}${end < normalized.length ? '…' : ''}`;
}
