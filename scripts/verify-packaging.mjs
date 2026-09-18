import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [dependenciesText, installer, workflow, launcher, prepare, manifestText, packageText] = await Promise.all([
  readFile(resolve(root, 'installer/dependencies.json'), 'utf8'),
  readFile(resolve(root, 'installer/HebrewBooksPlugin.iss'), 'utf8'),
  readFile(resolve(root, '.github/workflows/release.yml'), 'utf8'),
  readFile(resolve(root, 'installer/Install-OtzariaPlugin.ps1'), 'utf8'),
  readFile(resolve(root, 'installer/Prepare-Installer.ps1'), 'utf8'),
  readFile(resolve(root, 'manifest.json'), 'utf8'),
  readFile(resolve(root, 'package.json'), 'utf8'),
]);
const dependencies = JSON.parse(dependenciesText);

// Otzaria refuses to install a plugin whose version already sits in its plugin
// folder — "התוסף כבר מותקן בגרסה זו". Shipping a fix under the version it
// fixes leaves the broken copy installed and looks like the fix did nothing.
const manifestVersion = JSON.parse(manifestText).version;
assert(
  /^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifestVersion),
  'manifest.json must carry an X.Y.Z version — the release takes its tag from it.',
);
assert(
  JSON.parse(packageText).version === manifestVersion,
  'package.json and manifest.json must agree on the version.',
);

