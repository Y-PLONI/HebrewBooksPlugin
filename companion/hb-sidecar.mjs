#!/usr/bin/env node
/// רכיב נלווה (sidecar) לשרת hbsearch — משלים את הרחבת ה־PDF שמוגדרת
/// ב־IMPLEMENTATION_SPEC.md סעיפים 13.2–13.4 עד שההרחבה תמומש בשרת עצמו.
///
/// מאזין על 127.0.0.1:8080 (הכתובת היחידה שהתוסף מורשה אליה) ו:
///   * מגיש GET/HEAD/OPTIONS /pdf/<fileId> עם תמיכת Range מלאה.
///   * מעשיר את /health ב־apiVersion:2 ו־capabilities כולל pdf-range.
///   * מעביר כל בקשה אחרת (search/inbook/...) כמו־שהיא אל hbsearch בפורט 8081.
///
/// אין תלויות חיצוניות — Node בלבד.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = Number(process.env.HB_SIDECAR_PORT ?? 8080);
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.HB_UPSTREAM_PORT ?? 8081);
const PDFS_ROOT = path.resolve(process.env.HB_PDFS_ROOT ?? 'C:\\HebrewBooks\\Books');
const SIDECAR_VERSION = '0.1.0';

// fileId קנוני: מספר שלם חיובי בלי אפסים מובילים (סעיף 13.2).
const CANONICAL_ID = /^[1-9][0-9]{0,11}$/;

const log = (...parts) => console.error(new Date().toISOString(), ...parts);

/// CORS מותר רק כש־Origin הוא null או לא נשלח (WebView של התוסף); כל origin
/// אינטרנטי נדחה (סעיף 13.2). loopback binding הוא ההגנה העיקרית, לא ה־CORS.
function corsDecision(request) {
  const origin = request.headers.origin;
  return origin === undefined || origin === 'null';
}

function pdfBaseHeaders(fileId, stat, allowCors) {
  return {
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename="${fileId}.pdf"`,
    'Last-Modified': stat.mtime.toUTCString(),
    // ETag חלש מגודל+זמן שינוי; אין לחשב hash של הקובץ (סעיף 13.2).
    ETag: `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`,
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Access-Control-Expose-Headers':
      'Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified',
    ...(allowCors ? { 'Access-Control-Allow-Origin': '*' } : {}),
  };
}

/// טווח יחיד בלבד; multi-range אינו נדרש ל־PDF.js (סעיף 13.3).
/// מחזיר null כשאין Range, אובייקט {start,end} לטווח תקין, או 'unsatisfiable'.
function parseRange(header, size) {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'unsatisfiable';
  if (match[1] === '') {
    // suffix range: bytes=-N — N הבתים האחרונים.
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Number(match[2]);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

async function servePdf(request, response, fileId, allowCors) {
  if (!CANONICAL_ID.test(fileId)) {
    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'invalid fileId' }));
    return;
  }
  // פתרון נתיב שמרני: רק <id>.pdf ישירות תחת PdfsRoot, בלי path מהבקשה (13.3).
  const resolved = path.resolve(PDFS_ROOT, `${fileId}.pdf`);
  const underRoot = resolved.toLowerCase().startsWith(PDFS_ROOT.toLowerCase() + path.sep);
  let stat = null;
  if (underRoot && resolved.toLowerCase().endsWith('.pdf')) {
    try {
      const candidate = await fsp.stat(resolved);
      if (candidate.isFile()) stat = candidate;
    } catch {
      stat = null;
    }
  }
  if (stat === null) {
    // 404 ללא חשיפת נתיב (13.2).
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const headers = pdfBaseHeaders(fileId, stat, allowCors);
  const range = parseRange(request.headers.range, stat.size);
  if (range === 'unsatisfiable') {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
    response.end();
    return;
  }

  const start = range === null ? 0 : range.start;
  const end = range === null ? stat.size - 1 : range.end;
  const length = end - start + 1;
  const status = range === null ? 200 : 206;
  const responseHeaders = { ...headers, 'Content-Length': String(length) };
  if (range !== null) {
    responseHeaders['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  if (request.method === 'HEAD') {
    response.writeHead(status, responseHeaders);
    response.end();
    return;
  }
  response.writeHead(status, responseHeaders);
  const stream = fs.createReadStream(resolved, { start, end, highWaterMark: 128 * 1024 });
  stream.pipe(response);
  response.on('close', () => stream.destroy());
  stream.on('error', (error) => {
    log('pdf stream error', fileId, error.message);
    response.destroy();
  });
}

/// /health מהשרת האמיתי, מועשר לפי חוזה סעיף 13.4.
function serveHealth(request, response) {
  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: '/health', method: 'GET', timeout: 5000 },
    (upstreamResponse) => {
      const chunks = [];
      upstreamResponse.on('data', (chunk) => chunks.push(chunk));
      upstreamResponse.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = { ok: false };
        }
        const merged = {
          ...body,
          apiVersion: 2,
          serverVersion: body.serverVersion ?? `sidecar/${SIDECAR_VERSION}`,
          capabilities: ['search', 'inbook', 'pdf-range'],
        };
        response.writeHead(upstreamResponse.statusCode ?? 200, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        response.end(JSON.stringify(merged));
      });
    },
  );
  upstream.on('error', () => {
    response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, error: 'upstream unavailable' }));
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.end();
}

/// פרוקסי שקוף וזורם לכל שאר הנתיבים (search/inbook כולל NDJSON).
// headers hop-by-hop שאסור להעביר הלאה; ה־HttpListener של ‎.NET רגיש אליהם.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function proxy(request, response) {
  const forwarded = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP.has(name)) forwarded[name] = value;
  }
  forwarded.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: request.url,
      method: request.method,
      headers: forwarded,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    log('proxy error', request.method, request.url, error.message);
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    response.end(JSON.stringify({ ok: false, error: 'upstream unavailable' }));
  });
  request.pipe(upstream);
  // ניתוק לקוח אמיתי מזוהה בסגירת ה־response לפני שהסתיים; 'close' על
  // הבקשה נורה גם אחרי צריכת הגוף ולכן אינו מתאים כאן.
  response.on('close', () => {
    if (!response.writableEnded) upstream.destroy();
  });
}

const server = http.createServer((request, response) => {
  const allowCors = corsDecision(request);
  const url = new URL(request.url, `http://${LISTEN_HOST}:${LISTEN_PORT}`);

  if (url.pathname.startsWith('/pdf/')) {
    const rest = url.pathname.slice('/pdf/'.length);
    if (request.method === 'OPTIONS') {
      if (!allowCors) {
        response.writeHead(403);
        response.end();
        return;
      }
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' });
      response.end();
      return;
    }
    // decodeURIComponent — התוסף שולח encodeURIComponent(fileId).
    let fileId = rest;
    try {
      fileId = decodeURIComponent(rest);
    } catch {
      /* יטופל כ־400 בולידציה */
    }
    void servePdf(request, response, fileId, allowCors);
    return;
  }

  if (url.pathname === '/health' && request.method === 'GET') {
    serveHealth(request, response);
    return;
  }

  proxy(request, response);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`hb-sidecar ${SIDECAR_VERSION} on http://${LISTEN_HOST}:${LISTEN_PORT} → upstream :${UPSTREAM_PORT}, pdfs: ${PDFS_ROOT}`);
});
