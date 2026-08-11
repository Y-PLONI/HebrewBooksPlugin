// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { appendHighlightedHtml, parseHighlightedHtml } from '../src/utils/highlighted-html';

describe('highlighted search snippets', () => {
  it('decodes entities, removes markup and preserves engine highlights', () => {
    const segments = parseHighlightedHtml(
      'הנך <b>יפה</b> &quot;רעיתי&quot; <font color=red>בדברי רצויים</font> <mark>מאוד</mark>',
    );

    expect(segments).toEqual([
      { text: 'הנך יפה "רעיתי" ', highlighted: false },
      { text: 'בדברי רצויים', highlighted: true },
      { text: ' ', highlighted: false },
      { text: 'מאוד', highlighted: true },
    ]);
  });

  it('renders only text and controlled highlight spans', () => {
    const target = document.createElement('p');
    appendHighlightedHtml(target, '<img src=x onerror=alert(1)>שלום <font color=red>עולם</font>');

    expect(target.textContent).toBe('שלום עולם');
    expect(target.querySelector('img')).toBeNull();
    expect(target.querySelector('.result-match')?.textContent).toBe('עולם');
  });
});