assert(
  dependencies.runtime.release?.repo === 'Y-PLONI/hbsearch' &&
    dependencies.runtime.release.asset === 'hbsearch-win-x86.zip',
  'The installer must take the search runtime from the official service repository.',
);
assert(
  dependencies.runtime.url === undefined,
  'A hardcoded runtime URL would bypass the release the installer is pinned to.',
);
// That release is rebuilt on every push to the service, so a checksum pinned here
// would go stale within a day and either fail every build or be ignored. The
// integrity check belongs against the digest GitHub recorded for the asset.
assert(
  dependencies.runtime.sha256 === undefined &&
    prepare.includes('gh release view') &&
    prepare.includes('Runtime checksum mismatch'),
  'The runtime archive must be verified against the digest GitHub recorded for it.',
);
assert(
  workflow.includes('secrets.ANGINE_PRIVATE'),
  'The installer build must authenticate to the private service repository.',
);
// dtSearch is loaded by filename at run time, so a runtime missing any of these
// produces a service that starts and then fails every search.
assert(
  ['hbsearch.exe', 'dtSearchNetApi4.dll', 'dten600.dll', 'lbvProt.dll', 'Alphabet.abc',
    'msvcp140.dll', 'vcruntime140.dll'].every((name) => prepare.includes(`'${name}'`)),
  'The installer must reject a runtime archive that is missing any dtSearch component.',
);
assertSha256(dependencies.serviceWrapper.sha256, 'service wrapper');
assert(
  installer.includes('ConfigPath := ExpandConstant(\'{app}\\{#ServiceBaseName}.xml\')'),
  'The WinSW executable and XML configuration must share a base name.',
);
// hbsearch רץ כ-LocalSystem עם CORS פתוח: האזנה מחוץ ל-loopback חושפת חיפוש,
// גזירים, PDF-ים ונתיבי כוננים לכל הרשת, ללא אימות.
const serviceCommands = [...installer.matchAll(/<arguments>([\s\S]*?)<\/arguments>/g)].map(([, value]) => value);
assert(
  serviceCommands.length > 0 &&
    serviceCommands.length === (installer.match(/<arguments>/g) ?? []).length,
  'Every service <arguments> block must be closed, or its command line cannot be checked in full.',
);
assert(
  serviceCommands.every((command) => {
    const listeners = listenAddresses(command);
    return /--serve\b/.test(command) && listeners.length > 0 && listeners.every(isLoopbackAddress) &&
      /--port(?:\s*=\s*|\s+)8080\b/.test(command) && /--data-root\b/.test(command);
  }),
  'The service must start hbsearch in HTTP server mode, confined to loopback, with an explicit data root.',
);
assert(
  !/(?<![\d.])0\.0\.0\.0(?![\d.])|http:\/\/\+|--listen(?:\s*=\s*|\s+)["']?(?:\*|\+|::|0(?::0){7})(?![\w:.])/.test(installer),
  'The service must never bind to a wildcard or unspecified address.',
);
// חימום אינדקס של עשרות GB בכונן USB הוא החלק האטי, ולכן הוא מתחיל באתחול ולא
// אחרי שהמשתמש כבר פתח את אוצריא. Windows שומר שלוש פעולות כשל בלבד.
assert(
  !installer.includes('delayedAutoStart') &&
    (installer.match(/<onfailure /g) ?? []).length === 3,
  'The service must start at boot, with all three Windows failure actions spelled out.',
);
assert(
  installer.includes(
    'Flags: postinstall runhidden waituntilterminated skipifsilent runasoriginaluser',
  ),
  'The Otzaria launcher must run as the installing desktop user.',
);
// WinSW קורא את קובץ ה-XML כ-UTF-8. SaveStringToFile כותב ב-ANSI לפי ה-code
// page של המערכת ושובר כל נתיב לא-לטיני (למשל שם משתמש בעברית).
assert(
  installer.includes('SaveStringsToUTF8File(ConfigPath, Lines, False)') &&
    !installer.includes('SaveStringToFile('),
  'The WinSW configuration must be written as UTF-8, never as ANSI.',
);
// Windows PowerShell 5.1 — what the installer's [Run] entry invokes — reads a
// script without a byte-order mark in the system ANSI code page, not UTF-8. On a
// Hebrew Windows that turns every Hebrew string literal into a parse error, so
// the script dies before its first statement: no plugin, no log, no message.
for (const [name, text] of [['Install-OtzariaPlugin.ps1', launcher], ['Prepare-Installer.ps1', prepare]]) {
  assert(
    !/[^\0-\x7F]/.test(text) || text.startsWith('﻿'),
    `${name} contains non-ASCII text and must be saved with a UTF-8 BOM.`,
  );
}

assert(
  launcher.includes('otzaria://plugin/install-local?path='),
  'The launcher must use Otzaria local plugin installation deep link.',
);
// הפעלה ישירה של otzaria.exe היא המסלול הראשי — היא עובדת גם כשפרוטוקול
// otzaria:// אינו רשום, ובניגוד ל-ShellExecute היא מדווחת על כישלון.
assert(
  launcher.includes('Get-OtzariaExecutable') && launcher.includes('Start-Process -FilePath'),
  'The launcher must locate otzaria.exe and launch it directly before falling back to the deep link.',
);
assert(
  launcher.includes('Show-Message'),
  'The launcher must tell the user when the plugin could not be handed to Otzaria.',
);
assert(workflow.includes('push:'), 'The installer must be built on every pushed commit.');
assert(
  workflow.includes('Otzaria/otzaria-plugin-validator@v1'),
  'Main releases must use the official Otzaria validator and store publisher.',
);
assert(
  workflow.includes("needs.release-check.outputs.should_publish == 'true'"),
  'A version must not be published twice.',
);
assert(
  workflow.includes('build-input/build/plugin') && workflow.includes('steps.plugin.outputs.file'),
  'The GitHub Release must upload the packaged plugin artifact directly.',
);
assert(
  workflow.includes("github.ref == 'refs/heads/main'"),
  'Store publication must be limited to main.',
);

// ערך <arguments> נבנה בשרשור רב-שורתי, ולכן נבדק כל --listen שבו ולא רק אלה שבשורה הראשונה.
function listenAddresses(command) {
  const text = command.replace(/&quot;/g, '"');
  return [...text.matchAll(/--listen(?:\s*=\s*|\s+)["']?([^\s"'<]+?)["']?(?=[\s"'<]|$)/g)]
    .map(([, address]) => address);
}

// מקבל 127.0.0.1, 127.1, ::1, localhost, וכן צורות עם פורט, סוגריים, גרשיים או =.
function isLoopbackAddress(address) {
  const bracketed = address.match(/^\[([^\]]+)\](?::[0-9]+)?$/);
  let host = (bracketed ? bracketed[1] : address).toLowerCase();
  if ((host.match(/:/g) ?? []).length === 1) host = host.replace(/:[0-9]+$/, '');
  const mapped = host.match(/^::ffff:(.+)$/);
  if (mapped) host = mapped[1];
  return host === 'localhost' || /^127(?:\.[0-9]{1,3}){0,3}$/.test(host) ||
    /^(?:::1|(?:0:){7}1)$/.test(host);
}

function assertSha256(value, label) {
  assert(
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    `Invalid ${label} SHA-256.`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
