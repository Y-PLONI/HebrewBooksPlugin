import {
  clampProximity,
  defaultSearchOptions,
  maximumProximity,
  minimumProximity,
  type SearchOptions,
} from '../models';
import type { IconName } from '../icons.generated';
import { actionButton, element, iconElement } from '../ui/widgets';

/// דיאלוג החיפוש — שיקוף של SearchDialog (lib/search/view/search_dialog.dart):
/// כותרת עם אייקון במיכל primaryContainer, כרטיס "מה לחפש" עם שדה השאילתה
/// ובורר סוג החיפוש, אזור אפשרויות בגובה 260, ותחתית עם "ביטול" ו"חפש".
///
/// שלושת סוגי החיפוש מתורגמים לאפשרויות של שירות היברובוקס: "מדויק" מכבה את
/// כל ההרחבות, "מתקדם" חושף אותן, ו"מקורב" מפעיל סף שגיאות כתיב (fuzziness).

type SearchMode = 'exact' | 'advanced' | 'fuzzy';

const modes: ReadonlyArray<{ id: SearchMode; icon: IconName; label: string; description: string }> = [
  {
    id: 'exact',
    icon: 'text_quote_24_regular',
    label: 'מדויק',
    description: 'חיפוש המילים כפי שהוקלדו, ללא הרחבות.',
  },
  {
    id: 'advanced',
    icon: 'search_info_24_regular',
    label: 'מתקדם',
    description: 'הרחבת החיפוש לאותיות שימוש, שורשים, כתיב מלא וחסר ועוד.',
  },
  {
    id: 'fuzzy',
    icon: 'arrow_bidirectional_left_right_24_regular',
    label: 'מקורב',
    description: 'התאמה גם למילים דומות — שימושי בסריקות עם שגיאות OCR.',
  },
];

const corpusEntries: ReadonlyArray<{ value: SearchOptions['corpus'][number]; label: string }> = [
  { value: 'pdf', label: 'ספרים סרוקים (PDF)' },
  { value: 'otzraya', label: 'ספרי טקסט' },
  { value: 'personal', label: 'אוסף אישי' },
];

/// מפתחות ההרחבה הבוליאניים של אפשרויות החיפוש — כל מה ש"מתקדם" חושף.
type ExpansionKey = {
  [K in keyof SearchOptions]: SearchOptions[K] extends boolean ? K : never;
}[keyof SearchOptions];

const expansionEntries: ReadonlyArray<{ key: ExpansionKey; label: string }> = [
  { key: 'hybur', label: 'אותיות שימוש' },
  { key: 'roots', label: 'שורשים ונטיות' },
  { key: 'spelling', label: 'כתיב מלא וחסר' },
  { key: 'gematria', label: 'גימטריה' },
  { key: 'numberGender', label: 'זכר ונקבה במספרים' },
  { key: 'aramaic', label: 'עברית וארמית' },
  { key: 'rashetevot', label: 'ראשי תיבות' },
  { key: 'rashiOcr', label: 'שגיאות OCR בכתב רש״י' },
  { key: 'requireWordOrder', label: 'שמירת סדר המילים' },
  { key: 'firstWord', label: 'מילה ראשונה בעמוד' },
  { key: 'lastWord', label: 'מילה אחרונה בעמוד' },
];

export interface SearchRequest {
  readonly query: string;
  readonly options: SearchOptions;
}

export class SearchDialog {
  readonly root = element('dialog', 'search-dialog') as HTMLDialogElement;
  private readonly queryInput = element('input');
  private readonly modeSelector = element('div', 'mode-selector');
  private readonly modeDescription = element('p', 'mode-description');
  private readonly modeContent = element('div', 'mode-content');
  private mode: SearchMode = 'exact';
  private options: SearchOptions = { ...defaultSearchOptions };

