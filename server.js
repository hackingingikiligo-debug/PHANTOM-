import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 64 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20;
const requestCounts = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  });
  res.end(body);
}

function getClientKey(req) {
  // Do not trust X-Forwarded-For in this starter. Render proxy addresses may make this coarse.
  return req.socket.remoteAddress || 'unknown';
}
function isRateLimited(req) {
  const now = Date.now();
  const key = getClientKey(req);
  const old = requestCounts.get(key);
  if (!old || now - old.start >= RATE_WINDOW_MS) {
    requestCounts.set(key, { start: now, count: 1 });
    return false;
  }
  old.count += 1;
  return old.count > RATE_MAX_REQUESTS;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { sendJson(res, 400, { error: 'Bad URL.' }); return; }
  if (decoded.includes('\0') || decoded.includes('\\')) { sendJson(res, 400, { error: 'Bad path.' }); return; }
  const requestPath = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.resolve(PUBLIC_DIR, `.${requestPath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    sendJson(res, 403, { error: 'Forbidden.' }); return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': content.length,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Not found.' });
  }
}

async function handleChat(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  if (isRateLimited(req)) {
    sendJson(res, 429, { error: 'Слишком много запросов. Попробуй через минуту.' });
    return;
  }
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('application/json')) {
    sendJson(res, 415, { error: 'Ожидался JSON-запрос.' });
    return;
  }
  let payload;
  try { payload = await readJson(req); }
  catch (error) {
    if (!res.headersSent) sendJson(res, error.statusCode || 400, { error: error.statusCode === 413 ? 'Слишком большой запрос.' : 'Некорректный JSON.' });
    return;
  }
  if (typeof payload.message !== 'string' || !payload.message.trim()) {
    sendJson(res, 400, { error: 'Добавь текст сообщения.' }); return;
  }
  if (payload.message.length > 12_000) {
    sendJson(res, 413, { error: 'Сообщение слишком длинное. Максимум 12 000 символов.' }); return;
  }

  const apiKey = process.env.TITAN_API_KEY;
  const baseUrl = String(process.env.TITAN_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!apiKey || !baseUrl) {
    sendJson(res, 503, {
      code: 'AI_NOT_CONFIGURED',
      error: 'PHANTOM запущен, но модель TITAN.1.R ещё не настроена. Добавь TITAN_API_BASE_URL и TITAN_API_KEY в переменные окружения сервера.'
    });
    return;
  }
  const model = process.env.TITAN_MODEL || 'titan.1.R';
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 45_000);
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Ты — PHANTOM AI на модели TITAN.1.R. Отвечай по-русски, если пользователь не попросил другой язык. Будь полезным, честным и конкретным. Не утверждай, что искал в интернете или проверил источники, если соответствующий инструмент не был подключён.' },
          { role: 'user', content: payload.message.trim() }
        ],
        temperature: 0.7,
        max_tokens: 2048
      }),
      signal: abortController.signal
    });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      // Do not relay upstream headers or key. Keep the response safe for the client.
      const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 502;
      sendJson(res, status, { error: upstream.status === 429 ? 'Лимит запросов модели исчерпан. Попробуй позже.' : 'Провайдер ИИ не смог обработать запрос. Проверь модель и настройки сервера.' });
      return;
    }
    const reply = result?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      sendJson(res, 502, { error: 'Провайдер ИИ вернул пустой ответ.' }); return;
    }
    sendJson(res, 200, { reply: reply.trim(), model });
  } catch (error) {
    sendJson(res, error.name === 'AbortError' ? 504 : 502, { error: error.name === 'AbortError' ? 'ИИ не ответил за отведённое время. Попробуй ещё раз.' : 'Не удалось связаться с провайдером ИИ.' });
  } finally {
    clearTimeout(timeout);
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health') {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sendJson(res, 405, { status: 'method_not_allowed' }); return; }
      sendJson(res, 200, { status: 'ok', app: 'PHANTOM AI', version: '0.1.0', aiConfigured: Boolean(process.env.TITAN_API_KEY && process.env.TITAN_API_BASE_URL) });
      return;
    }
    if (url.pathname === '/api/chat') { await handleChat(req, res); return; }
    if (url.pathname.startsWith('/api/')) { sendJson(res, 404, { error: 'API route not found.' }); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); sendJson(res, 405, { error: 'Method not allowed.' }); return; }
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
    await serveStatic(req, res, url.pathname);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`PHANTOM AI is listening on ${HOST}:${PORT}`);
    console.log(`TITAN.1.R: ${process.env.TITAN_API_KEY && process.env.TITAN_API_BASE_URL ? 'configured' : 'not configured (demo mode)'}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
