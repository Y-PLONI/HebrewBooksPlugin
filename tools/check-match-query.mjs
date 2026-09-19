// בדיקה חיה של שאילתת ההתאמה החלקית מול שירות hbsearch מקומי. אינה חלק מ-
// `npm run verify` (ל-CI אין שירות), ומריצים אותה ידנית כששינו את הבנאי:
//
//   node tools/check-match-query.mjs                      // כל המקרים, max האמיתי
//   node tools/check-match-query.mjs --max=5              // בדיקת תחביר מהירה
//   node tools/check-match-query.mjs --query="א ב ג" --mode=mostWords --scope=sameSection
//   node tools/check-match-query.mjs --url=http://127.0.0.1:8080 --timeout=90000
//   node tools/check-match-query.mjs --words="קדשנו במצותיו וצונו" --union-max=150000
//
// הכלי אינו מסתפק בקבלת השאילתה. על כל מקרה הוא בודק:
//
//   מבנה   — הדיסיונקציה היא בדיוק צירופי k המילים, כל w/N מסוגר עם מילה
//            בודדת מימינו (dtSearch דוחה w/N ששני צדדיו ביטויי טווח), k
//            תואם את requiredWordCount, ואין בשאילתה תו מיוחד או אופרטור.
//   זמן    — שאילתה שלא הסתיימה בתוך --timeout היא כישלון. `?` ו-`%` נמדדו
//            כתקועים לחלוטין, וקודם הם נספרו כהצלחה.
//   קבלה   — 200 בלי אירוע שגיאה; "0 תוצאות בלי שגיאה" בשאילתת אופרטורים
//            הוא דחיית תחביר שהשירות מחזיר כהצלחה ריקה.
//   נכונות — הספרים שהדיסיונקציה החזירה הם בדיוק איחוד הספרים של כל צירוף
//            בנפרד. צירוף שנדחה בשקט, או תו כללי שהתרחב, משנה את הקבוצה.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map((arg) => {
  const [flag, value] = arg.replace(/^--/, '').split('=');
  return [flag, value ?? 'true'];
}));
const endpoint = `${args.get('url') ?? 'http://127.0.0.1:8080'}/search`;
const maxOverride = args.has('max') ? Number(args.get('max')) : null;
const timeoutMs = args.has('timeout') ? Number(args.get('timeout')) : 60_000;

const { toHebrewBooksSnapshot } = await loadPluginModule('src/services/unified-search-service.ts');
const { requiredWordCount } = await loadPluginModule('src/models.ts');

const cases = args.has('query')
  ? [{
      title: 'מהשורה',
      request: {
        query: String(args.get('query')),
        wordMatchMode: args.get('mode') ?? 'mostWords',
        ...(args.has('count') ? { wordMatchCount: Number(args.get('count')) } : {}),
        ...(args.has('scope') ? { proximityScope: args.get('scope') } : {}),
      },
    }]
  : [
      { title: 'כל המילים (בלי אופרטורים)', request: { query: 'ברוך אתה השם אלוקינו' } },
      { title: 'מילה כלשהי', request: { query: 'ברוך אתה השם אלוקינו', wordMatchMode: 'anyWord' } },
      {
        title: '3 מתוך 4 מילים',
        request: { query: 'ברוך אתה השם אלוקינו', wordMatchMode: 'atLeast', wordMatchCount: 3 },
      },
      {
        title: 'רוב מתוך 5 מילים (התקרה)',
        request: { query: 'ברוך אתה השם אלוקינו מלך', wordMatchMode: 'mostWords' },
      },
      {
        title: 'מקף מפצל מילה — 3 מתוך 4, לא 2 מתוך 3',
        request: { query: 'בית-דין שלום עולם', wordMatchMode: 'mostWords' },
      },
      {
        title: 'רוב מתוך 8 מילים (מעל התקרה — אמור להידחות בתוסף)',
        request: { query: 'ברוך אתה השם אלוקינו מלך העולם אשר קדשנו', wordMatchMode: 'mostWords' },
        refusal: 'אינו נתמך',
      },
      {
        title: 'תו מיוחד של dtSearch (אמור להידחות בתוסף)',
        request: { query: 'זזזזזזזז * שלום', wordMatchMode: 'mostWords' },
        refusal: 'תו מיוחד',
      },
      {
        title: 'תחת אותה כותרת (אמור להידחות בתוסף)',
        request: { query: 'ברוך אתה השם', wordMatchMode: 'mostWords', proximityScope: 'sameSection' },
        refusal: 'אינו נתמך בהיברובוקס',
      },
      {
        title: 'הרחבת כתיב בהתאמה חלקית (אמורה להידחות בתוסף)',
        request: {
          query: 'ברוך אתה השם',
          wordMatchMode: 'mostWords',
          options: { 'כתיב מלא/חסר': true },
        },
        refusal: 'אינו מרחיב',
      },
    ];

