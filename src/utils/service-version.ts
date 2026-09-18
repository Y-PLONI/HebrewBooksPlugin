/// גרסת השירות הנדרשת נקראת מ-installer/dependencies.json — אותו קובץ שממנו
/// המתקין מוריד את הריצה — כדי שלא תהיה גרסה נדרשת שנייה שתתיישן בנפרד.
import dependencies from '../../installer/dependencies.json';

export const requiredServiceVersion: string = dependencies.runtime.version;

export interface OutdatedService {
  /// null כששירות אינו מדווח גרסה שאפשר להשוות — ולכן הוא ישן.
  readonly found: string | null;
  readonly required: string;
}

/// null רק כשהשירות דיווח גרסה עדכנית או חדשה ממנה. שירות בלי דיווח גרסה
/// הוא ישן: את `serverVersion` מדווחות רק הגרסאות שהתוסף דורש.
export function outdatedService(
  found: string | null | undefined,
  required: string = requiredServiceVersion,
): OutdatedService | null {
  const requiredParts = numericParts(required);
  if (requiredParts === null) return null;
  const foundParts = typeof found === 'string' ? numericParts(found) : null;
  if (foundParts === null) return { found: null, required };
  return compareParts(foundParts, requiredParts) < 0
    ? { found: (found as string).trim(), required }
    : null;
}

/// הודעה למשתמש: הגרסה שנמצאה, הגרסה הנדרשת והדרך לתקן. מודיעה ואינה חוסמת.
export function outdatedServiceMessage(found: string | null | undefined): string | null {
  const outdated = outdatedService(found);
  if (outdated === null) return null;
  const opening = outdated.found === null
    ? 'שירות החיפוש המותקן אינו מדווח על גרסתו — סימן שהוא ישן'
    : `שירות החיפוש המותקן הוא גרסה ${outdated.found}`;
  return (
    `${opening}, והתוסף מצפה לגרסה ${outdated.required} ומעלה. ` +
    'החיפוש ימשיך לפעול במסלול הישן, אך יכולות חדשות עלולות לא לעבוד. ' +
    'לעדכון: הרץ שוב את מתקין HebrewBooks לאוצריא.'
  );
}

function numericParts(value: string): number[] | null {
  const digits = /^\s*v?(\d+(?:\.\d+)*)/.exec(value)?.[1];
  return digits === undefined ? null : digits.split('.').map(Number);
}

function compareParts(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
