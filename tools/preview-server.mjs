/* שרת תצוגה מקדימה לתוסף — מגיש את dist/ יחד עם שירות hbsearch מדומה,
   כדי לבדוק את המסכים בדפדפן בלי אוצריא ובלי השירות האמיתי.

   הרצה:  node tools/preview-server.mjs [port]
   ואז:   http://127.0.0.1:8080/?screen=results        (או library / dialog / viewer)
          http://127.0.0.1:8080/?screen=viewer&mode=dark

   הפורט הוא 8080 בכוונה — זו הכתובת שהתוסף פונה אליה בפועל, כך שגם קובץ
   ה-PDF נטען דרך אותו origin. */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const dist = join(root, 'dist');
const port = Number(process.argv[2] ?? 8080);

const books = [
  { fileId: '14424', bookName: 'שולחן ערוך אורח חיים עם באר הגולה', authorName: 'קארו, יוסף בן אפרים', printPlace: 'ווילנא', printYear: 'תר״ם', countPage: 512, hitCount: 214 },
  { fileId: '9021', bookName: 'שו״ת נודע ביהודה — מהדורא תניינא', authorName: 'לנדא, יחזקאל בן יהודה', printPlace: 'פראג', printYear: 'תקע״א', countPage: 288, hitCount: 87 },
  { fileId: '20194', bookName: 'ליקוטי מוהר״ן', authorName: 'נחמן מברסלב', printPlace: 'אוסטרהא', printYear: 'תקס״ח', countPage: 196, hitCount: 42 },
  { fileId: '31855', bookName: 'ערוך השולחן על הלכות שבת', authorName: 'אפשטיין, יחיאל מיכל', printPlace: 'ווארשא', printYear: 'תרנ״ד', countPage: 640, hitCount: 31 },
  { fileId: '40077', bookName: 'ספר חסידים', authorName: 'יהודה בן שמואל החסיד', printPlace: 'לבוב', printYear: 'תרל״ב', countPage: 154, hitCount: 12 },
];

const types = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.mjs': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;
  console.log(`${request.method} ${path}`);

  try {
    if (path === '/health') {
      return json(response, {
        ok: true,
        service: 'hbsearch',
        apiVersion: 2,
        capabilities: ['pdf-range'],
        serverVersion: '0.0-preview',
      });
    }

    if (path === '/search') {
      const body = await collect(request);
      const query = JSON.parse(body || '{}');
      const limit = Number(query.limit ?? 100);
      const lines = books
        .slice(0, Math.min(limit, books.length))
        .map((book) => JSON.stringify({ ...book, sourceType: 'PDF', categories: null, relativePath: null }));
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=UTF-8' });
      return response.end(lines.join('\n'));
    }

    if (path === '/inbook') {
      await collect(request);
      return json(response, { hitCount: 24, pages: [2, 3, 5, 6, 8], matchedTerms: ['שבת'] });
    }

    if (path.startsWith('/pdf/')) {
      const pdf = await readFile(join(root, 'tools/sample.pdf'));
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Accept-Ranges': 'none' });
      return response.end(pdf);
    }

    if (path === '/__preview/stub.js') {
      return send(response, await readFile(join(root, 'tools/preview-stub.js')), '.js');
    }

    if (path === '/__preview/book-font.ttf') {
      const font = '/Users/david/Documents/otzaria-software/otzaria/fonts/FrankRuehlCLM-Medium.ttf';
      return send(response, await readFile(font), '.ttf');
    }

    if (path === '/' || path === '/index.html') {
      const html = await readFile(join(dist, 'index.html'), 'utf8');
      const patched = html.replace(
        '<script src="assets/app.js"></script>',
        '<script src="/__preview/stub.js"></script>\n    <script src="assets/app.js"></script>',
      );
      return send(response, patched, '.html');
    }

    return send(response, await readFile(join(dist, path.slice(1))), extname(path));
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
    response.end(`לא נמצא: ${path}\n${String(error)}`);
  }
});

function send(response, body, extension) {
  response.writeHead(200, { 'Content-Type': types[extension] ?? 'application/octet-stream' });
  response.end(body);
}

function json(response, value) {
  send(response, JSON.stringify(value), '.json');
}

function collect(request) {
  return new Promise((resolvePromise) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolvePromise(body));
  });
}

server.listen(port, '127.0.0.1', () => {
  console.log(`תצוגה מקדימה: http://127.0.0.1:${port}/?screen=results`);
});
