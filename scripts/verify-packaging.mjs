import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [dependenciesText, installer, workflow, launcher] = await Promise.all([
  readFile(resolve(root, 'installer/dependencies.json'), 'utf8'),
  readFile(resolve(root, 'installer/HebrewBooksPlugin.iss'), 'utf8'),
  readFile(resolve(root, '.github/workflows/release.yml'), 'utf8'),
  readFile(resolve(root, 'installer/Install-OtzariaPlugin.ps1'), 'utf8'),
]);
const dependencies = JSON.parse(dependenciesText);

assert(
  dependencies.runtime.url ===
    'https://github.com/HebrewBooks-2026/Hebrewbooks-Releases/releases/download/prerequisites/hbsearch-min.zip',
  'The installer must use the official HebrewBooks runtime asset.',
);
assertSha256(dependencies.runtime.sha256, 'runtime');
assertSha256(dependencies.serviceWrapper.sha256, 'service wrapper');
assert(
  installer.includes('ConfigPath := ExpandConstant(\'{app}\\{#ServiceBaseName}.xml\')'),
  'The WinSW executable and XML configuration must share a base name.',
);
assert(
  installer.includes('--serve --port 8080 --data-root'),
  'The service must start hbsearch in HTTP server mode with an explicit data root.',
);
assert(
  installer.includes('Flags: postinstall runhidden nowait skipifsilent runasoriginaluser'),
  'The Otzaria launcher must run as the installing desktop user.',
);
// WinSW קורא את קובץ ה-XML כ-UTF-8. SaveStringToFile כותב ב-ANSI לפי ה-code
// page של המערכת ושובר כל נתיב לא-לטיני (למשל שם משתמש בעברית).
assert(
  installer.includes('SaveStringsToUTF8File(ConfigPath, Lines, False)') &&
    !installer.includes('SaveStringToFile('),
  'The WinSW configuration must be written as UTF-8, never as ANSI.',
);
assert(
  launcher.includes('otzaria://plugin/install-local?path='),
  'The launcher must use Otzaria local plugin installation deep link.',
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

function assertSha256(value, label) {
  assert(
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    `Invalid ${label} SHA-256.`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
