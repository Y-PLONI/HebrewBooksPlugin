import type { IconName } from '../icons.generated';
import { element, iconElement } from './widgets';

/// שיקוף של עץ הניווט של אוצריא — NavTreeTile‏, NavTreeHeader ו-NavTreeGroupCard
/// (lib/widgets/lists/nav_tree_tile.dart), יחד עם שדה החיפוש הצר
/// (OtzariaSearchField עם slim: true) שיושב מעליו במסך תוצאות החיפוש.

interface NavTreeHeaderOptions {
  title: string;
  count?: number | null;
  selected: boolean;
  onSelect: () => void;
  /// כשאינו undefined — הכותרת היא הסינון הפעיל ומוצג כפתור "נקה סינון".
  onClearFilter?: () => void;
}

/// NavTreeHeader — כותרת השורש על רקע החלונית, ללא כרטיס וללא קופסת אייקון.
export function navTreeHeader(options: NavTreeHeaderOptions): HTMLElement {
  const header = element('div', 'nav-tree-header');
  header.append(element('span', 'nav-tree-header-title', options.title));
  if (options.onClearFilter) {
    header.append(clearFilterButton(options.onClearFilter));
    header.classList.add('interactive');
    header.setAttribute('role', 'button');
    header.tabIndex = 0;
    activateOn(header, options.onSelect);
  } else if (options.count) {
    header.append(element('span', 'nav-tree-count', `(${options.count})`));
  }
  header.setAttribute('aria-pressed', String(options.selected));
  return header;
}

interface NavTreeRowOptions {
  title: string;
  subtitle?: string | null;
  /// רמת ההזחה (0 = תיקייה עליונה).
  level: number;
  selected: boolean;
  count?: number | null;
  onSelect: () => void;
  /// שורת קטגוריה — קופסת תיקייה פתוחה/סגורה וחץ הרחבה.
  expandable?: { expanded: boolean; onToggle: () => void };
  /// שורת ספר — אייקון הפריט בקופסת האייקון.
  icon?: IconName;
  onClearFilter?: () => void;
}

/// NavTreeTile — שורת ניווט: קופסת אייקון 26×26 על secondaryContainer, כותרת,
/// מונה בסוגריים וחץ הרחבה.
export function navTreeRow(options: NavTreeRowOptions): HTMLElement {
  const row = element('div', options.expandable ? 'nav-tree-row category' : 'nav-tree-row book');
  row.style.setProperty('--nav-level', String(options.level));
  if (options.level === 0) row.classList.add('top-level');
  if (options.selected) row.classList.add('selected');
  row.setAttribute('role', 'button');
  row.setAttribute('aria-pressed', String(options.selected));
  row.tabIndex = 0;
  activateOn(row, options.onSelect);

  const iconName: IconName = options.expandable
    ? options.expandable.expanded
      ? 'folder_open_24_regular'
      : 'folder_24_regular'
    : options.icon ?? 'document_text_24_regular';
  const box = element('span', 'nav-tree-icon-box');
  box.append(iconElement(iconName, 14));
  row.append(box);

  const text = element('span', 'nav-tree-text');
  text.append(element('span', 'nav-tree-title', options.title));
  if (options.subtitle) text.append(element('span', 'nav-tree-subtitle', options.subtitle));
  row.append(text);

  if (options.onClearFilter) {
    row.append(clearFilterButton(options.onClearFilter));
  } else if (options.count) {
    row.append(element('span', 'nav-tree-count', `(${options.count})`));
  }

  if (options.expandable) {
    const toggle = element('button', 'nav-tree-chevron');
    toggle.type = 'button';
    const expanded = options.expandable.expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? 'כווץ קטגוריה' : 'הרחב קטגוריה');
    if (expanded) toggle.classList.add('expanded');
    toggle.append(iconElement('chevron_down_24_regular', 18));
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      options.expandable?.onToggle();
    });
    row.append(toggle);
  }

  return row;
}

/// NavTreeGroupCard — עוטף שורות רצופות בכרטיס אחד: פינות מעוגלות בקצוות
/// ומפריד בין השורות.
export function navTreeGroup(rows: HTMLElement[]): HTMLElement {
  const group = element('div', 'nav-tree-group');
  group.append(...rows);
  return group;
}

interface SlimSearchFieldOptions {
  hint: string;
  value: string;
  onInput: (value: string) => void;
  onClear: () => void;
  trailing?: HTMLElement[];
}

/// OtzariaSearchField עם slim: true — גובה 36, גופן 13, רקע onSurface ב-7%.
export function slimSearchField(options: SlimSearchFieldOptions): {
  root: HTMLElement;
  input: HTMLInputElement;
} {
  const root = element('div', 'slim-search-field');
  root.append(iconElement('search_24_regular', 18, 'icon field-icon'));

  const input = element('input');
  input.type = 'search';
  input.value = options.value;
  input.placeholder = options.hint;
  input.setAttribute('aria-label', options.hint);
  input.addEventListener('input', () => options.onInput(input.value));
  root.append(input);

  const actions = element('div', 'slim-search-actions');
  for (const action of options.trailing ?? []) actions.append(action);

  // כפתור הניקוי קיים תמיד ב-DOM ומוסתר כשהשדה ריק — כך הקלדה אינה בונה
  // מחדש את השדה ואינה מאבדת את המיקוד.
  const clear = element('button', 'slim-search-clear');
  clear.type = 'button';
  clear.setAttribute('aria-label', 'נקה');
  clear.append(iconElement('dismiss_24_regular', 15));
  clear.addEventListener('click', () => {
    input.value = '';
    updateClearVisibility();
    options.onClear();
  });
  actions.append(clear);
  root.append(actions);

  function updateClearVisibility(): void {
    clear.classList.toggle('hidden', input.value.length === 0);
  }
  input.addEventListener('input', updateClearVisibility);
  updateClearVisibility();

  return { root, input };
}

/// _ClearFilterButton — מסמן שהשורה היא הסינון הפעיל; לחיצה מנקה אותו.
function clearFilterButton(onClick: () => void): HTMLButtonElement {
  const button = element('button', 'clear-filter-button');
  button.type = 'button';
  button.append(iconElement('dismiss_24_regular', 14), document.createTextNode('נקה סינון'));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function activateOn(node: HTMLElement, action: () => void): void {
  node.addEventListener('click', action);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  });
}
