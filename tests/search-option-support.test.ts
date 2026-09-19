import { describe, expect, it } from 'vitest';
import manifestJson from '../manifest.json';
import {
  expansionsHonoured,
  honouredExpansions,
  partialMatchHonoursExpansions,
  unsupportedOptionIds,
} from '../src/search-option-support';

const item = manifestJson.contributes.startup.searchDialogItems[0]!;
const disabled = item.disabledSearchOptions as Record<string, string[] | undefined>;

describe('חוזה אפשרויות המילה של טאב החיפוש', () => {
  it('המניפסט משבית בדיוק את מה שהתוסף אינו מיישם', () => {
    expect(disabled.exact).toEqual(unsupportedOptionIds('exact'));
    expect(disabled.advanced).toEqual(unsupportedOptionIds('advanced'));
  });

  it('במצב הרגיל מושבתות שלוש האפשרויות שאין להן מקבילה בהיברובוקס', () => {
    // אוצריא מציגה במצב הרגיל חמש אפשרויות (exactWordOptionKeys); רק
    // "קידומות דקדוקיות" ו"כתיב מלא/חסר" מתורגמות לשאילתה של היברובוקס.
    expect(unsupportedOptionIds('exact')).toEqual([
      'word.grammatical-suffixes',
      'word.partial',
      'word.typo-tolerance',
    ]);
  });

  it('שורת התוסף אינה מוצגת במצב מקורב, שבו אוצריא מסננת כל אפשרות מילה', () => {
    expect(item.visibleInModes).toEqual(['exact', 'advanced']);
  });

  it('ארבע ההרחבות הנתמכות ממופות למפתחות שאוצריא שולחת', () => {
    expect(honouredExpansions.map((option) => [option.hostKey, option.key])).toEqual([
      ['קידומות דקדוקיות', 'hybur'],
      ['כתיב מלא/חסר', 'spelling'],
      ['תרגום ארמי', 'aramaic'],
      ['ראשי תיבות', 'rashetevot'],
    ]);
  });

  it('שאילתת אופרטורים של התאמה חלקית אינה נושאת הרחבות', () => {
    expect(expansionsHonoured(false)).toBe(true);
    expect(expansionsHonoured(true)).toBe(partialMatchHonoursExpansions);
    expect(partialMatchHonoursExpansions).toBe(false);
  });

  it('רשימת ההשבתות של כל מצב נשארת מתחת לתקרת אוצריא', () => {
    // PluginSearchDialogItem.maxDisabledOptionsPerMode = 20; חריגה פוסלת
    // את כל השורה בטעינת התוסף.
    for (const ids of Object.values(disabled)) expect(ids!.length).toBeLessThanOrEqual(20);
  });
});
