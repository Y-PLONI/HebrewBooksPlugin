import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, 'assets'), { recursive: true });
await mkdir(resolve(dist, 'assets/fonts'), { recursive: true });
await mkdir(resolve(dist, 'vendor'), { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(dist, 'assets/app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  legalComments: 'none',
});

await cp(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
await cp(resolve(root, 'index.html'), resolve(dist, 'index.html'));
await cp(resolve(root, 'src/styles.css'), resolve(dist, 'styles.css'));
await cp(resolve(root, 'assets/fonts'), resolve(dist, 'assets/fonts'), { recursive: true });
await cp(
  resolve(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
  resolve(dist, 'vendor/pdf.worker.min.mjs'),
);
const license = await readFile(resolve(root, 'node_modules/pdfjs-dist/LICENSE'), 'utf8');
await writeFile(resolve(dist, 'vendor/LICENSE-pdfjs.txt'), license);
