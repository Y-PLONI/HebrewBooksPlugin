// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { SearchDialog } from '../src/screens/search-dialog';

describe('SearchDialog compatibility options', () => {
  it('keeps HebrewBooks-only advanced options disabled and does not submit them', () => {
    const onSubmit = vi.fn();
    const dialog = new SearchDialog(onSubmit);
    const advanced = [...dialog.root.querySelectorAll<HTMLButtonElement>('.mode-segment')]
      .find((button) => button.textContent?.includes('מתקדם'))!;
    advanced.click();

    const roots = [...dialog.root.querySelectorAll<HTMLLabelElement>('.checkbox-row')]
      .find((row) => row.textContent?.includes('שורשים ונטיות'))!;
    expect(roots.classList.contains('disabled')).toBe(true);
    expect(roots.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);

    const order = [...dialog.root.querySelectorAll<HTMLLabelElement>('.checkbox-row')]
      .find((row) => row.textContent?.includes('שמירת סדר המילים'))!;
    expect(order.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
    expect(order.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);

    dialog.root.querySelector<HTMLInputElement>('input[type="search"]')!.value = 'בדיקה';
    [...dialog.root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('חפש'))!
      .click();

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      query: 'בדיקה',
      options: expect.objectContaining({
        requireWordOrder: true,
        roots: false,
        gematria: false,
        numberGender: false,
        rashiOcr: false,
        firstWord: false,
        lastWord: false,
      }),
    }));
  });

  it('limits fuzzy distance to the range supported by Otzaria', () => {
    const dialog = new SearchDialog(() => undefined);
    const fuzzy = [...dialog.root.querySelectorAll<HTMLButtonElement>('.mode-segment')]
      .find((button) => button.textContent?.includes('מקורב'))!;
    fuzzy.click();

    expect([...dialog.root.querySelectorAll<HTMLInputElement>('input[type="number"]')].at(-1)?.max).toBe('2');
  });
});
