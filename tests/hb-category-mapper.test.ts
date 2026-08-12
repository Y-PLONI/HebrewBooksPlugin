import { describe, expect, it } from 'vitest';
import { mapHebrewBooksCategory } from '../src/services/hb-category-mapper';

describe('mapHebrewBooksCategory', () => {
  it('ממפה תגית בודדת לקטגוריית-על של אוצריא', () => {
    expect(mapHebrewBooksCategory('חומש')).toBe('/תנ"ך');
    expect(mapHebrewBooksCategory('שו"ת')).toBe('/שו"ת');
    expect(mapHebrewBooksCategory('חבד')).toBe('/חסידות');
    expect(mapHebrewBooksCategory('הגדה של פסח')).toBe('/סדר התפילה');
  });

  it('צירוף תגיות הוא סיווג אחד — הכלל הספציפי גובר', () => {
    // מסכת ברכות ולא "ברכות" (הלכות ברכת המזון)
    expect(mapHebrewBooksCategory('ברכות|מסכת')).toBe('/תלמוד בבלי');
    // ספר שו"ת על אורח חיים הוא שו"ת
    expect(mapHebrewBooksCategory('אורח חיים|שו"ת')).toBe('/שו"ת');
    // ספר הלכה מתקופת הגאונים הוא הלכה
    expect(mapHebrewBooksCategory('אורח חיים|גאונים|הלכה')).toBe('/הלכה');
    // דרשות על התורה שייכות לתנ"ך
    expect(mapHebrewBooksCategory('דרשות|עה"ת')).toBe('/תנ"ך');
    // ירושלמי גובר על סימוני תלמוד כלליים
    expect(mapHebrewBooksCategory('ירושלמי|מסכת')).toBe('/תלמוד ירושלמי');
  });

  it('שם מסכת בודד אינו ממופה — דו-משמעי בלי "מסכת"', () => {
    expect(mapHebrewBooksCategory('ברכות')).toBeNull();
    expect(mapHebrewBooksCategory('שבת')).toBeNull();
  });

  it('מחזיר null לקלט ריק או לא מוכר', () => {
    expect(mapHebrewBooksCategory(null)).toBeNull();
    expect(mapHebrewBooksCategory('')).toBeNull();
    expect(mapHebrewBooksCategory('ירחון|יידיש')).toBeNull();
  });
});
