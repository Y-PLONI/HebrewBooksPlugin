import type { SearchOptions } from './models';

/// חוזה אפשרויות המילה של טאב החיפוש של אוצריא: לכל אפשרות שהמארח מציג —
/// המפתח המקביל בהיברובוקס, או null כשאין לה מקבילה. מכאן נגזרות רשימות
/// `disabledSearchOptions` שבמניפסט, כדי שאפשרות שהתוסף מתעלם ממנה לא
/// תוצג למשתמש כאילו היא פעילה.

/// מצבי החיפוש שבהם שורת התוסף מוצגת (`visibleInModes` במניפסט). במצב
/// "מקורב" אוצריא מסננת את כל אפשרויות המילה, ולכן אין בו מה להשבית.
export type HostSearchMode = 'exact' | 'advanced';

/// מפתחות ההרחבה הבוליאניים של אפשרויות החיפוש בהיברובוקס.
export type ExpansionKey = {
  [K in keyof SearchOptions]: SearchOptions[K] extends boolean ? K : never;
}[keyof SearchOptions];

/// האם הרחבות המילה חלות גם על שאילתת האופרטורים של התאמה חלקית.
///
/// כרגע לא: QueryBuilder של hbsearch מחזיר כמות שהיא כל שאילתה שיש בה
/// אופרטור (`or` / `w/N`), ולכן אף הרחבה אינה נוספת לה. זו נקודת ההיפוך
/// היחידה — ברגע שההרחבות יחולו שם, הערך הופך ל-true וההגבלות נעלמות.
export const partialMatchHonoursExpansions = false;

export interface HostSearchOption {
  /// המזהה היציב לתוספים (SearchQueryBuilder.pluginOptionIdByWordOptionKey).
  readonly id: string;
  /// המפתח שאוצריא שולחת ומקבלת בו את האפשרות (`options` / `wordOptions`).
  readonly hostKey: string;
  /// המצבים שבהם אוצריא מציגה את האפשרות בדיאלוג; "רגיל" מציג רק את
  /// exactWordOptionKeys, והשאר בלעדי למתקדם.
  readonly modes: readonly HostSearchMode[];
  /// המפתח המקביל ב-SearchOptions; null = היברובוקס אינה מכירה את האפשרות.
  readonly key: ExpansionKey | null;
}

export const hostSearchOptions: readonly HostSearchOption[] = [
  { id: 'word.grammatical-prefixes', hostKey: 'קידומות דקדוקיות', modes: ['exact', 'advanced'], key: 'hybur' },
  { id: 'word.grammatical-suffixes', hostKey: 'סיומות דקדוקיות', modes: ['exact', 'advanced'], key: null },
  { id: 'word.prefixes', hostKey: 'קידומות', modes: ['advanced'], key: null },
  { id: 'word.suffixes', hostKey: 'סיומות', modes: ['advanced'], key: null },
  { id: 'word.full-or-defective-spelling', hostKey: 'כתיב מלא/חסר', modes: ['exact', 'advanced'], key: 'spelling' },
  { id: 'word.partial', hostKey: 'חלק ממילה', modes: ['exact', 'advanced'], key: null },
  { id: 'word.typo-tolerance', hostKey: 'שגיאות כתיב', modes: ['exact', 'advanced'], key: null },
  { id: 'word.aramaic-prefixes', hostKey: 'קידומות ארמיות', modes: ['advanced'], key: null },
  { id: 'word.aramaic-suffixes', hostKey: 'סיומות ארמיות', modes: ['advanced'], key: null },
  { id: 'word.ignore-quotes', hostKey: 'התעלם מגרשיים', modes: ['advanced'], key: null },
  { id: 'word.aramaic-translation', hostKey: 'תרגום ארמי', modes: ['advanced'], key: 'aramaic' },
  { id: 'word.acronyms', hostKey: 'ראשי תיבות', modes: ['advanced'], key: 'rashetevot' },
  { id: 'word.nikud', hostKey: 'ניקוד', modes: ['advanced'], key: null },
  { id: 'word.taamim', hostKey: 'טעמים', modes: ['advanced'], key: null },
];

/// ההרחבות שהיברובוקס כן מיישמת — כולן דרך QueryBuilder של המנוע, ולכן
/// כולן תלויות ב-[partialMatchHonoursExpansions].
export const honouredExpansions: ReadonlyArray<HostSearchOption & { key: ExpansionKey }> =
  hostSearchOptions.filter(
    (option): option is HostSearchOption & { key: ExpansionKey } => option.key !== null,
  );

/// האם ההרחבות חלות על השאילתה שנשלחה בפועל. [operatorQuery] = השאילתה
/// נבנתה כאופרטורים במקום כמילות המשתמש (התאמה חלקית).
export function expansionsHonoured(operatorQuery: boolean): boolean {
  return !operatorQuery || partialMatchHonoursExpansions;
}

/// מזהי האפשרויות שהמניפסט משבית במצב הזה — כל מה שאוצריא מציגה בו
/// והתוסף אינו מיישם.
///
/// התאמה חלקית אינה נכללת: היא בחירה בתוך המצב המתקדם ולא מצב בפני עצמו,
/// והמניפסט יודע להשבית לפי מצב בלבד. היא נאכפת ב-[expansionsHonoured].
export function unsupportedOptionIds(mode: HostSearchMode): string[] {
  return hostSearchOptions
    .filter((option) => option.modes.includes(mode) && option.key === null)
    .map((option) => option.id);
}
