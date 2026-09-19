import type { HebrewBooksResult, SourceType } from '../models';

const maximumResponseLength = 16 * 1024 * 1024;
const validSourceTypes = new Set<SourceType>(['PDF', 'Text', 'Personal']);

export function parseSearchNdjson(body: string): HebrewBooksResult[] {
  const decoder = new SearchNdjsonDecoder();
  return [...decoder.push(body), ...decoder.finish()];
}

export class SearchNdjsonDecoder {
  private pending = '';
  private responseLength = 0;
  private resultLine = 0;

  push(chunk: string): HebrewBooksResult[] {
    this.responseLength += chunk.length;
    if (this.responseLength > maximumResponseLength) {
      throw new Error('תשובת החיפוש גדולה מהמגבלה המותרת');
    }

    const lines = `${this.pending}${chunk}`.split('\n');
    this.pending = lines.pop() ?? '';
    return this.parseLines(lines);
  }

  finish(): HebrewBooksResult[] {
    const tail = this.pending;
    this.pending = '';
    return this.parseLines(tail === '' ? [] : [tail]);
  }

  private parseLines(lines: string[]): HebrewBooksResult[] {
    return lines.filter((line) => line.trim() !== '').map((line) => {
      const lineNumber = ++this.resultLine;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`שורה ${lineNumber} בתשובת החיפוש אינה JSON תקין`);
      }
      return parseResult(value, lineNumber);
    });
  }
}

export type SearchStreamV2Event =
  | { type: 'start'; streamId: string | null }
  | { type: 'heartbeat' }
  | { type: 'provisional' | 'result'; result: HebrewBooksResult }
  | { type: 'reset' | 'complete' }
  | { type: 'warning'; code: string; message: string; indexes: string[] }
  | { type: 'error'; message: string };

/// הפרוטוקול מכיל שתי תקופות: תוצאות זמניות לפני reset, ותמונת דירוג סופית אחריו.
/// כל שורה מאומתת לפני שהמאגר מציג אותה; EOF ללא complete אינו תוצאה סופית.
export class SearchStreamV2Decoder {
  private pending = '';
  private responseLength = 0;
  private lineNumber = 0;
  private phase: 'beforeStart' | 'provisional' | 'ranked' | 'complete' | 'error' = 'beforeStart';
  private expectedCount = 0;
  private nextRank = 0;

  push(chunk: string, onEvent?: (event: SearchStreamV2Event) => boolean): SearchStreamV2Event[] {
    this.responseLength += chunk.length;
    if (this.responseLength > maximumResponseLength) {
      throw new Error('תשובת החיפוש גדולה מהמגבלה המותרת');
    }
    const lines = `${this.pending}${chunk}`.split('\n');
    this.pending = lines.pop() ?? '';
    return this.parseLines(lines, onEvent);
  }

  finish(onEvent?: (event: SearchStreamV2Event) => boolean): SearchStreamV2Event[] {
    const tail = this.pending;
    this.pending = '';
    let stopped = false;
    const events = this.parseLines(tail === '' ? [] : [tail], (event) => {
      if (onEvent?.(event) === false) {
        stopped = true;
        return false;
      }
      return true;
    });
    if (!stopped && this.phase !== 'complete' && this.phase !== 'error') {
      throw new Error('זרם החיפוש הסתיים ללא אישור תוצאות סופיות');
    }
    return events;
  }

