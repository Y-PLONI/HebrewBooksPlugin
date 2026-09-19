import { expansionsHonoured, honouredExpansions } from './search-option-support';

export type SourceType = 'PDF' | 'Text' | 'Personal';

/// גבולות "מרחק בין מילים" (proximity). hbsearch דוחה כל ערך שאינו מספר שלם
/// חיובי (400 עם "expects a positive integer") אך אינו כופה תקרה — proximity
/// גדול פשוט מרחיב את חלון החיפוש בלי הגבלה. הטווח הנתמך בפועל, וזה שה־GUI
/// של השירות מרשה, הוא 1–30; מעליו התוצאות אינן "מרווח בין מילים" אלא הופעה
/// מקרית באותו אזור. לכן התוסף חוסם ב־30 בשני מקומות: בדיאלוג האפשרויות
/// ובתרגום בקשת החיפוש של אוצריא.
export const minimumProximity = 1;
export const maximumProximity = 30;

export function clampProximity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return minimumProximity;
  return Math.min(Math.max(Math.round(value), minimumProximity), maximumProximity);
}

/// hbsearch פולט `A w/N B w/N C` — N חל על כל צמד סמוך ומתיר N-1 מילים ביניהן,
/// בדיוק כמו distance של אוצריא (מילים בין כל שתי מילים, 0 = צמודות).
export function proximityForOtzariaDistance(distance: number | undefined): number {
  const gap = distance === undefined || !Number.isFinite(distance) ? 0 : Math.max(0, Math.round(distance));
  return clampProximity(gap + 1);
}

/// ההופכית של [proximityForOtzariaDistance] — לפתיחת טאב באוצריא מהדיאלוג של
/// התוסף, כך שהטאב מחפש בהיברובוקס באותו proximity שנבחר.
export function otzariaDistanceForProximity(proximity: number): number {
  return clampProximity(proximity) - 1;
}

export type SearchProximityScope = 'wordDistance' | 'sameParagraph' | 'sameSection';
export type SearchWordMatchMode = 'all' | 'anyWord' | 'mostWords' | 'atLeast';

/// מדיניות ההתאמה של טאב החיפוש באוצריא. מארח ותיק אינו שולח אותה, וחסר
/// פירושו ברירת המחדל: מרווח מילים לפי הסדר, כל המילים.
export interface SearchMatchPolicy {
  proximityScope?: SearchProximityScope;
  wordMatchMode?: SearchWordMatchMode;
  wordMatchCount?: number;
  /** אפשרויות ההרחבה של הטאב, כדי שהתרגום יסרב להן כשאינו יכול ליישמן. */
  options?: Record<string, boolean>;
  wordOptions?: Record<string, Record<string, boolean>>;
}

/// חלון ההתאמה החלקית: אין באינדקס של dtSearch יחידה שקטנה מהספר, ולכן
/// זה החלון הרחב ביותר שעדיין נחשב "מרחק בין מילים".
export const paragraphProximity = maximumProximity;

/// חלון טווח הסעיף; הטווח עצמו נדחה ([unsupportedScope]), והערך נשאר רק
/// כדי שאפשרויות הבקשה יישארו מוגדרות.
export const sectionProximity = 300;

/// חלון המילים של טווח הקרבה; בהתאמה חלקית אוצריא מוותרת על המרווח, ולכן
/// גם wordDistance מקבל שם את החלון המלא.
export function scopeProximity(scope: SearchProximityScope | undefined): number {
  return scope === 'sameSection' ? sectionProximity : paragraphProximity;
}

/// אוצריא מודדת את שני הטווחים האלה ביחידת טקסט אמיתית — פסקה היא מסמך
/// אינדקס אחד, וסעיף הוא בלוק כותרת. בהיברובוקס מסמך אחד הוא ספר שלם.
export function unsupportedScope(scope: SearchProximityScope | undefined): string | undefined {
  if (scope !== 'sameParagraph' && scope !== 'sameSection') return undefined;
  const name = scope === 'sameParagraph' ? 'באותה פסקה' : 'תחת אותה כותרת';
  return `חיפוש "${name}" אינו נתמך בהיברובוקס: אוצריא מודדת פסקה וכותרת `
    + 'ביחידות של טקסט מסודר, ובאינדקס של היברובוקס מסמך אחד הוא ספר סרוק '
    + 'שלם בלי חלוקה כזו. אפשר לבחור "מרחק בין מילים".';
}

