// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SnippetSource } from '../src/services/external-search-server';
import { appendScript, lazySnippetSource, snippetSourceGlobalKey } from '../src/services/lazy-snippet-source';

/// מחלץ מדומה, כפי ש-assets/snippets.js מציב אותו כשהוא נטען.
function installSource(text: string | null): SnippetSource {
  const source: SnippetSource = { load: () => Promise.resolve(text) };
  (globalThis as Record<string, unknown>)[snippetSourceGlobalKey] = source;
  return source;
}

function scriptsIn(): HTMLScriptElement[] {
  return [...document.head.querySelectorAll('script')];
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[snippetSourceGlobalKey];
  document.head.replaceChildren();
  vi.restoreAllMocks();
});

describe('appendScript', () => {
  it('מזריק תגית script קלאסית ומחכה לטעינתה', async () => {
    const loading = appendScript('assets/snippets.js');
    const [script] = scriptsIn();

    expect(script?.getAttribute('src')).toBe('assets/snippets.js');
    // type="module" אינו נטען מ-file://; רק תגית קלאסית תעבוד שם.
    expect(script?.getAttribute('type')).toBeNull();
    script?.dispatchEvent(new Event('load'));
    await expect(loading).resolves.toBeUndefined();
  });

  it('נכשל כשהדפדפן אינו מוצא את הקובץ', async () => {
    const loading = appendScript('assets/missing.js');
    scriptsIn()[0]?.dispatchEvent(new Event('error'));
    await expect(loading).rejects.toThrow('assets/missing.js');
  });
});

describe('lazySnippetSource', () => {
  it('אינו טוען דבר עד שנדרש גזיר ראשון', () => {
    const append = vi.fn<(src: string) => Promise<void>>().mockResolvedValue(undefined);
    lazySnippetSource('assets/snippets.js', append);
    expect(append).not.toHaveBeenCalled();
    expect(scriptsIn()).toHaveLength(0);
  });

  it('טוען את החבילה פעם אחת ומגיש דרכה את כל הגזירים', async () => {
    const append = vi.fn(async () => {
      installSource('קטע מהעמוד');
    });
    const lazy = lazySnippetSource('assets/snippets.js', append);

    const [first, second] = await Promise.all([
      lazy.load('http://127.0.0.1:8080/pdf/1', '1', 9, 'ברכת המזון'),
      lazy.load('http://127.0.0.1:8080/pdf/2', '2', 3, 'ברכת המזון'),
    ]);

    expect([first, second]).toEqual(['קטע מהעמוד', 'קטע מהעמוד']);
    expect(await lazy.prepare?.()).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith('assets/snippets.js');
  });

  it('מדלג על ההזרקה כשהחבילה כבר נטענה', async () => {
    const source = installSource('כבר כאן');
    const load = vi.spyOn(source, 'load');
    const append = vi.fn<(src: string) => Promise<void>>().mockResolvedValue(undefined);

    const lazy = lazySnippetSource('assets/snippets.js', append);

    expect(await lazy.prepare?.()).toBe(true);
    expect(await lazy.load('http://127.0.0.1:8080/pdf/1', '1', 9, 'שאילתה')).toBe('כבר כאן');
    expect(append).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('מדווח שאינו זמין כשהחבילה אינה נטענת, ואינו מנסה שוב', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const append = vi.fn<(src: string) => Promise<void>>().mockRejectedValue(new Error('טעינה נכשלה'));
    const lazy = lazySnippetSource('assets/snippets.js', append);

    expect(await lazy.prepare?.()).toBe(false);
    expect(await lazy.load('http://127.0.0.1:8080/pdf/1', '1', 9, 'שאילתה')).toBeNull();
    expect(append).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('מדווח שאינו זמין כשהחבילה נטענה בלי להציב מחלץ', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const append = vi.fn<(src: string) => Promise<void>>().mockResolvedValue(undefined);
    const lazy = lazySnippetSource('assets/snippets.js', append);

    expect(await lazy.prepare?.()).toBe(false);
    expect(await lazy.load('http://127.0.0.1:8080/pdf/1', '1', 9, 'שאילתה')).toBeNull();
  });
});
