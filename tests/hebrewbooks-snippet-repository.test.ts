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

  it('does not present unrelated PDF text as a search preview', () => {
    expect(extractTextSnippet('פתיחה ארוכה על נושא אחר לגמרי', 'ברכת המזון')).toBeNull();
    expect(extractTextSnippet('פתיחה ארוכה על נושא אחר לגמרי', '"..."')).toBeNull();
    expect(extractTextSnippet('לפני ... אחרי', '...')).toBeNull();
  });

  it('still finds a later query term when the full phrase and first term are absent', () => {
    const text = `${'הקדמה '.repeat(25)}כאן נזכרת המזון בלבד${' המשך'.repeat(25)}`;
    const snippet = extractTextSnippet(text, 'ברכת המזון');
    expect(snippet).toContain('המזון בלבד');
    expect(snippet?.startsWith('…')).toBe(true);
  });

  it('matches the visible text without regard to letter case', () => {
    expect(extractTextSnippet('Before Wisdom after', 'WISDOM')).toBe('Before Wisdom after');
  });

  it.each(['-', '־'])('finds hyphenated query words separated by PDF spaces (%s)', (separator) => {
    const text = 'לפני ברכת המזון אחרי';
    expect(extractTextSnippet(text, `ברכת${separator}המזון בזימון`)).toBe(text);
  });

  it('does not confuse Hebrew niqqud with a word separator', () => {
    const text = 'לפני בְּרָכָה אחרי';
    expect(extractTextSnippet(text, 'בְּרָכָה אחרת')).toBe(text);
  });
});
