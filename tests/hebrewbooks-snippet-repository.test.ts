import { describe, expect, it } from 'vitest';
import { extractTextSnippet } from '../src/repositories/hebrewbooks-snippet-repository';

describe('extractTextSnippet', () => {
  it('extracts a bounded context around the full query from a PDF text layer', () => {
    const text = `${'פתיחה '.repeat(30)}חכמה בינה דעת${' המשך'.repeat(60)}`;

    const snippet = extractTextSnippet(text, 'חכמה בינה');

    expect(snippet).toContain('חכמה בינה דעת');
    expect(snippet?.startsWith('…')).toBe(true);
    expect(snippet?.endsWith('…')).toBe(true);
    expect(snippet?.length).toBeLessThanOrEqual(262);
  });

  it('falls back to the first query word and normalizes PDF whitespace', () => {
    const snippet = extractTextSnippet('לפני\n\tחכמה   ואחריה', 'חכמה שאינה קיימת');

    expect(snippet).toBe('לפני חכמה ואחריה');
  });

  it('returns null for a page without a text layer', () => {
    expect(extractTextSnippet(' \n ', 'בדיקה')).toBeNull();
  });
});
