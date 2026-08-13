// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSearchOptions, type SearchOptions } from '../src/models';
import { SearchDialog, type SearchRequest } from '../src/screens/search-dialog';

/// הדיאלוג נבדק כשהוא מחובר למסמך: ב-jsdom אירוע change של תיבת סימון נורה
/// רק בעץ המחובר, בדיוק כמו בדפדפן.
function createDialog(): { dialog: SearchDialog; submitted: SearchRequest[] } {
  const submitted: SearchRequest[] = [];
  const dialog = new SearchDialog((request) => submitted.push(request));
  document.body.append(dialog.root);
  return { dialog, submitted };
}

afterEach(() => document.body.replaceChildren());

function segment(dialog: SearchDialog, label: string): HTMLButtonElement {
  const button = [...dialog.root.querySelectorAll<HTMLButtonElement>('.mode-segment')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`אין בורר במצב ${label}`);
  return button;
}

function checkbox(dialog: SearchDialog, label: string): HTMLInputElement {
  const row = [...dialog.root.querySelectorAll<HTMLLabelElement>('.checkbox-row')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  const input = row?.querySelector<HTMLInputElement>('input');
  if (!input) throw new Error(`אין תיבת סימון ${label}`);
  return input;
}

function numberField(dialog: SearchDialog, label: string): HTMLInputElement {
  const input = [...dialog.root.querySelectorAll<HTMLInputElement>('input[type="number"]')].find(
    (candidate) => candidate.getAttribute('aria-label') === label,
  );
  if (!input) throw new Error(`אין שדה ${label}`);
  return input;
}

function submit(dialog: SearchDialog, query = 'ברכת המזון'): void {
  dialog.root.querySelector<HTMLInputElement>('input[type="search"]')!.value = query;
  const search = [...dialog.root.querySelectorAll<HTMLButtonElement>('.dialog-footer button')].find(
    (button) => button.textContent?.includes('חפש'),
  );
  search?.click();
}

function activeMode(dialog: SearchDialog): string {
  return (
    [...dialog.root.querySelectorAll<HTMLButtonElement>('.mode-segment')]
      .find((button) => button.getAttribute('aria-pressed') === 'true')
      ?.textContent?.trim() ?? ''
  );
}

describe('SearchDialog — בחירת סוג החיפוש', () => {
  it('מצב מדויק אינו חושף הרחבות ומשגר אפשרויות נקיות', () => {
    const { dialog, submitted } = createDialog();
    expect(activeMode(dialog)).toBe('מדויק');
    expect(dialog.root.textContent).toContain('חיפוש המילים כפי שהוקלדו');
    expect(dialog.root.querySelectorAll('.checkbox-grid')).toHaveLength(1);

    submit(dialog);
    expect(submitted[0]?.options).toMatchObject({
      fuzziness: 0,
      hybur: false,
      spelling: false,
      aramaic: false,
      rashetevot: false,
      requireWordOrder: true,
    });
  });

  it('מצב מתקדם חושף את ההרחבות המשותפות ומשגר את שנבחרו', () => {
    const { dialog, submitted } = createDialog();
    segment(dialog, 'מתקדם').click();
    checkbox(dialog, 'אותיות שימוש').click();
    checkbox(dialog, 'ראשי תיבות').click();
    submit(dialog);

    expect(submitted[0]?.options).toMatchObject({
      hybur: true,
      rashetevot: true,
      spelling: false,
      aramaic: false,
    });
  });

  it('חזרה למצב מדויק מכבה את ההרחבות שנבחרו', () => {
    const { dialog, submitted } = createDialog();
    segment(dialog, 'מתקדם').click();
    checkbox(dialog, 'אותיות שימוש').click();
    segment(dialog, 'מדויק').click();
    submit(dialog);

    expect(submitted[0]?.options.hybur).toBe(false);
  });

  it('מצב מקורב מדליק קירוב ברירת מחדל, ויציאה ממנו מאפסת אותו', () => {
    const { dialog, submitted } = createDialog();
    segment(dialog, 'מקורב').click();
    submit(dialog);
    expect(submitted[0]?.options.fuzziness).toBe(1);

    segment(dialog, 'מדויק').click();
    submit(dialog);
    expect(submitted[1]?.options.fuzziness).toBe(0);
  });

  it('רמת הקירוב נחסמת בטווח 1–2', () => {
    const { dialog, submitted } = createDialog();
    segment(dialog, 'מקורב').click();
    const field = numberField(dialog, 'רמת קירוב');
    field.value = '9';
    field.dispatchEvent(new Event('change'));
    expect(field.value).toBe('2');
    submit(dialog);
    expect(submitted[0]?.options.fuzziness).toBe(2);
  });
});

describe('SearchDialog — היקף החיפוש', () => {
  it('מרחק בין מילים נחסם בטווח שהשירות תומך בו', () => {
    const { dialog, submitted } = createDialog();
    const field = numberField(dialog, 'מרחק בין מילים');
    expect(field.min).toBe('1');
    expect(field.max).toBe('30');

    field.value = '400';
    field.dispatchEvent(new Event('change'));
    expect(field.value).toBe('30');

    field.value = '0';
    field.dispatchEvent(new Event('change'));
    expect(field.value).toBe('1');

    submit(dialog);
    expect(submitted[0]?.options.proximity).toBe(1);
  });

  it('בחירת מקורות מצטברת ומשוגרת כמערך', () => {
    const { dialog, submitted } = createDialog();
    checkbox(dialog, 'ספרי טקסט').click();
    submit(dialog);
    expect(submitted[0]?.options.corpus).toEqual(['pdf', 'otzraya']);

    checkbox(dialog, 'ספרים סרוקים (PDF)').click();
    submit(dialog);
    expect(submitted[1]?.options.corpus).toEqual(['otzraya']);
  });

  it('מספר התוצאות קובע גם את תקרת התוצאות שנאספות', () => {
    const { dialog, submitted } = createDialog();
    const select = [...dialog.root.querySelectorAll<HTMLSelectElement>('select')].find(
      (candidate) => candidate.getAttribute('aria-label') === 'מספר תוצאות',
    )!;
    select.value = '200';
    select.dispatchEvent(new Event('change'));
    submit(dialog);
    expect(submitted[0]?.options).toMatchObject({ limit: 200, max: 1000 });
  });
});

describe('SearchDialog — פתיחה, עריכה וסגירה', () => {
  it('setOptions מסיק את סוג החיפוש מהאפשרויות הקיימות', () => {
    const { dialog } = createDialog();
    dialog.setOptions({ ...defaultSearchOptions, hybur: true });
    expect(activeMode(dialog)).toBe('מתקדם');
    expect(checkbox(dialog, 'אותיות שימוש').checked).toBe(true);

    dialog.setOptions({ ...defaultSearchOptions, fuzziness: 2 });
    expect(activeMode(dialog)).toBe('מקורב');

    dialog.setOptions({ ...defaultSearchOptions });
    expect(activeMode(dialog)).toBe('מדויק');
  });

  it('setOptions מנקה אפשרויות שאינן נתמכות באוצריא', () => {
    const { dialog, submitted } = createDialog();
    const incompatible: SearchOptions = {
      ...defaultSearchOptions,
      roots: true,
      gematria: true,
      rashiOcr: true,
      firstWord: true,
      lastWord: true,
      requireWordOrder: false,
      proximity: 90,
      fuzziness: 7,
    };
    dialog.setOptions(incompatible);
    submit(dialog);
    expect(submitted[0]?.options).toMatchObject({
      roots: false,
      gematria: false,
      rashiOcr: false,
      firstWord: false,
      lastWord: false,
      requireWordOrder: true,
      proximity: 30,
      fuzziness: 2,
    });
  });

  it('Enter בדיאלוג משגר את החיפוש', () => {
    const { dialog, submitted } = createDialog();
    dialog.root.querySelector<HTMLInputElement>('input[type="search"]')!.value = 'ברכה';
    dialog.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.query).toBe('ברכה');
  });

  it('open ממלא את השאילתה וסוגר עם כפתור הסגירה', () => {
    Object.assign(HTMLDialogElement.prototype, {
      showModal(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
      close(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    });
    const { dialog, submitted } = createDialog();
    dialog.open('חיפוש קודם');
    expect(dialog.root.hasAttribute('open')).toBe(true);
    expect(dialog.root.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe(
      'חיפוש קודם',
    );

    dialog.root.querySelector<HTMLButtonElement>('.dialog-close-button')?.click();
    expect(dialog.root.hasAttribute('open')).toBe(false);
    expect(submitted).toHaveLength(0);
    dialog.root.remove();
  });

  it('כפתור ביטול אינו משגר חיפוש', () => {
    const { dialog, submitted } = createDialog();
    const cancel = [...dialog.root.querySelectorAll<HTMLButtonElement>('.dialog-footer button')].find(
      (button) => button.textContent?.includes('ביטול'),
    );
    const close = vi.spyOn(dialog, 'close').mockImplementation(() => undefined);
    cancel?.click();
    expect(close).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveLength(0);
    close.mockRestore();
  });
});
