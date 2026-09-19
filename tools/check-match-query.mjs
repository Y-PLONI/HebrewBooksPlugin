// בדיקה חיה של שאילתת ההתאמה החלקית מול שירות hbsearch מקומי. אינה חלק מ-
// `npm run verify` (ל-CI אין שירות), ומריצים אותה ידנית כששינו את הבנאי:
//
//   node tools/check-match-query.mjs                      // כל המקרים, max האמיתי
//   node tools/check-match-query.mjs --max=5              // בדיקת תחביר מהירה
//   node tools/check-match-query.mjs --query="א ב ג" --mode=mostWords --scope=sameSection
//   node tools/check-match-query.mjs --url=http://127.0.0.1:8080
//
// dtSearch דוחה w/N ששני צדדיו ביטויי טווח, והשירות מחזיר את הדחייה כ-200
// עם אפס תוצאות ובלי אירוע שגיאה. לכן "0 תוצאות" בשורה שאמורה להחזיר ספרים
// הוא כישלון תחביר, ולא חיפוש שלא מצא.

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

const { toHebrewBooksSnapshot } = await loadPluginModule('src/services/unified-search-service.ts');

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
        title: 'רוב מתוך 5 מילים, תחת אותה כותרת',
        request: {
          query: 'ברוך אתה השם אלוקינו מלך',
          wordMatchMode: 'mostWords',
          proximityScope: 'sameSection',
        },
      },
      {
        title: 'רוב מתוך 8 מילים (מעל התקרה — אמור להידחות בתוסף)',
        request: { query: 'ברוך אתה השם אלוקינו מלך העולם אשר קדשנו', wordMatchMode: 'mostWords' },
      },
    ];

let failures = 0;
for (const { title, request } of cases) {
  const snapshot = toHebrewBooksSnapshot(request);
  if (snapshot.unsupportedPolicy !== undefined) {
    console.log(`\n■ ${title}\n  התוסף סירב: ${snapshot.unsupportedPolicy}`);
    continue;
  }
  const options = maxOverride === null
    ? snapshot.options
    : { ...snapshot.options, max: maxOverride, limit: maxOverride };
  const report = await runSearch(snapshot.query, options);
  // רק שאילתת אופרטורים נבדקת כך: שאילתה רגילה עשויה באמת לא למצוא דבר.
  const rejected = snapshot.query.includes(' w/')
    && report.complete === 0
    && report.errors.length === 0;
  if (rejected) failures += 1;
  console.log(`\n■ ${title}\n  q = ${trim(snapshot.query)}`);
  console.log(
    `  status ${report.status} · ${report.ms} ms · ${report.results} תוצאות`
    + ` · complete=${report.complete} · max=${options.max}`
    + `${report.errors.length > 0 ? ` · שגיאות: ${report.errors.join(' | ')}` : ' · בלי אירועי שגיאה'}`
    + `${rejected ? '  ← אפס תוצאות בלי שגיאה: חשוד כדחיית תחביר' : ''}`,
  );
}
console.log(`\n${failures === 0 ? 'הכול התקבל' : `${failures} שאילתות חזרו ריקות בלי שגיאה`}`);
process.exitCode = failures === 0 ? 0 : 1;

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

/// אותו גוף בקשה שהמאגר שולח: limit מוחלף ב-max, וזרם v2.
async function runSearch(q, options) {
  const started = Date.now();
  const errors = [];
  let results = 0;
  let complete = null;
  let status = 0;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ q, ...options, limit: options.max, streamVersion: 2 }),
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
        if (event.type === 'result') results += 1;
        else if (event.type === 'error') errors.push(event.message ?? JSON.stringify(event));
        else if (event.type === 'complete') complete = event.count ?? null;
      }
    }
  } catch (error) {
    errors.push(String(error?.message ?? error));
  }
  return { status, ms: Date.now() - started, results, complete, errors };
}

function trim(query) {
  return query.length > 160 ? `${query.slice(0, 160)}… (${query.length} תווים)` : query;
}
