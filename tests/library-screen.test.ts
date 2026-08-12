// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { formatHebrewBooksPathStatus, LibraryScreen } from '../src/screens/library-screen';

describe('formatHebrewBooksPathStatus', () => {
  it('formats status as defined when path is present', () => {
    expect(formatHebrewBooksPathStatus('/books/hebrewbooks')).toBe(
      'מיקום ספרי היברובוקס באוצריא: הוגדר (/books/hebrewbooks)',
    );
  });

  it('formats status as not defined when path is empty, whitespace, null, or undefined', () => {
    expect(formatHebrewBooksPathStatus(null)).toBe('מיקום ספרי היברובוקס באוצריא: לא הוגדר');
    expect(formatHebrewBooksPathStatus('')).toBe('מיקום ספרי היברובוקס באוצריא: לא הוגדר');
    expect(formatHebrewBooksPathStatus('   ')).toBe('מיקום ספרי היברובוקס באוצריא: לא הוגדר');
    expect(formatHebrewBooksPathStatus(undefined)).toBe('מיקום ספרי היברובוקס באוצריא: לא הוגדר');
  });
});

describe('LibraryScreen', () => {
  it('renders path status paragraph in showReady when path is not set', () => {
    const screen = new LibraryScreen({
      onSearch: vi.fn(),
      onRetry: vi.fn(),
    });

    screen.showReady('מחובר');

    const statusEl = screen.root.querySelector('.library-hebrewbooks-path-status');
    expect(statusEl?.textContent).toBe('מיקום ספרי היברובוקס באוצריא: לא הוגדר');
  });

  it('renders path status paragraph in showReady when path is set', () => {
    const screen = new LibraryScreen({
      onSearch: vi.fn(),
      onRetry: vi.fn(),
    });

    screen.showReady('מחובר', '/my/hebrewbooks/path');

    const statusEl = screen.root.querySelector('.library-hebrewbooks-path-status');
    expect(statusEl?.textContent).toBe('מיקום ספרי היברובוקס באוצריא: הוגדר (/my/hebrewbooks/path)');
  });

  it('renders path status in showOffline state', () => {
    const screen = new LibraryScreen({
      onSearch: vi.fn(),
      onRetry: vi.fn(),
    });

    screen.showOffline('שגיאת חיבור', '/my/hebrewbooks/path');

    const statusEl = screen.root.querySelector('.library-hebrewbooks-path-status');
    expect(statusEl?.textContent).toBe('מיקום ספרי היברובוקס באוצריא: הוגדר (/my/hebrewbooks/path)');
  });

  it('dynamically updates path status via setHebrewBooksPath', () => {
    const screen = new LibraryScreen({
      onSearch: vi.fn(),
      onRetry: vi.fn(),
    });

    screen.showReady('מחובר');
    expect(screen.root.querySelector('.library-hebrewbooks-path-status')?.textContent).toBe(
      'מיקום ספרי היברובוקס באוצריא: לא הוגדר',
    );

    screen.setHebrewBooksPath('/new/path');
    expect(screen.root.querySelector('.library-hebrewbooks-path-status')?.textContent).toBe(
      'מיקום ספרי היברובוקס באוצריא: הוגדר (/new/path)',
    );

    screen.setHebrewBooksPath('');
    expect(screen.root.querySelector('.library-hebrewbooks-path-status')?.textContent).toBe(
      'מיקום ספרי היברובוקס באוצריא: לא הוגדר',
    );
  });
});