  constructor(private readonly onSubmit: (request: SearchRequest) => void) {
    const layout = element('div', 'search-dialog-layout');
    layout.append(this.buildHeader(), element('div', 'dialog-divider'));

    const body = element('div', 'dialog-body');
    body.append(this.buildComposer(), this.modeContent);
    layout.append(body, element('div', 'dialog-divider'), this.buildFooter());

    this.root.append(layout);
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.submit();
    });
    this.renderModeSelector();
    this.renderModeContent();
  }

  open(query: string): void {
    this.queryInput.value = query;
    if (!this.root.isConnected) document.body.append(this.root);
    this.root.showModal();
    this.queryInput.focus();
    this.queryInput.select();
  }

  close(): void {
    this.root.close();
  }

  /// מאפשר לפתוח את הדיאלוג לעריכת חיפוש קיים — כמו editTab באוצריא.
  setOptions(options: SearchOptions): void {
    this.options = { ...options, proximity: clampProximity(options.proximity) };
    this.mode = options.fuzziness > 0
      ? 'fuzzy'
      : expansionEntries.some(({ key }) => options[key] === true)
        ? 'advanced'
        : 'exact';
    this.renderModeSelector();
    this.renderModeContent();
  }

  private buildHeader(): HTMLElement {
    const header = element('header', 'dialog-header');
    const iconBox = element('div', 'dialog-header-icon');
    iconBox.append(iconElement('search_24_filled', 22));
    const text = element('div', 'dialog-header-text');
    text.append(
      element('h2', undefined, 'חיפוש בהיברובוקס'),
      element('p', undefined, 'בחר שאילתה, סוג חיפוש ומקורות'),
    );
    const close = element('button', 'dialog-close-button');
    close.type = 'button';
    close.dataset.tooltip = 'סגור';
    close.setAttribute('aria-label', 'סגור');
    close.append(iconElement('dismiss_24_regular', 24));
    close.addEventListener('click', () => this.close());
    header.append(iconBox, text, close);
    return header;
  }

  private buildComposer(): HTMLElement {
    const card = element('div', 'dialog-card');
    card.append(element('div', 'section-label', 'מה לחפש'));

    const field = element('div', 'text-field');
    field.append(iconElement('search_24_regular', 24, 'icon field-icon'));
    this.queryInput.type = 'search';
    this.queryInput.maxLength = 500;
    this.queryInput.autocomplete = 'off';
    this.queryInput.placeholder = 'הקלד מילות חיפוש';
    this.queryInput.setAttribute('aria-label', 'חיפוש');
    field.append(this.queryInput, element('span', 'field-label', 'חיפוש'));
    card.append(field);

    card.append(element('div', 'section-label', 'סוג החיפוש'), this.modeSelector, this.modeDescription);
    return card;
  }

  private renderModeSelector(): void {
    this.modeSelector.replaceChildren(
      ...modes.map((mode) => {
        const segment = element('button', 'mode-segment');
        segment.type = 'button';
        segment.setAttribute('aria-pressed', String(mode.id === this.mode));
        segment.append(iconElement(mode.icon, 18), element('span', undefined, mode.label));
        segment.addEventListener('click', () => {
          this.mode = mode.id;
          if (mode.id !== 'fuzzy') this.options.fuzziness = 0;
          if (mode.id === 'exact') {
            for (const { key } of expansionEntries) this.options[key] = false;
          }
          if (mode.id === 'fuzzy' && this.options.fuzziness === 0) this.options.fuzziness = 1;
          this.renderModeSelector();
          this.renderModeContent();
        });
        return segment;
      }),
    );
    this.modeDescription.textContent = modes.find((mode) => mode.id === this.mode)?.description ?? '';
  }

  private renderModeContent(): void {
    const cards: HTMLElement[] = [this.buildScopeCard()];
    if (this.mode === 'advanced') cards.push(this.buildExpansionsCard());
    if (this.mode === 'fuzzy') cards.push(this.buildFuzzyCard());
    this.modeContent.replaceChildren(...cards);
  }

  private buildScopeCard(): HTMLElement {
    const card = element('div', 'dialog-card');
    card.append(element('div', 'section-label', 'היקף החיפוש'));

    const corpusGrid = element('div', 'checkbox-grid');
    for (const entry of corpusEntries) {
      corpusGrid.append(
        this.buildCheckbox(entry.label, this.options.corpus.includes(entry.value), (checked) => {
          const corpus = new Set(this.options.corpus);
          if (checked) corpus.add(entry.value);
          else corpus.delete(entry.value);
          this.options.corpus = [...corpus];
        }),
      );
    }
    card.append(corpusGrid);

    const grid = element('div', 'options-grid');
    grid.append(
      this.buildNumberField('מרחק בין מילים', this.options.proximity, minimumProximity, maximumProximity, (value) => {
        this.options.proximity = value;
      }),
      this.buildSelectField(
        'מספר תוצאות',
        [
          { value: '50', label: '50' },
          { value: '100', label: '100' },
          { value: '200', label: '200' },
        ],
        String(this.options.limit),
        (value) => {
          this.options.limit = Number(value);
          this.options.max = Math.min(this.options.limit * 5, 1000);
        },
      ),
    );
    card.append(grid);
    return card;
  }

  private buildExpansionsCard(): HTMLElement {
    const card = element('div', 'dialog-card');
    card.append(element('div', 'section-label', 'הרחבות החיפוש'));
    const grid = element('div', 'checkbox-grid');
    for (const entry of expansionEntries) {
      grid.append(
        this.buildCheckbox(entry.label, this.options[entry.key], (checked) => {
          this.options[entry.key] = checked;
        }),
      );
    }
    card.append(grid);
    return card;
  }

  private buildFuzzyCard(): HTMLElement {
    const card = element('div', 'dialog-card');
    const hint = element('div', 'fuzzy-hint');
    const iconBox = element('div', 'fuzzy-hint-icon');
    iconBox.append(iconElement('arrow_bidirectional_left_right_24_regular', 24));
    const text = element('div');
    text.append(
      element('h4', undefined, 'חיפוש מקורב'),
      element(
        'p',
        undefined,
        'ככל שהערך גבוה יותר, החיפוש יסכים ליותר הבדלי אותיות בין מילת החיפוש למילה שבספר.',
      ),
    );
    hint.append(iconBox, text);
    card.append(hint);
    const grid = element('div', 'options-grid');
    grid.append(
      this.buildNumberField('רמת קירוב', this.options.fuzziness, 1, 10, (value) => {
        this.options.fuzziness = value;
      }),
    );
    card.append(grid);
    return card;
  }

  private buildCheckbox(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
    const row = element('label', 'checkbox-row');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    row.append(input, element('span', undefined, label));
    return row;
  }

  private buildNumberField(
    label: string,
    value: number,
    minimum: number,
    maximum: number,
    onChange: (value: number) => void,
  ): HTMLElement {
    const field = element('div', 'text-field');
    const input = element('input');
    input.type = 'number';
    input.min = String(minimum);
    input.max = String(maximum);
    input.value = String(value);
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      const parsed = Number(input.value);
      const clamped = Number.isFinite(parsed)
        ? Math.min(Math.max(Math.round(parsed), minimum), maximum)
        : minimum;
      input.value = String(clamped);
      onChange(clamped);
    });
    field.append(input, element('span', 'field-label', label));
    return field;
  }

  private buildSelectField(
    label: string,
    entries: ReadonlyArray<{ value: string; label: string }>,
    value: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const field = element('div', 'text-field');
    const select = element('select');
    select.setAttribute('aria-label', label);
    for (const entry of entries) {
      const option = element('option', undefined, entry.label);
      option.value = entry.value;
      if (entry.value === value) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => onChange(select.value));
    field.append(select, element('span', 'field-label', label));
    return field;
  }

  private buildFooter(): HTMLElement {
    const footer = element('footer', 'dialog-footer');
    footer.append(element('span', 'footer-hint', 'Enter מפעיל את החיפוש'));
    footer.append(
      actionButton({ text: 'ביטול', variant: 'neutral', onClick: () => this.close() }),
      actionButton({
        text: 'חפש',
        variant: 'recommended',
        icon: 'search_24_regular',
        tooltip: 'חפש',
        onClick: () => this.submit(),
      }),
    );
    return footer;
  }

  private submit(): void {
    this.onSubmit({ query: this.queryInput.value, options: { ...this.options } });
  }
}
