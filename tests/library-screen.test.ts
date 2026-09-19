// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { formatHebrewBooksPathStatus, LibraryScreen } from '../src/screens/library-screen';

describe('formatHebrewBooksPathStatus', () => {
  it('formats status when the host told us the path', () => {
    expect(formatHebrewBooksPathStatus('/books/hebrewbooks')).toBe(
      'מיקום ספרי היברובוקס באוצריא: /books/hebrewbooks',
    );
  });

  it('returns null when the path is unknown — the plugin may no longer read it', () => {
    expect(formatHebrewBooksPathStatus(null)).toBeNull();
    expect(formatHebrewBooksPathStatus('')).toBeNull();
    expect(formatHebrewBooksPathStatus('   ')).toBeNull();
    expect(formatHebrewBooksPathStatus(undefined)).toBeNull();
  });
});

describe('LibraryScreen', () => {
  it('hides the path paragraph in showReady while the path is unknown', () => {
    const screen = new LibraryScreen({
      onSearch: vi.fn(),
      onRetry: vi.fn(),
    });

    screen.showReady('מחובר');

    const statusEl = screen.root.querySelector('.library-hebrewbooks-path-status');
    expect(statusEl?.textContent).toBe('');
    expect(statusEl?.classList.contains('hidden')).toBe(true);
  });

  it('renders path status paragraph in showReady when path is set', () => {
    const screen = new LibraryScreen({
      onSearch: vi.fn(),
      onRetry: vi.fn(),
    });

    screen.showReady('מחובר', '/my/hebrewbooks/path');

    const statusEl = screen.root.querySelector('.library-hebrewbooks-path-status');
    expect(statusEl?.textContent).toBe('מיקום ספרי היברובוקס באוצריא: /my/hebrewbooks/path');
    expect(statusEl?.classList.contains('hidden')).toBe(false);
  });

  it('explains how to change the separate Otzaria books path and search-service data root when ready', () => {
    const screen = new LibraryScreen({
      onSearch: vi.fn(),
      onRetry: vi.fn(),
    });

    screen.showReady('מחובר', '/my/hebrewbooks/path');

    const guidance = screen.root.querySelector('.library-path-guidance');
    expect(guidance?.textContent).toContain(
      'הגדרות > ספרייה > מיקום ספרי היברובוקס',
    );
    expect(guidance?.textContent).toContain('קובצי ה־PDF');
    expect(guidance?.textContent).toContain('מתקין HebrewBooks לאוצריא');
    expect(guidance?.textContent).toContain('App\\Katalog.db');
    expect(guidance?.textContent).toContain('התקנה מחדש של התוסף בלבד אינה משנה');
  });

  it('renders path status in showOffline state', () => {
    const screen = new LibraryScreen({
      onSearch: vi.fn(),
      onRetry: vi.fn(),
    });

    screen.showOffline('שגיאת חיבור', '/my/hebrewbooks/path');

    const statusEl = screen.root.querySelector('.library-hebrewbooks-path-status');
    expect(statusEl?.textContent).toBe('מיקום ספרי היברובוקס באוצריא: /my/hebrewbooks/path');
  });

  it('keeps search-service data-root recovery instructions visible while offline', () => {
    const screen = new LibraryScreen({
      onSearch: vi.fn(),
      onRetry: vi.fn(),
    });

    screen.showOffline('לא נמצא הקטלוג', '/my/hebrewbooks/path');

    const guidance = screen.root.querySelector('.library-path-guidance');
    expect(guidance?.textContent).toContain('מתקין HebrewBooks לאוצריא');
    expect(guidance?.textContent).toContain('App\\Katalog.db');
    expect(guidance?.textContent).toContain(
      'הגדרות > ספרייה > מיקום ספרי היברובוקס',
    );
  });

  it('dynamically updates path status via setHebrewBooksPath', () => {
    const screen = new LibraryScreen({
      onSearch: vi.fn(),
      onRetry: vi.fn(),
    });

    screen.showReady('מחובר');
    expect(screen.root.querySelector('.library-hebrewbooks-path-status')?.textContent).toBe('');

    screen.setHebrewBooksPath('/new/path');
    expect(screen.root.querySelector('.library-hebrewbooks-path-status')?.textContent).toBe(
      'מיקום ספרי היברובוקס באוצריא: /new/path',
    );

    // הסרת הנתיב באוצריא שולחת newValue ריק — השורה נעלמת ולא טוענת "לא הוגדר".
    screen.setHebrewBooksPath('');
    const cleared = screen.root.querySelector('.library-hebrewbooks-path-status');
    expect(cleared?.textContent).toBe('');
    expect(cleared?.classList.contains('hidden')).toBe(true);
  });
});
