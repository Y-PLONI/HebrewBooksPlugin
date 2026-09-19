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

interface HostSearchOption {
  /// המזהה היציב של אוצריא (SearchQueryBuilder.pluginOptionIdByWordOptionKey).
  readonly id: string;
  /// המצבים שבהם אוצריא מציגה את האפשרות בדיאלוג; "רגיל" מציג רק את
  /// exactWordOptionKeys, והשאר בלעדי למתקדם.
  readonly modes: readonly HostSearchMode[];
  /// המפתח המקביל ב-SearchOptions; null = היברובוקס אינה מכירה את האפשרות.
  readonly key: ExpansionKey | null;
}

const hostSearchOptions: readonly HostSearchOption[] = [
  { id: 'word.grammatical-prefixes', modes: ['exact', 'advanced'], key: 'hybur' },
  { id: 'word.grammatical-suffixes', modes: ['exact', 'advanced'], key: null },
  { id: 'word.prefixes', modes: ['advanced'], key: null },
  { id: 'word.suffixes', modes: ['advanced'], key: null },
  { id: 'word.full-or-defective-spelling', modes: ['exact', 'advanced'], key: 'spelling' },
  { id: 'word.partial', modes: ['exact', 'advanced'], key: null },
  { id: 'word.typo-tolerance', modes: ['exact', 'advanced'], key: null },
  { id: 'word.aramaic-prefixes', modes: ['advanced'], key: null },
  { id: 'word.aramaic-suffixes', modes: ['advanced'], key: null },
  { id: 'word.ignore-quotes', modes: ['advanced'], key: null },
  { id: 'word.aramaic-translation', modes: ['advanced'], key: 'aramaic' },
  { id: 'word.acronyms', modes: ['advanced'], key: 'rashetevot' },
  { id: 'word.nikud', modes: ['advanced'], key: null },
  { id: 'word.taamim', modes: ['advanced'], key: null },
];

function honoursOption(option: HostSearchOption): boolean {
  return option.key !== null;
}

/// מזהי האפשרויות שהמניפסט משבית במצב הזה — כל מה שאוצריא מציגה בו
/// והתוסף אינו מיישם.
export function unsupportedOptionIds(mode: HostSearchMode): string[] {
  return hostSearchOptions
    .filter((option) => option.modes.includes(mode) && !honoursOption(option))
    .map((option) => option.id);
}
