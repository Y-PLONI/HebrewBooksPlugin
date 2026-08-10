import { icons, type IconName } from '../icons.generated';

/// בוני הרכיבים המשותפים — כל אחד מהם מקביל לווידג'ט של אוצריא, ומחזיר
/// אלמנט עם ה-class שמחזיק את המידות המדויקות (ראה styles.css).

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/// אייקון SVG במערכת של 24×24, מתוך אותן ספריות שאוצריא מציירת מהן.
export function iconElement(name: IconName, size: number, className = 'icon'): SVGSVGElement {
  const shape = icons[name];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', shape.path);
  if ('transform' in shape && shape.transform) path.setAttribute('transform', shape.transform);
  svg.append(path);
  return svg;
}

interface BarButtonOptions {
  tooltip: string;
  icon: IconName;
  onClick: () => void;
  selected?: boolean;
  mirrored?: boolean;
  tooltipBelow?: boolean;
}

/// BarButton.icon — כפתור אייקון בסרגל העליון (40×40, אייקון 20).
export function barButton(options: BarButtonOptions): HTMLButtonElement {
  const button = element('button', 'bar-button');
  button.type = 'button';
  button.dataset.tooltip = options.tooltip;
  button.setAttribute('aria-label', options.tooltip);
  if (options.tooltipBelow === false) button.dataset.tooltipBelow = 'false';
  if (options.selected !== undefined) button.setAttribute('aria-pressed', String(options.selected));
  button.append(iconElement(options.icon, 20, options.mirrored ? 'icon icon-mirrored' : 'icon'));
  button.addEventListener('click', options.onClick);
  return button;
}

export function setBarButtonIcon(button: HTMLButtonElement, name: IconName, mirrored = false): void {
  button.replaceChildren(iconElement(name, 20, mirrored ? 'icon icon-mirrored' : 'icon'));
}

interface ActionButtonOptions {
  text: string;
  variant: 'recommended' | 'neutral' | 'ghost';
  icon?: IconName;
  onClick: () => void;
  fullWidth?: boolean;
  centeredLabel?: boolean;
  tooltip?: string;
}

/// ActionButton — FilledButton / FilledButton.tonal / TextButton של M3.
export function actionButton(options: ActionButtonOptions): HTMLButtonElement {
  const classes = ['action-button', options.variant];
  if (options.icon) classes.push('has-icon');
  if (options.fullWidth) classes.push('full-width');
  if (options.centeredLabel) classes.push('centered-label');
  const button = element('button', classes.join(' '));
  button.type = 'button';
  if (options.tooltip) button.dataset.tooltip = options.tooltip;
  if (options.icon) button.append(iconElement(options.icon, 18));
  button.append(document.createTextNode(options.text));
  button.addEventListener('click', options.onClick);
  return button;
}

/// IconButton קומפקטי (28×28, אייקון 16) — כמו כפתור ההעתקה בכרטיס תוצאה.
export function compactIconButton(
  name: IconName,
  tooltip: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = element('button', 'compact-icon-button');
  button.type = 'button';
  button.dataset.tooltip = tooltip;
  button.setAttribute('aria-label', tooltip);
  button.append(iconElement(name, 16));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

interface InformativeStateOptions {
  icon: IconName;
  iconSize?: number;
  title: string;
  message: string;
  action?: { text: string; icon?: IconName; onClick: () => void };
}

/// מצב מידע מרוכז — הדפוס של _buildInformativeEmptyState באוצריא.
export function informativeState(options: InformativeStateOptions): HTMLElement {
  const state = element('div', 'informative-state');
  state.append(iconElement(options.icon, options.iconSize ?? 56, 'icon state-icon'));
  state.append(element('h3', undefined, options.title));
  state.append(element('p', undefined, options.message));
  if (options.action) {
    state.append(
      actionButton({
        text: options.action.text,
        variant: 'neutral',
        icon: options.action.icon,
        onClick: options.action.onClick,
      }),
    );
  }
  return state;
}

export function centeredProgress(): HTMLElement {
  const wrap = element('div', 'centered-progress');
  wrap.append(element('div', 'progress-indicator'));
  return wrap;
}

/// AppTopBar — leading | center | trailing, בגובה 56 (44 במסך צר).
export function topBar(): {
  root: HTMLElement;
  leading: HTMLElement;
  center: HTMLElement;
  trailing: HTMLElement;
} {
  const root = element('header', 'top-bar');
  const leading = element('div', 'top-bar-leading');
  const center = element('div', 'top-bar-center');
  const trailing = element('div', 'top-bar-trailing');
  root.append(leading, center, trailing);
  return { root, leading, center, trailing };
}

export function topBarDivider(): HTMLElement {
  return element('div', 'top-bar-divider');
}

/// AppDropdownField — בורר ברוחב 183 עם תווית צפה, כמו בורר המיון של אוצריא.
export function dropdownField<T extends string>(
  label: string,
  entries: ReadonlyArray<{ value: T; label: string }>,
  value: T,
  onChange: (value: T) => void,
): HTMLElement {
  const wrap = element('div', 'dropdown-field');
  const select = element('select');
  select.setAttribute('aria-label', label);
  for (const entry of entries) {
    const option = element('option', undefined, entry.label);
    option.value = entry.value;
    if (entry.value === value) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value as T));
  wrap.append(select, element('span', 'field-label', label), iconElement('chevron_down_12_regular', 12, 'icon chevron'));
  return wrap;
}
