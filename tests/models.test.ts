import { describe, expect, it } from 'vitest';
import {
  clampProximity,
  defaultSearchOptions,
  hebrewBooksMatchQuery,
  maximumMatchCombinations,
  maximumProximity,
  minimumProximity,
} from '../src/models';

describe('clampProximity', () => {
  it('ערך חסר או לא מספרי נופל למינימום שהשירות מקבל', () => {
    expect(clampProximity(undefined)).toBe(minimumProximity);
    expect(clampProximity(Number.NaN)).toBe(minimumProximity);
    expect(clampProximity(Number.POSITIVE_INFINITY)).toBe(minimumProximity);
  });

  it('0 של אוצריא (מילים סמוכות) הופך ל-1, כי hbsearch דורש מספר חיובי', () => {
    expect(clampProximity(0)).toBe(1);
    expect(clampProximity(-7)).toBe(1);
  });

  it('נחסם בתקרה הנתמכת בפועל', () => {
    expect(clampProximity(30)).toBe(maximumProximity);
    expect(clampProximity(31)).toBe(maximumProximity);
    expect(clampProximity(10_000)).toBe(maximumProximity);
  });

  it('מעגל ערכים שאינם שלמים', () => {
    expect(clampProximity(4.4)).toBe(4);
    expect(clampProximity(4.6)).toBe(5);
  });
});

describe('defaultSearchOptions', () => {
  it('ברירות המחדל של איתור עמוד ב-/inbook — proximity מלא ובלי הרחבות', () => {
    expect(defaultSearchOptions.proximity).toBe(maximumProximity);
    expect(defaultSearchOptions.fuzziness).toBe(0);
    expect(defaultSearchOptions.requireWordOrder).toBe(false);
    expect(defaultSearchOptions.firstWord).toBe(false);
    expect(defaultSearchOptions.lastWord).toBe(false);
    expect(defaultSearchOptions.corpus).toEqual(['pdf']);
  });

  it('אינו משותף בין קוראים — שינוי אפשרויות של חיפוש אחד אינו נדבק', () => {
    const copy = { ...defaultSearchOptions, proximity: 3 };
    expect(defaultSearchOptions.proximity).toBe(maximumProximity);
    expect(copy.proximity).toBe(3);
  });
});

describe('hebrewBooksMatchQuery', () => {
  const words = ['אלף', 'בית', 'גימל', 'דלת', 'הא'];

  /// כל תת-קבוצה בגודל k מהמילים, כמפתחות ממוינים להשוואה.
  function subsets(size: number): Set<string> {
    const found = new Set<string>();
    const walk = (index: number, group: string[]): void => {
      if (group.length === size) return void found.add([...group].sort().join('|'));
      if (index === words.length) return;
      walk(index + 1, [...group, words[index] as string]);
      walk(index + 1, group);
    };
    walk(0, []);
    return found;
  }

  it('הדיסיונקציה היא בדיוק צירופי k המילים — בלי חוסר ובלי כפילות', () => {
    for (const required of [2, 3, 4]) {
      const groups = hebrewBooksMatchQuery(words.join(' '), {
        wordMatchMode: 'atLeast',
        wordMatchCount: required,
      }).query.split(' or ');
      const keys = groups.map((group) => group.replace(/[()]/g, '').split(' w/30 ').sort().join('|'));

      expect(new Set(keys)).toEqual(subsets(required));
      expect(keys).toHaveLength(new Set(keys).size);
    }
  });

  it('מעל התקרה המדיניות נדחית, ואינה מתורגמת לחיפוש רחב יותר', () => {
    const many = [...words, 'וו', 'זין', 'חית', 'טית', 'יוד', 'כף', 'למד'];
    const translation = hebrewBooksMatchQuery(many.join(' '), { wordMatchMode: 'mostWords' });

    expect(translation.query).toBe('');
    expect(translation.unsupported).toContain(String(maximumMatchCombinations));
    expect(translation.unsupported).toContain('אינו נתמך');
  });
});