/// תקרת הפירוק של "לפחות k מתוך n" לצירופים; מעליה המדיניות נדחית, כי
/// דיסיונקציה פשוטה הייתה מחפשת "מילה כלשהי" במקום "רוב המילים".
///
/// המספר נמדד מול השירות בצורת הבקשה האמיתית (max=limit=10,000): במילים
/// נפוצות עשרה צירופים ארכו 74 שניות וחמישה־עשר ארכו 142 — מעל תקרת הזמן
/// של בקשת החיפוש (120 שניות). במילות תוכן רגילות עשרה צירופים ארכו 15.5
/// שניות לכל היותר.
export const maximumMatchCombinations = 10;

/// תקרת האורך של השאילתה הנשלחת. dtSearch מפסיק לנתח בקשה גדולה מדי
/// ומחזיר אפס תוצאות בלי שגיאה: נמדד ש-68,739 תווים התקבלו ו-71,483 נדחו
/// בשקט. התקרה כאן קטנה בהרבה — שאילתה לגיטימית רחוקה ממנה בסדר גודל.
export const maximumQueryCharacters = 8_000;

/// כמה ממילות השאילתה חייבות להופיע, ביחידות של המנוע של אוצריא (על
/// המילים הייחודיות): רוב = n/2+1 בחלוקה שלמה, "לפחות X" נחתך ל-[1, n].
export function requiredWordCount(
  words: number,
  mode: SearchWordMatchMode | undefined,
  count: number | undefined,
): number {
  switch (mode) {
    case 'anyWord':
      return 1;
    case 'mostWords':
      return Math.floor(words / 2) + 1;
    case 'atLeast':
      return Math.min(Math.max(Math.round(count ?? 2), 1), words);
    default:
      return words;
  }
}

/// תרגום מדיניות ההתאמה: [query] ריק = די בשאילתה הרגילה בחלון של הטווח,
/// ו-[unsupported] = אין לה תרגום, ואין להריץ במקומה חיפוש אחר.
export interface MatchQueryTranslation {
  query: string;
  unsupported?: string;
}

/// שאילתת dtSearch למדיניות שהמנוע של אוצריא מוותר בה על הסדר ועל המרווח,
/// או ההודעה שבה המדיניות נדחית כשאין לה תרגום.
export function hebrewBooksMatchQuery(query: string, policy: SearchMatchPolicy): MatchQueryTranslation {
  const mode = policy.wordMatchMode ?? 'all';
  const scope = unsupportedScope(policy.proximityScope);
  if (scope !== undefined) return { query: '', unsupported: scope };
  const metacharacter = metacharacterWord(query);
  if (metacharacter !== undefined) return { query: '', unsupported: metacharacterWordMessage(metacharacter) };
  const words = matchWords(query);
  // "כל המילים" הוא השאילתה הרגילה בחלון של הטווח, עם ההרחבות שהבנאי של
  // hbsearch מוסיף לה — שאילתת אופרטורים הייתה מוותרת עליהן.
  const plain = query.trim();
  if (words.length < 2 || mode === 'all') return withinSizeBudget('', plain);
  const required = requiredWordCount(words.length, mode, policy.wordMatchCount);
  if (required >= words.length) return withinSizeBudget('', plain);
  const expansion = unhonouredExpansion(query, policy);
  if (expansion !== undefined) return { query: '', unsupported: expansionMessage(expansion) };
  const operator = operatorWord(query);
  if (operator !== undefined) return { query: '', unsupported: operatorWordMessage(operator) };
  if (required <= 1) return withinSizeBudget(words.join(' or '));
  if (combinationCount(words.length, required) > maximumMatchCombinations) {
    return { query: '', unsupported: unsupportedMatchMessage(required, words.length) };
  }
  const proximity = scopeProximity(policy.proximityScope);
  return withinSizeBudget(
    combinations(words, required).map((group) => proximityGroup(group, proximity)).join(' or '),
  );
}

/// כל w/N נבנה במפורש עם מילה בודדת מימינו. dtSearch דוחה w/N ששני צדדיו
/// ביטויי טווח, והבנאי שלו מאזן שרשרת ארוכה בדיוק לצורה האסורה הזו.
function proximityGroup(group: string[], proximity: number): string {
  return group.reduce((left, word) => (left === '' ? word : `(${left} w/${proximity} ${word})`), '');
}

/// טוקן שהמנוע קורא כאופרטור הופך את שאילתת הצירופים לתחביר שגוי, והוא
/// מוחזר כאפס תוצאות בלי שגיאה. נמדד חי: and/or/not/contains/xfilter ו-w/N.
const dtSearchOperator = /^(?:and|or|not|contains|xfilter|(?:w|pre)\/\d+)$/i;

