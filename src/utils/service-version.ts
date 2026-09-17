/// גרסת השירות הנדרשת נקראת מ-installer/dependencies.json — אותו קובץ שממנו
/// המתקין מוריד את הריצה — כדי שלא תהיה גרסה נדרשת שנייה שתתיישן בנפרד.
import dependencies from '../../installer/dependencies.json';

export const requiredServiceVersion: string = dependencies.runtime.version;

export interface OutdatedService {
  readonly found: string;
  readonly required: string;
}

/// null כשהשירות עדכני, חדש מהנדרש, או לא דיווח גרסה שאפשר להשוות.
export function outdatedService(
  found: string | null | undefined,
  required: string = requiredServiceVersion,
): OutdatedService | null {
  if (typeof found !== 'string') return null;
  const foundParts = numericParts(found);
  const requiredParts = numericParts(required);
  if (foundParts === null || requiredParts === null) return null;
  return compareParts(foundParts, requiredParts) < 0 ? { found: found.trim(), required } : null;
}

/// הודעה למשתמש: הגרסה שנמצאה, הגרסה הנדרשת והדרך לתקן. מודיעה ואינה חוסמת.
export function outdatedServiceMessage(found: string | null | undefined): string | null {
  const outdated = outdatedService(found);
  if (outdated === null) return null;
  return (
    `שירות החיפוש המותקן הוא גרסה ${outdated.found}, והתוסף מצפה לגרסה ${outdated.required} ומעלה. ` +
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
