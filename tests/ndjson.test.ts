import { describe, expect, it } from 'vitest';
import { parseSearchNdjson, SearchNdjsonDecoder } from '../src/utils/ndjson';

describe('parseSearchNdjson', () => {
  it('parses valid rows and ignores blank lines', () => {
    const body = [
      JSON.stringify({ fileId: '42', bookName: 'ספר לדוגמה', sourceType: 'PDF', hitCount: 3, authorName: 'מחבר' }),
      '',
    ].join('\r\n');
    expect(parseSearchNdjson(body)).toEqual([
      expect.objectContaining({ fileId: '42', bookName: 'ספר לדוגמה', sourceType: 'PDF', hitCount: 3 }),
    ]);
  });

  it('rejects a malformed result instead of returning a partial list', () => {
    const body = [
      JSON.stringify({ fileId: '42', bookName: 'תקין', sourceType: 'PDF', hitCount: 1 }),
      JSON.stringify({ fileId: '43', sourceType: 'PDF', hitCount: 1 }),
    ].join('\n');
    expect(() => parseSearchNdjson(body)).toThrow('שורה 2 חסרה שדות חובה');
  });

  it('treats a server error row as an error', () => {
    expect(() => parseSearchNdjson('{"ok":false,"error":"כשל שרת"}')).toThrow('כשל שרת');
  });

  it('decodes rows incrementally across arbitrary chunk boundaries', () => {
    const decoder = new SearchNdjsonDecoder();
    const first = JSON.stringify({ fileId: '42', bookName: 'ספר ראשון', sourceType: 'PDF', hitCount: 3 });
    const second = JSON.stringify({ fileId: '43', bookName: 'ספר שני', sourceType: 'PDF', hitCount: 1 });

    expect(decoder.push(`${first.slice(0, 12)}`)).toEqual([]);
    expect(decoder.push(`${first.slice(12)}\n${second.slice(0, 7)}`)).toEqual([
      expect.objectContaining({ fileId: '42' }),
    ]);
    expect(decoder.push(second.slice(7))).toEqual([]);
    expect(decoder.finish()).toEqual([expect.objectContaining({ fileId: '43' })]);
  });

  it('enforces the response limit across multiple chunks', () => {
    const decoder = new SearchNdjsonDecoder();
    decoder.push('x'.repeat(3 * 1024 * 1024));
    expect(() => decoder.push('x'.repeat(2 * 1024 * 1024))).toThrow(
      'תשובת החיפוש גדולה מהמגבלה המותרת',
    );
  });
});
