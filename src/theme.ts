/// המרת ערכת הצבעים של אוצריא ל-CSS custom properties.
///
/// שמות המשתנים מקבילים אחד לאחד לתפקידי ה-ColorScheme של Material 3, כדי
/// שה-CSS יוכל לצטט את אותם תפקידים שהווידג'טים של אוצריא מצטטים (למשל
/// `colorScheme.outlineVariant` → `--color-outline-variant`). בנוסף נגזרים כאן
/// משטחי ה-AppSurfaces של אוצריא — רקע הקריאה, רקע הלוח ורקע הכרטיס — שאינם
/// חלק מה-ColorScheme אלא נגזרים ממנו לפי מצב בהיר/כהה.

const roles: ReadonlyArray<[keyof OtzariaColorScheme, string, keyof OtzariaColorScheme | null]> = [
  ['primary', '--color-primary', null],
  ['onPrimary', '--color-on-primary', null],
  ['primaryContainer', '--color-primary-container', 'surfaceContainerHighest'],
  ['onPrimaryContainer', '--color-on-primary-container', 'primary'],
  ['secondary', '--color-secondary', 'primary'],
  ['onSecondary', '--color-on-secondary', 'onPrimary'],
  ['secondaryContainer', '--color-secondary-container', 'surfaceContainerHighest'],
  ['onSecondaryContainer', '--color-on-secondary-container', 'onSurface'],
  ['tertiaryContainer', '--color-tertiary-container', 'surfaceContainerHighest'],
  ['onTertiaryContainer', '--color-on-tertiary-container', 'onSurface'],
  ['surface', '--color-surface', null],
  ['onSurface', '--color-on-surface', null],
  ['onSurfaceVariant', '--color-on-surface-variant', 'onSurface'],
  ['surfaceContainerLowest', '--color-surface-container-lowest', 'surface'],
  ['surfaceContainerLow', '--color-surface-container-low', 'surface'],
  ['surfaceContainer', '--color-surface-container', 'surfaceContainerHigh'],
  ['surfaceContainerHigh', '--color-surface-container-high', 'surfaceContainerHighest'],
  ['surfaceContainerHighest', '--color-surface-container-highest', null],
  ['error', '--color-error', null],
  ['onError', '--color-on-error', null],
  ['errorContainer', '--color-error-container', 'surfaceContainerHighest'],
  ['onErrorContainer', '--color-on-error-container', 'error'],
  ['outline', '--color-outline', null],
  ['outlineVariant', '--color-outline-variant', 'outline'],
  ['inverseSurface', '--color-inverse-surface', 'onSurface'],
  ['onInverseSurface', '--color-on-inverse-surface', 'surface'],
  ['shadow', '--color-shadow', null],
  ['scrim', '--color-scrim', null],
];

export function applyTheme(theme: OtzariaTheme): void {
  const root = document.documentElement;
  const colors = theme.colorScheme;

  for (const [role, variable, fallback] of roles) {
    const value = colors[role] ?? (fallback ? colors[fallback] : undefined);
    if (value) root.style.setProperty(variable, value);
  }

  // הגופן וגודלו של טקסט הספר — משמשים לתוכן (תוצאות, טקסט בספר) בלבד.
  // סרגלי הממשק נשארים ב-Roboto ובגדלים קבועים, כמו באוצריא.
  root.style.setProperty('--font-book', `'${theme.typography.fontFamily}', 'David', serif`);
  root.style.setProperty('--font-size-book', `${theme.typography.fontSize}px`);
  root.style.setProperty('--line-height-book', String(theme.typography.lineHeight));

  document.body.classList.toggle('dark-mode', theme.mode === 'dark');
}
