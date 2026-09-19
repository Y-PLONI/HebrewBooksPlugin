import { describe, expect, it } from 'vitest';
import type { MatchQueryTranslation } from '../src/models';
import { honouredExpansions, partialMatchHonoursExpansions } from '../src/search-option-support';
import {
  clampProximity,
  defaultSearchOptions,
  hebrewBooksMatchQuery,
  maximumMatchCombinations,
  maximumProximity,
  maximumQueryCharacters,
  minimumProximity,
  paragraphProximity,
  requiredWordCount,
  scopeProximity,
  sectionProximity,
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

describe('scopeProximity', () => {
  it('לכל טווח קרבה חלון משלו, והסעיף רחב מהפסקה', () => {
    expect(scopeProximity('sameParagraph')).toBe(paragraphProximity);
    expect(scopeProximity('sameSection')).toBe(sectionProximity);
    expect(sectionProximity).toBeGreaterThan(paragraphProximity);
  });

  it('בהתאמה חלקית אוצריא מתאימה ברזולוציית הפסקה — וכך גם wordDistance', () => {
    expect(scopeProximity('wordDistance')).toBe(paragraphProximity);
    expect(scopeProximity(undefined)).toBe(paragraphProximity);
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

  it('"כל המילים" בכל טווח הוא השאילתה הרגילה, שהבנאי של hbsearch מרחיב', () => {
    for (const proximityScope of ['wordDistance', 'sameParagraph', 'sameSection'] as const) {
      expect(hebrewBooksMatchQuery(words.join(' '), { proximityScope })).toEqual({ query: '' });
    }
  });

  /// צורה חוקית: לכל w/N מילה בודדת מימינו, ומשמאלו מילה או ביטוי כזה.
  /// dtSearch דוחה w/N ששני צדדיו ביטויי טווח.
  function isLeftLeaning(group: string): boolean {
    const match = /^\((.+) w\/\d+ ([^\s()]+)\)$/.exec(group);
    return match === null ? /^[^\s()]+$/.test(group) : isLeftLeaning(match[1] as string);
  }

  it('כל w/N מסוגר במפורש — שרשרת חשופה נדחית ב-dtSearch כתחביר שגוי', () => {
    for (const proximityScope of ['sameParagraph', 'sameSection'] as const) {
      const proximity = scopeProximity(proximityScope);
      const groups = hebrewBooksMatchQuery(words.join(' '), {
        proximityScope,
        wordMatchMode: 'atLeast',
        wordMatchCount: 3,
      }).query.split(' or ');

      expect(groups).toHaveLength(10);
      expect(groups.filter(isLeftLeaning)).toEqual(groups);
      expect(groups[0]).toBe(`((אלף w/${proximity} בית) w/${proximity} גימל)`);
    }
    expect(isLeftLeaning('(אלף w/30 בית w/30 גימל)')).toBe(false);
    expect(isLeftLeaning('(אלף w/30 (בית w/30 גימל))')).toBe(false);
  });

  it('מילה שהמנוע קורא כאופרטור נדחית — היא הופכת את הצירופים לתחביר שגוי', () => {
    // נמדד חי מול hbsearch: כל אחת מהן מחזירה אפס תוצאות בלי אירוע שגיאה.
    for (const operator of ['and', 'OR', 'Not', 'contains', 'xfilter', 'w/5', 'PRE/3']) {
      for (const wordMatchMode of ['anyWord', 'mostWords', 'atLeast'] as const) {
        const translation = hebrewBooksMatchQuery(`ברוך ${operator} אתה מלך`, { wordMatchMode });
        expect(translation.query).toBe('');
        expect(translation.unsupported).toContain('אופרטור של מנוע החיפוש');
      }
    }
    // טוקנים שנמדדו כתקינים נשארים מילים רגילות, ו"כל המילים" עובר כמות שהוא.
    for (const plain of ['to', 'xfirstword', 'andalusia']) {
      expect(hebrewBooksMatchQuery(`ברוך ${plain} אתה`, { wordMatchMode: 'mostWords' }).unsupported)
        .toBeUndefined();
    }
    expect(hebrewBooksMatchQuery('ברוך w/5 אתה', { wordMatchMode: 'all' })).toEqual({ query: '' });
  });

  it('טוקן שכולו תו מיוחד של dtSearch נדחה בכל מצב — הוא אינו מילת חיפוש', () => {
    // נמדד חי מול hbsearch: `*` החזיר חמש תוצאות שווא, `?`/`%`/`=` לא הסתיימו
    // בעשרים שניות, ו-`~`/`#`/`&`/`::` חזרו כאפס תוצאות בלי אירוע שגיאה.
    for (const metacharacter of ['*', '?', '~', '%', '#', '&', '=', '::']) {
      for (const wordMatchMode of ['all', 'anyWord', 'mostWords', 'atLeast'] as const) {
        const translation = hebrewBooksMatchQuery(`זזזזזזזז ${metacharacter} שלום`, { wordMatchMode });
        expect(translation.query).toBe('');
        expect(translation.unsupported).toContain(metacharacter);
      }
    }
  });

  it('תו מיוחד שדבוק למילה נשאר — כך בדיוק נשלחת אותה מילה ב"כל המילים"', () => {
    // `(שלום w/30 בראש*)` נמדד חי: 560 אלפיות ותוצאות אמיתיות.
    for (const word of ['בראש*', 'שלו*']) {
      expect(hebrewBooksMatchQuery(`ברוך ${word} אתה`, { wordMatchMode: 'mostWords' }).unsupported)
        .toBeUndefined();
    }
    // פיסוק שאינו תו מיוחד אינו עילה לדחייה — הבנאי של hbsearch מתעלם ממנו.
    for (const punctuation of ['-', ',', '"', '(']) {
      expect(hebrewBooksMatchQuery(`ברוך ${punctuation} אתה`, { wordMatchMode: 'mostWords' }).unsupported)
        .toBeUndefined();
    }
  });

  /// המילים שהתרגום בנה מ-[text], לפי סדר הופעתן בצירוף הראשון.
  function tokens(text: string): string[] {
    const first = hebrewBooksMatchQuery(text, { wordMatchMode: 'atLeast', wordMatchCount: 2 })
      .query.split(' or ');
    return [...new Set(first.flatMap((group) => group.replace(/[()]/g, '').split(' w/30 ')))];
  }

  it('מקף שובר מילה כמו בטוקנייזר של אוצריא — הסף נמדד על אותן מילים', () => {
    expect(tokens('בית-דין שלום עולם')).toEqual(['בית', 'דין', 'שלום', 'עולם']);
    expect(tokens('וַיֹּאמֶר־לוֹ אתה')).toEqual(['וַיֹּאמֶר', 'לוֹ', 'אתה']);
    // כך גם `mostWords` דורש 3 מתוך 4, בדיוק כמו אוצריא — לא 2 מתוך 3.
    expect(requiredWordCount(tokens('בית-דין שלום עולם').length, 'mostWords', undefined)).toBe(3);
  });

  it('גרשיים בתוך מילה אינן שוברות אותה — ראשי תיבות נשארים מילה אחת', () => {
    for (const acronym of ['רמב"ם', 'רמב״ם', "רמב''ם"]) {
      expect(tokens(`${acronym} אתה מלך`)).toEqual(['רמבם', 'אתה', 'מלך']);
    }
    expect(tokens("תוס' אתה מלך")).toEqual(['תוס', 'אתה', 'מלך']);
    expect(tokens('פ.ב.י אתה מלך')).toEqual(['פבי', 'אתה', 'מלך']);
  });

  it('פיסוק דבוק מפריד, ותו מיוחד שאינו תו כללי נושר מהמילה', () => {
    expect(tokens('שלום, עולם! ומה?')).toEqual(['שלום', 'עולם', 'ומה']);
    expect(tokens('א|ב ג ד')).toEqual(['א', 'ב', 'ג', 'ד']);
    for (const word of ['בראשית%', '=בראשית', 'בראשית~', 'בראשית::']) {
      expect(tokens(`${word} אתה מלך`)).toEqual(['בראשית', 'אתה', 'מלך']);
    }
    // `*` נשאר, כי גם "כל המילים" שולחת אותו כתו כללי של dtSearch.
    expect(tokens('שלו* אתה מלך')).toEqual(['שלו*', 'אתה', 'מלך']);
  });

  it('הרחבה שהטאב ביקש נדחית — שאילתת האופרטורים עוקפת את הבנאי של המנוע', () => {
    expect(partialMatchHonoursExpansions).toBe(false);
    for (const option of honouredExpansions) {
      const translation = hebrewBooksMatchQuery('ברוך אתה השם', {
        wordMatchMode: 'mostWords',
        options: { [option.hostKey]: true },
      });
      expect(translation.query).toBe('');
      expect(translation.unsupported).toContain(option.hostKey);
    }
    // אפשרות שאין לה מקבילה בהיברובוקס ממילא אינה משנה את השאילתה.
    expect(hebrewBooksMatchQuery('ברוך אתה השם', {
      wordMatchMode: 'mostWords',
      options: { 'שגיאות כתיב': true },
    }).unsupported).toBeUndefined();
  });

  it('הרחבה פעילה בחלק מהמילים אינה מיושמת גם ב"כל המילים", ולכן אינה נדחית', () => {
    const options = { 'קידומות דקדוקיות': true };
    expect(hebrewBooksMatchQuery('ברוך אתה השם', {
      wordMatchMode: 'mostWords',
      options,
      wordOptions: { 'אתה_1': {} },
    }).unsupported).toBeUndefined();
    // "כל המילים" נשלחת כמילות המשתמש, והמנוע מרחיב אותה בעצמו.
    expect(hebrewBooksMatchQuery('ברוך אתה השם', { wordMatchMode: 'all', options }))
      .toEqual({ query: '' });
  });

  it('התקרה היא גבול מדוד: עשרה צירופים נשלחים, חמישה־עשר נדחים', () => {
    const atLeastTwo = (text: string): MatchQueryTranslation =>
      hebrewBooksMatchQuery(text, { wordMatchMode: 'atLeast', wordMatchCount: 2 });

    // C(5,2)=10 בדיוק בתקרה, C(6,2)=15 מעליה.
    expect(atLeastTwo(words.join(' ')).unsupported).toBeUndefined();
    expect(atLeastTwo([...words, 'וו'].join(' ')).unsupported).toContain('אינו נתמך');
  });

  it('שאילתה ארוכה מהתקרה נדחית בהודעה — גם כשאין בה צירופים כלל', () => {
    const long = Array.from({ length: 1_500 }, (_, index) => `מילה${index}`).join(' ');
    expect(long.length).toBeGreaterThan(maximumQueryCharacters);

    for (const wordMatchMode of ['all', 'anyWord'] as const) {
      const translation = hebrewBooksMatchQuery(long, { wordMatchMode });
      expect(translation.query).toBe('');
      expect(translation.unsupported).toContain('ארוכה מדי');
    }
    expect(hebrewBooksMatchQuery(words.join(' '), { wordMatchMode: 'anyWord' }).unsupported)
      .toBeUndefined();
  });

  it('מעל התקרה המדיניות נדחית, ואינה מתורגמת לחיפוש רחב יותר', () => {
    const many = [...words, 'וו', 'זין', 'חית', 'טית', 'יוד', 'כף', 'למד'];
    const translation = hebrewBooksMatchQuery(many.join(' '), { wordMatchMode: 'mostWords' });

    expect(translation.query).toBe('');
    expect(translation.unsupported).toContain(String(maximumMatchCombinations));
    expect(translation.unsupported).toContain('אינו נתמך');
  });
});