let failures = 0;
for (const entry of cases) await runCase(entry);
if (!args.has('query')) await checkDisjunctionIsTheUnion();

console.log(`\n${failures === 0 ? 'כל הבדיקות עברו' : `${failures} בדיקות נכשלו`}`);
process.exitCode = failures === 0 ? 0 : 1;

function report(name, ok, detail) {
  if (ok === null) return void console.log(`  ○ ${name}: ${detail} (לא מכריע)`);
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
}

async function runCase({ title, request, refusal }) {
  const snapshot = toHebrewBooksSnapshot(request);
  console.log(`\n■ ${title}`);
  if (refusal !== undefined) {
    const message = snapshot.unsupportedPolicy ?? '';
    return void report('סירוב', message.includes(refusal), message === '' ? 'התוסף לא סירב' : message);
  }
  if (snapshot.unsupportedPolicy !== undefined) {
    return void report('סירוב', false, `סירוב לא צפוי: ${snapshot.unsupportedPolicy}`);
  }
  // displayQuery נשלח רק כששאילתת האופרטורים החליפה את מילות המשתמש.
  const operator = snapshot.displayQuery !== undefined;
  console.log(`  q = ${trim(snapshot.query)}`);
  if (operator) reportStructure(snapshot.query, request);

  const options = maxOverride === null
    ? snapshot.options
    : { ...snapshot.options, max: maxOverride, limit: maxOverride };
  const run = await runSearch(snapshot.query, options);
  report('זמן', !run.timedOut, run.timedOut
    ? `לא הסתיים בתוך ${timeoutMs} מ"ש`
    : `${run.ms} מ"ש`);
  if (run.timedOut) return;
  const silentlyEmpty = operator && run.complete === 0 && run.errors.length === 0;
  report('קבלה', run.status === 200 && run.errors.length === 0 && !silentlyEmpty, silentlyEmpty
    ? 'אפס תוצאות בלי אירוע שגיאה — דחיית תחביר שהוחזרה כהצלחה'
    : `status ${run.status} · ${run.complete} תוצאות · max=${options.max}`
      + `${run.errors.length > 0 ? ` · שגיאות: ${run.errors.join(' | ')}` : ' · בלי אירועי שגיאה'}`);
}

