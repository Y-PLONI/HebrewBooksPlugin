import { describe, expect, it } from 'vitest';
import { parseSearchNdjson } from '../src/utils/ndjson';

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
});