/// טוקן בלי אות וספרה שנושא תו מיוחד של dtSearch. נמדד חי: `*` נפתח כתו
/// כללי ומחזיר התאמות שווא, `?`/`%`/`=` תוקעים, והשאר חוזר כאפס בלי שגיאה.
const dtSearchMetacharacter = /[*?~%#&=:]/;
const letterOrDigit = /[\p{Alphabetic}\p{N}]/u;

function metacharacterWord(query: string): string | undefined {
  return query
    .trim()
    .split(/\s+/)
    .find((word) => !letterOrDigit.test(word) && dtSearchMetacharacter.test(word));
}

/// השאילתה כפי שמסלול "כל המילים" שולח אותה. תו מיוחד שדבוק למילה נשאר
/// אופרטור של dtSearch: נמדד חי שב-`טלגרף` (174 תוצאות, 83ms) `%` החזיר 416
/// ו-`#` החזיר 290, `?` ארך 10.1 שניות, ו-`*` בתחילת מילה לא חזר כלל.
/// היוצא מן הכלל: `*` בסוף מילה נושאת-אות הוא תחילית עובדת (`טלגרף*` —
/// 174 תוצאות ב-41ms), והוא נשלח בכוונה.
export function plainSearchQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map(plainSearchWord)
    .filter(Boolean)
    .join(' ');
}

