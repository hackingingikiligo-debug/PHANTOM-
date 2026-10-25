import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';

let server;
let baseUrl;

test.before(async () => {
  delete process.env.TITAN_API_KEY;
  delete process.env.TITAN_API_BASE_URL;
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test('serves the mobile-first app shell', async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /PHANTOM AI/);
  assert.match(html, /bottom-nav/);
  assert.match(html, /TITAN.1.R/);
  assert.match(html, /\.\/css\/style\.css/);
});

test('serves css and JavaScript assets', async () => {
  const css = await fetch(`${baseUrl}/css/style.css`);
  const js = await fetch(`${baseUrl}/js/app.js`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('health endpoint does not expose secrets', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.aiConfigured, false);
  assert.equal(Object.hasOwn(body, 'apiKey'), false);
});

test('chat endpoint gracefully explains that TITAN is not configured', async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Привет' })
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'AI_NOT_CONFIGURED');
  assert.match(body.error, /TITAN_API_BASE_URL/);
});

test('chat rejects an empty message', async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '  ' })
  });
  assert.equal(response.status, 400);
});

test('unknown API routes return 404', async () => {
  const response = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(response.status, 404);
});
