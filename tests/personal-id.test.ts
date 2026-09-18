/// טווח המזהים של המאגר האישי, כפי שהשרת גוזר אותו — וההגנה על המזהה שמגיע
/// מהשירות, כדי ש-NaN לא ידלוף לאוצריא כ-null.

import { describe, expect, it } from 'vitest';
import {
  externalIdOf,
  isPersonalId,
  personalIdBase,
  personalIdCeiling,
} from '../src/utils/personal-id';

/// נתיב יחסי אמיתי מתוך Personal_IDX\hb-manifest.json.
const relativePath = "אא רמב''ם פרנקל\\א מדע מטופל.pdf";

describe('טווח המזהים האישיים', () => {
  it('זהה לקבועים שבשרת', () => {
    expect(personalIdBase).toBe(1e12);
    expect(personalIdCeiling).toBe(personalIdBase + 2 ** 40);
  });

  it('כל מזהה בטווח הוא בן 13 ספרות', () => {
    expect(String(personalIdBase)).toHaveLength(13);
    expect(String(personalIdCeiling - 1)).toHaveLength(13);
  });

  it('שלם ומדויק כ-double עד ראש הטווח', () => {
    expect(Number.isSafeInteger(personalIdCeiling - 1)).toBe(true);
    expect(personalIdCeiling).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(personalIdCeiling - 1 + 1).toBe(personalIdCeiling);
  });
});

describe('isPersonalId', () => {
  it('מזהה בתוך הטווח', () => {
    expect(isPersonalId(1_000_000_000_001)).toBe(true);
    expect(isPersonalId(personalIdBase)).toBe(true);
    expect(isPersonalId(personalIdCeiling - 1)).toBe(true);
  });

  it('מזהה היברובוקס אינו אישי — 69,936 הוא הגדול ביותר בפועל', () => {
    expect(isPersonalId(69_936)).toBe(false);
    expect(isPersonalId(43_558)).toBe(false);
    expect(isPersonalId(1)).toBe(false);
  });

  it('דוחה את הגבול העליון, מספרים שליליים ולא-שלמים', () => {
    expect(isPersonalId(personalIdCeiling)).toBe(false);
    expect(isPersonalId(personalIdBase - 1)).toBe(false);
    expect(isPersonalId(-1)).toBe(false);
    expect(isPersonalId(1_000_000_000_000.5)).toBe(false);
    expect(isPersonalId(Number.NaN)).toBe(false);
    expect(isPersonalId(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('externalIdOf', () => {
  it('מחרוזת ספרות הופכת למספר', () => {
    expect(externalIdOf('43558')).toBe(43_558);
    expect(externalIdOf('1000000000001')).toBe(1_000_000_000_001);
    expect(externalIdOf(43_558)).toBe(43_558);
  });

  it('נתיב יחסי בעברית אינו מזהה — זה המקור ל-NaN שהגיע לאוצריא', () => {
    expect(Number(relativePath)).toBeNaN();
    expect(externalIdOf(relativePath)).toBeNull();
  });

  it('דוחה ריק, null, לא-מספר ומספר לא חיובי', () => {
    expect(externalIdOf('')).toBeNull();
    expect(externalIdOf('   ')).toBeNull();
    expect(externalIdOf(null)).toBeNull();
    expect(externalIdOf(undefined)).toBeNull();
    expect(externalIdOf('0')).toBeNull();
    expect(externalIdOf('-5')).toBeNull();
    expect(externalIdOf('12.5')).toBeNull();
    expect(externalIdOf(Number.NaN)).toBeNull();
  });

  it('דוחה ערך שאינו מחרוזת או מספר, גם כשהמרה שקטה הייתה מצליחה', () => {
    expect(Number([5])).toBe(5);
    expect(externalIdOf([5] as unknown as string)).toBeNull();
    expect(externalIdOf(true as unknown as number)).toBeNull();
    expect(externalIdOf({} as unknown as string)).toBeNull();
  });

  it('דוחה מספר שאינו שלם בטוח, כדי שהמזהה לא יאבד דיוק בדרך', () => {
    expect(externalIdOf('9007199254740993')).toBeNull();
    expect(externalIdOf('1e21')).toBeNull();
  });
});