/// השאילתה שנבנתה היא בדיוק "לפחות k מתוך n", בצורה ש-dtSearch מקבל.
function reportStructure(query, request) {
  const groups = query.split(' or ');
  const parsed = groups.map(parseGroup);
  const broken = groups.find((group, index) => parsed[index] === null);
  if (broken !== undefined) {
    return void report('מבנה', false, `צירוף שאינו w/N מסוגר עם מילה בודדת מימינו: ${broken}`);
  }
  const sizes = new Set(parsed.map((words) => words.length));
  const all = [...new Set(parsed.flat())];
  const required = parsed[0].length;
  const keys = parsed.map((words) => [...words].sort().join('|'));
  const expected = subsets(all, required).map((words) => [...words].sort().join('|'));
  const spec = requiredWordCount(all.length, request.wordMatchMode, request.wordMatchCount);
  const suspicious = all.find((word) => /[*?~%#&=:]/.test(word) && !/[\p{Alphabetic}\p{N}]/u.test(word))
    ?? all.find((word) => /^(?:and|or|not|contains|xfilter|(?:w|pre)\/\d+)$/i.test(word))
    ?? all.find((word) => /[\s־\-|,;(){}"']/.test(word));

  if (sizes.size !== 1) return void report('מבנה', false, `צירופים בגדלים שונים: ${[...sizes]}`);
  if (suspicious !== undefined) return void report('מבנה', false, `מילה פסולה בשאילתה: ${suspicious}`);
  if (required !== spec) return void report('מבנה', false, `נדרשו ${required} מילים במקום ${spec}`);
  if (new Set(keys).size !== keys.length) return void report('מבנה', false, 'צירוף כפול');
  if (new Set(keys).size !== expected.length || expected.some((key) => !keys.includes(key))) {
    return void report('מבנה', false, `${keys.length} צירופים במקום ${expected.length}`);
  }
  report('מבנה', true, `${keys.length} צירופים של ${required} מתוך ${all.length} מילים`);
}

/// מילות הצירוף אם צורתו חוקית: `(שמאל w/N מילה)` רקורסיבית, או מילה בודדת.
function parseGroup(group) {
  const nested = /^\((.+) w\/\d+ ([^\s()]+)\)$/.exec(group);
  if (nested === null) return /^[^\s()]+$/.test(group) ? [group] : null;
  const left = parseGroup(nested[1]);
  return left === null ? null : [...left, nested[2]];
}

function subsets(words, size) {
  if (size === 0) return [[]];
  const [first, ...rest] = words;
  if (first === undefined) return [];
  const withFirst = subsets(rest, size - 1).map((group) => [first, ...group]);
  return rest.length < size ? withFirst : [...withFirst, ...subsets(rest, size)];
}

/// בדיקת הנכונות: הספרים שהדיסיונקציה מחזירה הם בדיוק איחוד הספרים של כל
/// צירוף בנפרד. צירוף שנדחה בשקט גורע ספרים, ותו כללי שהתרחב מוסיף ספרים.
async function checkDisjunctionIsTheUnion() {
  const query = args.get('words') ?? 'אלוקינו מלך העולם';
  const request = { query, wordMatchMode: 'atLeast', wordMatchCount: 2 };
  const snapshot = toHebrewBooksSnapshot(request);
  console.log(`\n■ נכונות: "${query}", לפחות 2 מתוך 3`);
  if (snapshot.unsupportedPolicy !== undefined) {
    return void report('נכונות', false, `סירוב לא צפוי: ${snapshot.unsupportedPolicy}`);
  }
  // max משלו: בדיקת הקבוצות חסרת ערך כשאחת השאילתות נחתכה בתקרה.
  const options = { ...snapshot.options, max: Number(args.get('union-max') ?? 150_000) };
  const groups = snapshot.query.split(' or ');
  const whole = await runSearch(snapshot.query, options);
  if (whole.timedOut) return void report('נכונות', false, `הדיסיונקציה לא הסתיימה בתוך ${timeoutMs} מ"ש`);

  const union = new Set();
  for (const group of groups) {
    const part = await runSearch(group, options);
    if (part.timedOut) return void report('נכונות', false, `הצירוף ${group} לא הסתיים`);
    if (part.complete >= options.max) return void report('נכונות', null, `${group} מילא את max`);
    for (const id of part.ids) union.add(id);
  }
  if (whole.complete >= options.max) return void report('נכונות', null, 'הדיסיונקציה מילאה את max');

  const missing = [...union].filter((id) => !whole.ids.has(id));
  const extra = [...whole.ids].filter((id) => !union.has(id));
  report('נכונות', missing.length === 0 && extra.length === 0,
    missing.length === 0 && extra.length === 0
      ? `${whole.ids.size} ספרים — בדיוק איחוד ${groups.length} הצירופים`
      : `חסרים ${missing.length} ספרים, ועודפים ${extra.length}`);
}

/// הבדיקה חייבת לשלוח את המחרוזת שהקוד באמת פולט, ולכן היא מתרגמת את
/// המקור עצמו ולא משכפלת את הבנאי.
async function loadPluginModule(entry) {
  const bundle = await build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
  });
  const code = bundle.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/// אותו גוף בקשה שהמאגר שולח: limit מוחלף ב-max, וזרם v2. שאילתה שלא
/// הסתיימה בתוך [timeoutMs] נקטעת ומדווחת כ-timedOut, ולא כאפס תוצאות.
async function runSearch(q, options) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const errors = [];
  const ids = new Set();
  let complete = null;
  let status = 0;
  let timedOut = false;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ q, ...options, limit: options.max, streamVersion: 2 }),
      signal: controller.signal,
    });
    status = response.status;
    let pending = '';
    for await (const chunk of response.body) {
      const lines = (pending + Buffer.from(chunk).toString('utf8')).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'result') ids.add(String(event.result?.fileId ?? ids.size));
        else if (event.type === 'error') errors.push(event.message ?? JSON.stringify(event));
        else if (event.type === 'complete') complete = event.count ?? null;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) timedOut = true;
    else errors.push(String(error?.message ?? error));
  } finally {
    clearTimeout(timer);
  }
  return { status, ms: Date.now() - started, ids, complete, errors, timedOut };
}

function trim(query) {
  return query.length > 160 ? `${query.slice(0, 160)}… (${query.length} תווים)` : query;
}
