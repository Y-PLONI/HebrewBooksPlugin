import type { HebrewBooksResult, SourceType } from '../models';

const maximumResponseLength = 4 * 1024 * 1024;
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