  private parseLines(lines: string[], onEvent?: (event: SearchStreamV2Event) => boolean): SearchStreamV2Event[] {
    const events: SearchStreamV2Event[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      const lineNumber = ++this.lineNumber;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`שורה ${lineNumber} בתשובת החיפוש אינה JSON תקין`);
      }
      if (!isRecord(value) || typeof value.type !== 'string') this.invalid(lineNumber);
      if (this.phase === 'complete' || this.phase === 'error') this.invalid(lineNumber);
      let event: SearchStreamV2Event;
      switch (value.type) {
        case 'start':
          if (this.phase !== 'beforeStart' || value.streamVersion !== 2) this.invalid(lineNumber);
          // The token is opaque: the client only echoes it back to /search/cancel,
          // so the check exists to reject anything unsafe to echo, not to pin a
          // spelling. The service hands it over in upper-case hex.
          if (value.streamId !== undefined && (typeof value.streamId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value.streamId))) {
            this.invalid(lineNumber);
          }
          this.phase = 'provisional';
          event = { type: 'start', streamId: typeof value.streamId === 'string' ? value.streamId : null };
          break;
        case 'heartbeat':
          if (this.phase !== 'provisional' && this.phase !== 'ranked') this.invalid(lineNumber);
          event = { type: 'heartbeat' };
          break;
        case 'provisional':
          if (this.phase !== 'provisional') this.invalid(lineNumber);
          event = { type: 'provisional', result: parseResult(value.result, lineNumber) };
          break;
        case 'reset':
          if (this.phase !== 'provisional' || !isNonnegativeInteger(value.count)) this.invalid(lineNumber);
          this.expectedCount = value.count;
          this.nextRank = 0;
          this.phase = 'ranked';
          event = { type: 'reset' };
          break;
        case 'result':
          if (this.phase !== 'ranked' || value.rank !== this.nextRank || this.nextRank >= this.expectedCount) this.invalid(lineNumber);
          this.nextRank += 1;
          event = { type: 'result', result: parseResult(value.result, lineNumber) };
          break;
        case 'complete':
          if (this.phase !== 'ranked' || value.count !== this.expectedCount || this.nextRank !== this.expectedCount) this.invalid(lineNumber);
          this.phase = 'complete';
          event = { type: 'complete' };
          break;
        case 'error':
          if (this.phase === 'beforeStart' || typeof value.message !== 'string' || value.message.trim() === '') this.invalid(lineNumber);
          this.phase = 'error';
          event = { type: 'error', message: value.message };
          break;
        // אזהרה אינה סוף הזרם אלא דיווח על אינדקס שנכשל מאחורי תוצאות
        // שכן הגיעו; לכן היא אינה נוגעת ב-phase, ו-reset/result/complete באים אחריה.
        case 'warning':
          if (
            this.phase === 'beforeStart'
            || !isNonemptyString(value.code)
            || !isNonemptyString(value.message)
            || !isStringArray(value.indexes)
          ) this.invalid(lineNumber);
          event = {
            type: 'warning',
            code: value.code,
            message: value.message,
            indexes: [...value.indexes],
          };
          break;
        default:
          // סוג אירוע לא מוכר הוא תוספת לפרוטוקול v2, לא הפרה שלו: שינוי
          // שחייבים להבין מקבל streamVersion חדש, שהתוסף ממילא דוחה.
          continue;
      }
      events.push(event);
      if (onEvent?.(event) === false) break;
    }
    return events;
  }

  private invalid(lineNumber: number): never {
    throw new Error(`שורה ${lineNumber} מפרה את פרוטוקול זרם החיפוש v2`);
  }
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseResult(value: unknown, lineNumber: number): HebrewBooksResult {
  if (!isRecord(value)) throw new Error(`שורה ${lineNumber} אינה תוצאת חיפוש תקינה`);
  if (value.ok === false) throw new Error(typeof value.error === 'string' ? value.error : 'שרת החיפוש החזיר שגיאה');

  const sourceType = value.sourceType;
  if (
    typeof value.fileId !== 'string' || value.fileId.trim() === '' ||
    typeof value.bookName !== 'string' || value.bookName.trim() === '' ||
    typeof sourceType !== 'string' || !validSourceTypes.has(sourceType as SourceType) ||
    !Number.isInteger(value.hitCount) || Number(value.hitCount) < 0
  ) {
    throw new Error(`שורה ${lineNumber} חסרה שדות חובה`);
  }

  return {
    fileId: value.fileId,
    bookName: value.bookName,
    authorName: optionalString(value.authorName),
    printPlace: optionalString(value.printPlace),
    printYear: optionalString(value.printYear),
    countPage: optionalInteger(value.countPage),
    categories: optionalString(value.categories),
    sourceType: sourceType as SourceType,
    relativePath: optionalString(value.relativePath),
    hitCount: Number(value.hitCount),
    firstHitPage: optionalPositiveInteger(value.firstHitPage),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function optionalInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function optionalPositiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}
