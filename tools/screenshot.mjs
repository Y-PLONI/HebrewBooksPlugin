/* צילום מסך של התוסף דרך Chrome DevTools Protocol.
   headless עם --virtual-time-budget אינו מריץ Web Workers, ולכן קורא ה-PDF
   (שרץ ב-worker של pdf.js) לא היה מסיים לטעון. כאן ממתינים בזמן אמת.

   הרצה:  node tools/screenshot.mjs <url> <out.png> [width] [height] [waitMs] */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, output, width = '1400', height = '900', waitMs = '5000'] = process.argv.slice(2);
if (!url || !output) {
  console.error('שימוש: node tools/screenshot.mjs <url> <out.png> [width] [height] [waitMs]');
  process.exit(1);
}

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'otzaria-preview-'));
const port = 9333 + Math.floor(Number(process.pid) % 200);

const child = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--force-device-scale-factor=1',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  `--window-size=${width},${height}`,
  'about:blank',
], { stdio: 'ignore' });

try {
  const target = await waitForTarget(port);
  const socket = new WebSocket(target);
  await once(socket, 'open');

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolvePromise) => {
      const id = nextId++;
      pending.set(id, resolvePromise);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(width),
    height: Number(height),
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, Number(waitMs)));
  const log = await send('Runtime.evaluate', {
    expression: "document.getElementById('preview-log')?.textContent ?? ''",
    returnByValue: true,
  });
  const text = log?.result?.value ?? '';
  if (text.trim().length > 0) console.error(`יומן הדף:\n${text}`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(output, Buffer.from(shot.data, 'base64'));
  console.log(`נשמר ${output}`);
  socket.close();
} finally {
  child.kill();
}

async function waitForTarget(debugPort) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((entry) => entry.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // הדפדפן עוד עולה
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('הדפדפן לא נפתח');
}

function once(socket, type) {
  return new Promise((resolvePromise) => socket.addEventListener(type, resolvePromise, { once: true }));
}
