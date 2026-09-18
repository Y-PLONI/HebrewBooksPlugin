/// מזהה של ספר במאגר האישי הוא מספר בן 13 ספרות בטווח שמור, שהשרת גוזר
/// מהנתיב היחסי של הקובץ. הטווח רחוק שלושה סדרי גודל מכל FileID של היברובוקס
/// (המרבי כיום: 69,936), ולכן שום מזהה קיים אינו משנה משמעות.
export const personalIdBase = 1_000_000_000_000;

/// גבול עליון לא-כולל, 2^40 מעל הבסיס. עדיין 13 ספרות, ומיוצג במדויק כ-double.
export const personalIdCeiling = 2_099_511_627_776;

export function isPersonalId(value: number): boolean {
  return Number.isInteger(value) && value >= personalIdBase && value < personalIdCeiling;
}

/// המזהה המספרי של תוצאה, או null כשאין כזה. שרת ישן שולח ב-fileId של ספר
/// אישי נתיב יחסי בעברית, ו-Number() עליו מחזיר NaN שמשתחל לאוצריא כ-null.
export function externalIdOf(fileId: string | number | null | undefined): number | null {
  if (typeof fileId !== 'string' && typeof fileId !== 'number') return null;
  const id = Number(fileId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