/// מוחלף ברווח ולא נמחק: מחיקה הייתה מדביקה שתי מילים למילה שאינה קיימת.
function plainSearchWord(word: string): string {
  const prefixWildcard = /\*+$/.test(word) && letterOrDigit.test(word);
  const cleaned = word.replace(/\*+$/, '').replace(/[*?%#&=:~]/g, ' ').trim();
  if (cleaned === '') return '';
  return prefixWildcard ? `${cleaned}*` : cleaned;
}

function metacharacterWordMessage(word: string): string {
  return `"${word}" אינו מילת חיפוש אלא תו מיוחד של מנוע החיפוש, ולכן חיפוש `
    + 'בהיברובוקס יחזיר בגללו תוצאות שגויות או ייתקע. אפשר להסיר אותו מהשאילתה.';
}

/// ההרחבה הראשונה שהטאב ביקש ושאילתת האופרטורים אינה מיישמת. כמו
/// `sharedOptionEnabled`: היברובוקס מיישמת אפשרות רק כשכל המילים נושאות אותה.
function unhonouredExpansion(query: string, policy: SearchMatchPolicy): string | undefined {
  if (expansionsHonoured(true)) return undefined;
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return honouredExpansions.find((option) => words.every((word, index) => (
    (policy.wordOptions?.[`${word}_${index}`] ?? policy.options)?.[option.hostKey] === true
  )))?.hostKey;
}

function expansionMessage(option: string): string {
  return `אי אפשר להפעיל "${option}" בהתאמה חלקית בהיברובוקס: השאילתה נשלחת `
    + 'כאופרטורים, ומנוע החיפוש אינו מרחיב אותה. אפשר לבטל את האפשרות או '
    + 'לבחור "כל המילים".';
}

/// נבדק על המילים כפי שהמשתמש הפריד אותן ברווח: הטוקנייזר שובר `w/5`
/// לשתי מילים, ואז האופרטור היה חומק מהבדיקה.
function operatorWord(query: string): string | undefined {
  return query
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/["'׳״()]/g, ''))
    .find((word) => dtSearchOperator.test(word));
}

function operatorWordMessage(word: string): string {
  return `המילה "${word}" היא אופרטור של מנוע החיפוש, ולכן אי אפשר לכלול אותה `
    + 'בהתאמה חלקית בהיברובוקס. אפשר להסיר אותה או לבחור "כל המילים".';
}

/// בקשה גדולה מדי מוחזרת מ-dtSearch כאפס תוצאות בלי שגיאה, ולכן עדיף
/// לסרב בהודעה. [sent] הוא מה שייצא בפועל כששאילתת האופרטורים ריקה.
function withinSizeBudget(query: string, sent = query): MatchQueryTranslation {
  if (sent.length > maximumQueryCharacters) return { query: '', unsupported: tooLongMessage() };
  return { query };
}

function tooLongMessage(): string {
  return `השאילתה ארוכה מדי לחיפוש בהיברובוקס: מעל ${maximumQueryCharacters} תווים `
    + 'מנוע החיפוש מחזיר אותה כחיפוש ללא תוצאות. אפשר לקצר את השאילתה.';
}

/// ל-dtSearch אין "לפחות k מתוך n", ופירוק לצירופים הוא הביטוי המדויק
/// היחיד שלו; מעל התקרה החיפוש איטי מכדי להסתיים, ועדיף לומר זאת מאשר
/// להריץ בשקט חיפוש רחב יותר.
function unsupportedMatchMessage(required: number, words: number): string {
  return `חיפוש "לפחות ${required} מתוך ${words} מילים" אינו נתמך בהיברובוקס: `
    + `הוא מתפרק ליותר מ-${maximumMatchCombinations} צירופים, והחיפוש בהם `
    + 'איטי מכדי להסתיים. אפשר לקצר את השאילתה או לבחור "כל המילים".';
}

/// גרשיים מוסרים כמו שהבנאי של hbsearch עושה למילה הבסיסית; מילה כפולה
/// מתמזגת, כי גם אוצריא מודדת את הסף במילים ייחודיות.
function matchWords(query: string): string[] {
  return [...new Set(
    splitQueryWords(sanitizeQuery(query))
      .map((word) => word.replace(/["']/g, ''))
      .filter(Boolean),
  )];
}

/// מפרידי המילה של `sanitize_query` באוצריא — מקף עברי, מקף, קו אנכי
/// ופיסוק דבוק; מכאן ש`בית-דין` נספר כשתי מילים, כמו במנוע של אוצריא.
const wordSeparators = /[־\-|,;:!?(){}]/g;

/// תווים "שקופים" באוצריא: נבלעים בלי לשבור מילה ובלי להיכלל בה. `*` אינו
/// כאן — באוצריא הוא נמחק, ובהיברובוקס הוא תו כללי שגם "כל המילים" שולחת.
const transparentCharacters = /[[\]^$\\\+.~`\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/// סימן צמוד (ניקוד, טעם, combining) — ממשיך מילה אך אינו פותח אותה;
/// מקף, פסק, סוף-פסוק ונו"ן הפוכה הם פיסוק ושוברים מילה, ולכן אינם כאן.
const combiningMark = /[\u0300-\u036F\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\uFB1E]/u;
const alphanumeric = /[\p{Alphabetic}\p{N}]/u;

function sanitizeQuery(query: string): string {
  return query
    .replace(/[״“”]/g, '"')
    .replace(/[׳‘’]/g, "'")
    .replace(wordSeparators, ' ')
    .replace(transparentCharacters, '');
}

function startsWord(character: string): boolean {
  return alphanumeric.test(character) && !combiningMark.test(character);
}

function continuesWord(character: string): boolean {
  return alphanumeric.test(character) || combiningMark.test(character) || character === '*';
}

/// חלוקת המילים של `split_query_words` באוצריא: מילה נפתחת באות או בספרה,
/// וגרש/גרשיים בין אותיות נשארים בתוכה — `רמב"ם` היא מילה אחת, לא שתיים.
function splitQueryWords(text: string): string[] {
  const characters = [...text];
  const words: string[] = [];
  let start = 0;
  while (start < characters.length) {
    while (start < characters.length && !startsWord(characters[start] as string)) start += 1;
    if (start >= characters.length) break;
    let end = start;
    for (;;) {
      while (end < characters.length && continuesWord(characters[end] as string)) end += 1;
      const quoted = quoteRunEnd(characters, end);
      if (quoted === end || !continuesWord(characters[quoted] ?? '')) break;
      end = quoted;
    }
    words.push(characters.slice(start, end).join(''));
    start = end;
  }
  return words;
}

/// סוף רצף הגרשים שאחרי [end] כשהוא רצף פנימי — גרש בודד, זוג גרשים או
/// גרשיים בודדות; כל צירוף אחר מפריד, ואז מוחזר [end] עצמו.
function quoteRunEnd(characters: string[], end: number): number {
  let geresh = 0;
  let gershayim = 0;
  let position = end;
  while (position < characters.length && (characters[position] === '"' || characters[position] === "'")) {
    if (characters[position] === "'") geresh += 1;
    else gershayim += 1;
    position += 1;
  }
  const internal = (geresh <= 2 && gershayim === 0) || (geresh === 0 && gershayim === 1);
  return internal && position > end ? position : end;
}

function combinationCount(words: number, size: number): number {
  let count = 1;
  for (let step = 1; step <= size; step++) {
    count = (count * (words - size + step)) / step;
    if (count > maximumMatchCombinations) return maximumMatchCombinations + 1;
  }
  return count;
}

function combinations(words: string[], size: number): string[][] {
  if (size === 0) return [[]];
  const [first, ...rest] = words;
  if (first === undefined) return [];
  const withFirst = combinations(rest, size - 1).map((group) => [first, ...group]);
  return rest.length < size ? withFirst : [...withFirst, ...combinations(rest, size)];
}

export interface SearchOptions {
  proximity: number;
  fuzziness: number;
  max: number;
  limit: number;
  sort: 'hitcount' | 'bookname' | 'author' | 'place' | 'year' | 'id';
  corpus: Array<'pdf' | 'otzraya' | 'personal'>;
  compactCharClass: boolean;
  hybur: boolean;
  roots: boolean;
  gematria: boolean;
  spelling: boolean;
  numberGender: boolean;
  aramaic: boolean;
  rashetevot: boolean;
  firstWord: boolean;
  lastWord: boolean;
  requireWordOrder: boolean;
  rashiOcr: boolean;
}

export interface SearchSnapshot {
  /// השאילתה כפי שהיא נשלחת ל-hbsearch; בהתאמה חלקית היא שאילתת אופרטורים.
  query: string;
  /// טקסט המשתמש להצגה ולהדגשה, כשהוא שונה מהשאילתה שנשלחה.
  displayQuery?: string;
  /// מדיניות התאמה שאין לה תרגום ל-dtSearch: החיפוש נדחה עם ההודעה הזו,
  /// במקום לרוץ בשקט כשאילתה אחרת.
  unsupportedPolicy?: string;
  options: SearchOptions;
  fingerprint: string;
}

export interface HebrewBooksResult {
  fileId: string;
  bookName: string;
  authorName: string | null;
  printPlace: string | null;
  printYear: string | null;
  countPage: number | null;
  categories: string | null;
  sourceType: SourceType;
  relativePath: string | null;
  hitCount: number;
  firstHitPage: number | null;
}

export interface HebrewBooksSearchPage {
  results: HebrewBooksResult[];
  totalBooks: number;
  totalHits: number;
  truncated: boolean;
  /// אזהרות לא חוסמות מהשירות — אינדקס שנכשל מאחורי תוצאות שכן הגיעו.
  warnings: string[];
}

export interface InBookLocations {
  hitCount: number;
  pages: number[];
  matchedTerms: string[];
}

export interface ResultSnippet {
  page: number | null;
  text: string | null;
  lookupFailed?: boolean;
}

export interface HealthStatus {
  kind: 'onlineLegacy' | 'onlineFull';
  serverVersion: string | null;
}

export type HostSearchMode = 'exact' | 'advanced' | 'fuzzy';

export const hebrewBooksProvider = 'hebrewbooks' as const;

export interface HostBookIdentity {
  id?: number | null;
  bookId?: string;
  type?: 'text' | 'pdf' | 'docx' | 'epub' | 'external' | null;
  source?: 'library' | 'user' | 'external' | null;
  external?: { provider: 'hebrewbooks' | 'otzar'; id: number | string };
}

export interface HostSearchRequest {
  query: string;
  negativeQuery?: string;
  mode?: HostSearchMode;
  order?: 'relevance' | 'catalogue' | 'generation';
  limit?: number;
  offset?: number;
  distance?: number;
  proximityScope?: SearchProximityScope;
  grouping?: 'none' | 'sameSection' | 'identicalText';
  wordMatchMode?: SearchWordMatchMode;
  wordMatchCount?: number;
  /** אפשרויות החלות על כל מילות השאילתה; wordOptions גובר עליהן לכל מילה. */
  options?: Record<string, boolean>;
  wordOptions?: Record<string, Record<string, boolean>>;
  alternativeWords?: Record<string, string[]>;
  customSpacing?: Record<string, string>;
  negativeWordOptions?: Record<string, Record<string, boolean>>;
  negativeAlternativeWords?: Record<string, string[]>;
  negativeCustomSpacing?: Record<string, string>;
  facets?: string[];
}

export interface HostSearchRequestedEvent {
  itemId: string;
  request: HostSearchRequest;
}

/// בקשת חיפוש-בתוך-ספר מהקורא המובנה של אוצריא (התוסף רשום כספק).
export interface InBookSearchRequestedEvent {
  requestId: string;
  provider: typeof hebrewBooksProvider;
  externalId: number | string;
  query: string;
}

/// בקשת עמוד תוצאות ממסך החיפוש המובנה של אוצריא (התוסף רשום כספק
/// תוצאות חיצוני עם registerExternalSearchProvider).
///
/// כש-[ids] נשלח, העמוד המבוקש הוא הספרים הללו בסדרם (מתוך תוצאות החיפוש
/// שבמטמון) — כך אוצריא מדפדפת בתוצאות מסוננות-קטגוריה שהיא חישבה מהאינדקס.
export interface ExternalSearchRequestedEvent {
  requestId: string;
  provider: typeof hebrewBooksProvider;
  query: string;
  mode?: HostSearchMode;
  distance?: number;
  /// מדיניות ההתאמה של הטאב; מארח ותיק אינו שולח אותה (= מרווח מילים, כל המילים).
  proximityScope?: unknown;
  wordMatchMode?: unknown;
  wordMatchCount?: unknown;
  offset?: number;
  limit?: number;
  ids?: unknown;
  /// אפשרויות גלובליות (חלות על כל מילות השאילתה) — העדיפו אותן: מפתחות
  /// wordOptions נבנים לפי הטוקניזציה של מנוע אוצריא (מקף מפצל מילה).
  options?: Record<string, boolean>;
  /// אפשרויות פר-מילה של הטאב ('<מילה>_<אינדקס>'), בפורמט של search.requested.
  wordOptions?: Record<string, Record<string, boolean>>;
  /// המארח צורך שמות ספרים באינדקס (ומציג מהם את ספרי דלי "עוד מהיברובוקס").
  indexTitles?: boolean;
}

/// שורת תוצאה במדור החיצוני של טאב החיפוש המובנה.
export interface ExternalSearchResultPayload {
  title: string;
  meta?: string;
  snippet?: string;
  hitCount: number;
  firstPage?: number;
  externalId: number;
}

/// רשומת אינדקס בתשובה לחיפוש חיצוני: כלל התוצאות בתמצות — מזהה, מספר
/// מופעים, קטגוריית אוצריא המשוערת לפי תגיות הקטלוג של היברובוקס (אם יש),
/// ושם הספר. מיוצג כמערך כדי לחסוך בגודל: [id, hits], [id, hits, category]
/// או [id, hits, category, title] (קטגוריה ריקה כשיש שם בלי סיווג).
///
/// הצורה הרביעית נשלחת רק כשהבקשה נשאה `indexTitles` — מארח ותיק זורק
/// רשומה בת ארבעה איברים, ואיתה את כל הסיווג.
export type ExternalSearchIndexEntry =
  | [number, number]
  | [number, number, string]
  | [number, number, string, string];

export interface OtzariaSearchHit extends HostBookIdentity {
  book: string;
  categoryPath: string | null;
  reference: string;
  text: string;
  index: number;
  mergedCount: number;
}

export interface OtzariaSearchResponse {
  results: OtzariaSearchHit[];
  total: number;
  groupCount: number | null;
  truncated: boolean;
  limit: number;
  offset: number;
  facets: string[];
}

export type OtzariaSearchChunk = Omit<OtzariaSearchResponse, 'total'> & {
  sequence: number;
  total: number | null;
};

export interface ResolvedBook extends HostBookIdentity {
  title: string;
  categoryPath: string | null;
}

export type UnifiedSearchResult =
  | {
      source: 'otzaria';
      categoryPath: string;
      hit: OtzariaSearchHit;
    }
  | {
      source: 'hebrewbooks';
      categoryPath: string;
      hit: HebrewBooksResult;
    };

export interface UnifiedSearchCursor {
  otzariaOffset: number;
  hebrewBooksOffset: number;
  otzariaComplete: boolean;
  hebrewBooksComplete: boolean;
}

export interface UnifiedSearchResponse {
  results: UnifiedSearchResult[];
  otzariaTotal: number;
  hebrewBooksTotal: number;
  totalIsLowerBound?: boolean;
  truncated: boolean;
  warnings: string[];
  nextCursor: UnifiedSearchCursor | null;
}

export const defaultSearchOptions: SearchOptions = {
  proximity: 30,
  fuzziness: 0,
  max: 10_000,
  limit: 100,
  sort: 'hitcount',
  corpus: ['pdf'],
  compactCharClass: true,
  hybur: false,
  roots: false,
  gematria: false,
  spelling: false,
  numberGender: false,
  aramaic: false,
  rashetevot: false,
  firstWord: false,
  lastWord: false,
  requireWordOrder: false,
  rashiOcr: false,
};
