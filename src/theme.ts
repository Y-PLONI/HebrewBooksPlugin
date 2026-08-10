export function applyTheme(theme: OtzariaTheme): void {
  const root = document.documentElement;
  const colors = theme.colorScheme;
  const set = (name: string, value: string | undefined, fallback?: string): void => {
    if (value ?? fallback) root.style.setProperty(name, value ?? fallback ?? '');
  };

  set('--color-primary', colors.primary);
  set('--color-on-primary', colors.onPrimary);
  set('--color-primary-container', colors.primaryContainer, colors.surfaceContainerHighest);
  set('--color-on-primary-container', colors.onPrimaryContainer, colors.primary);
  set('--color-surface', colors.surface);
  set('--color-on-surface', colors.onSurface);
  set('--color-on-surface-variant', colors.onSurfaceVariant, colors.onSurface);
  set('--color-surface-low', colors.surfaceContainerLow, colors.surface);
  set('--color-surface-high', colors.surfaceContainerHigh, colors.surfaceContainerHighest);
  set('--color-surface-highest', colors.surfaceContainerHighest);
  set('--color-outline', colors.outline);
  set('--color-outline-variant', colors.outlineVariant, colors.outline);
  set('--color-error', colors.error);
  set('--color-error-container', colors.errorContainer, colors.surfaceContainerHighest);
  set('--color-on-error-container', colors.onErrorContainer, colors.error);
  set('--color-scrim', colors.scrim, '#000000');
  root.style.setProperty('--font-size-base', `${theme.typography.fontSize}px`);
  root.style.setProperty('--line-height', String(theme.typography.lineHeight));
  document.body.classList.toggle('dark-mode', theme.mode === 'dark');
}
