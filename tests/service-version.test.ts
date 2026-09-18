/// אכיפת גרסת השירות: השוואה מול הגרסה הנדרשת שב-installer/dependencies.json.

import { describe, expect, it } from 'vitest';
import dependencies from '../installer/dependencies.json';
import {
  outdatedService,
  outdatedServiceMessage,
  requiredServiceVersion,
} from '../src/utils/service-version';

describe('requiredServiceVersion', () => {
  it('נלקח מ-installer/dependencies.json ולא מהעתק שני', () => {
    expect(requiredServiceVersion).toBe(dependencies.runtime.version);
    expect(requiredServiceVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('outdatedService', () => {
  it('שירות ישן מזוהה עם הגרסה שנמצאה והגרסה הנדרשת', () => {
    expect(outdatedService('3.0.100', '3.0.114')).toEqual({ found: '3.0.100', required: '3.0.114' });
  });

  it('משווה מספרית ולא לקסיקוגרפית — 3.0.99 ישן מ-3.0.114', () => {
    expect(outdatedService('3.0.99', '3.0.114')).not.toBeNull();
    expect(outdatedService('3.0.114', '3.0.99')).toBeNull();
  });

  it('גרסה זהה אינה נחשבת ישנה', () => {
    expect(outdatedService('3.0.114', '3.0.114')).toBeNull();
  });

  it('שירות חדש מהנדרש אינו מתריע — תאימות קדימה היא מצב תקין', () => {
    expect(outdatedService('3.0.115', '3.0.114')).toBeNull();
    expect(outdatedService('4.0.0', '3.0.114')).toBeNull();
    expect(outdatedService('3.1', '3.0.114')).toBeNull();
  });

  it('שירות שאינו מדווח גרסה שאפשר להשוות נחשב ישן — הדיווח עצמו חדש', () => {
    for (const value of [null, undefined, '', '   ', 'unknown', {} as unknown as string]) {
      expect(() => outdatedService(value as string | null | undefined, '3.0.114')).not.toThrow();
      expect(outdatedService(value as string | null | undefined, '3.0.114')).toEqual({
        found: null,
        required: '3.0.114',
      });
    }
  });

  it('גרסה עם תווית build או תחילית v מושווית לפי החלק המספרי', () => {
    expect(outdatedService('3.0.100-beta2+6a3f991', '3.0.114')).toMatchObject({ found: '3.0.100-beta2+6a3f991' });
    expect(outdatedService('v3.0.114', '3.0.114')).toBeNull();
    expect(outdatedService('3.0.114.0', '3.0.114')).toBeNull();
  });
});

describe('outdatedServiceMessage', () => {
  it('נוקבת בגרסה שנמצאה, בגרסה הנדרשת ובדרך לתקן', () => {
    const message = outdatedServiceMessage('3.0.100');
    expect(message).toContain('3.0.100');
    expect(message).toContain(requiredServiceVersion);
    expect(message).toContain('מתקין HebrewBooks לאוצריא');
  });

  it('שותקת לגרסה עדכנית ולגרסה חדשה יותר', () => {
    expect(outdatedServiceMessage(requiredServiceVersion)).toBeNull();
    expect(outdatedServiceMessage('99.0.0')).toBeNull();
  });

  it('גרסה חסרה מקבלת את אותה הודעת עדכון, ואומרת שהשירות אינו מדווח גרסה', () => {
    const message = outdatedServiceMessage(null) ?? '';
    expect(message).toContain('אינו מדווח על גרסתו');
    expect(message).toContain(requiredServiceVersion);
    expect(message).toContain('מתקין HebrewBooks לאוצריא');
    expect(outdatedServiceMessage(undefined)).toBe(message);
  });
});
