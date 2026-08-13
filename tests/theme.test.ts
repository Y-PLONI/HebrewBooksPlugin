// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme } from '../src/theme';

function variable(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

function theme(overrides: Partial<OtzariaTheme> = {}): OtzariaTheme {
  return {
    mode: 'light',
    colorScheme: {},
    typography: { fontFamily: 'Frank Ruhl Libre', fontSize: 18, lineHeight: 1.8 },
    ...overrides,
  };
}

describe('applyTheme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.body.className = '';
  });

  it('ממפה תפקידי ColorScheme ל-CSS custom properties באותם שמות', () => {
    applyTheme(
      theme({
        colorScheme: {
          primary: '#112233',
          onPrimary: '#ffffff',
          surface: '#fefefe',
          onSurface: '#000000',
          outline: '#888888',
        },
      }),
    );
    expect(variable('--color-primary')).toBe('#112233');
    expect(variable('--color-on-primary')).toBe('#ffffff');
    expect(variable('--color-surface')).toBe('#fefefe');
    expect(variable('--color-on-surface')).toBe('#000000');
    expect(variable('--color-outline')).toBe('#888888');
  });

  it('תפקיד חסר נגזר מתפקיד הגיבוי שהוגדר לו', () => {
    applyTheme(
      theme({
        colorScheme: {
          primary: '#101010',
          onSurface: '#202020',
          surface: '#303030',
          outline: '#404040',
          surfaceContainerHighest: '#505050',
          error: '#606060',
        },
      }),
    );
    // primaryContainer → surfaceContainerHighest, onPrimaryContainer → primary
    expect(variable('--color-primary-container')).toBe('#505050');
    expect(variable('--color-on-primary-container')).toBe('#101010');
    // outlineVariant → outline, onSurfaceVariant → onSurface
    expect(variable('--color-outline-variant')).toBe('#404040');
    expect(variable('--color-on-surface-variant')).toBe('#202020');
    // inverseSurface → onSurface, onInverseSurface → surface
    expect(variable('--color-inverse-surface')).toBe('#202020');
    expect(variable('--color-on-inverse-surface')).toBe('#303030');
    // onErrorContainer → error
    expect(variable('--color-on-error-container')).toBe('#606060');
  });

  it('תפקיד שאין לו ערך ואין לו גיבוי אינו נכתב כלל', () => {
    applyTheme(theme({ colorScheme: { primary: '#111111' } }));
    expect(variable('--color-surface')).toBe('');
    expect(variable('--color-shadow')).toBe('');
  });

  it('מגדיר את גופן הספר וגודלו מהטיפוגרפיה של אוצריא', () => {
    applyTheme(theme());
    expect(variable('--font-book')).toBe("'Frank Ruhl Libre', 'David', serif");
    expect(variable('--font-size-book')).toBe('18px');
    expect(variable('--line-height-book')).toBe('1.8');
  });

  it('מצב כהה מסומן על ה-body ומתבטל בחזרה למצב בהיר', () => {
    applyTheme(theme({ mode: 'dark' }));
    expect(document.body.classList.contains('dark-mode')).toBe(true);
    applyTheme(theme({ mode: 'light' }));
    expect(document.body.classList.contains('dark-mode')).toBe(false);
  });
});
