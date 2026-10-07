import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApp, createAuthenticatedApp, assertLoopbackHost } from '../server.mjs';

async function withServer(run) {
  const server = createApp({
    snapshotProvider: async () => ({ hostname: 'test-host', processes: [] })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('allows loopback binds and rejects external interfaces', () => {
  assert.equal(assertLoopbackHost('127.0.0.1'), '127.0.0.1');
  assert.equal(assertLoopbackHost('::1'), '::1');
  assert.equal(assertLoopbackHost('localhost'), '127.0.0.1');
  assert.throws(() => assertLoopbackHost('0.0.0.0'), /only supports localhost/);
  assert.throws(() => assertLoopbackHost('192.168.1.10'), /only supports localhost/);
});

test('serves a snapshot with security headers and no CORS permission', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/metrics`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hostname: 'test-host', processes: [] });
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('restricts methods and rejects unknown or traversal-like paths', async () => {
  await withServer(async (base) => {
    const post = await fetch(`${base}/api/metrics`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal((await post.json()).error, 'Method not allowed');
    assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/server.mjs`)).status, 404);
  });
});

test('rejects foreign Host headers to prevent DNS-rebinding access', async () => {
  await withServer(async (base) => {
    const response = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/metrics`, { headers: { host: 'attacker.example' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, { error: 'Host not allowed' });
  });
});

test('requires valid Basic authentication for dashboard content and metrics', async () => {
  const credentials = { username: 'local-user', password: 'a-long-test-secret' };
  const server = createAuthenticatedApp({
    snapshotProvider: async () => ({ username: 'service-user' }),
    credentials
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const missing = await fetch(`${base}/api/metrics`);
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get('www-authenticate'), /Basic realm="AETHER Local Observatory"/);
    assert.deepEqual(await missing.json(), { error: 'Authentication required' });
    const invalid = await fetch(`${base}/`);
    assert.equal(invalid.status, 401);
    const authorized = await fetch(`${base}/api/metrics`, {
      headers: { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` }
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { username: 'service-user' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reports metric provider errors without exposing internal details', async () => {
  const server = createApp({ snapshotProvider: async () => { throw new Error('private path detail'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/metrics`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Metrics are temporarily unavailable' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('shares a single live sample across concurrent event-stream clients', async () => {
  let calls = 0;
  const server = createApp({ snapshotProvider: async () => ({ sample: ++calls }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controllers = [new AbortController(), new AbortController()];
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const responses = await Promise.all(controllers.map((controller) =>
      fetch(`${base}/api/events`, { signal: controller.signal })));
    const chunks = await Promise.all(responses.map((response) => response.body.getReader().read()));
    assert.equal(chunks[0].value.toString(), chunks[1].value.toString());
    assert.match(new TextDecoder().decode(chunks[0].value), /data: \{"sample":1\}/);
    assert.equal(calls, 1);
  } finally {
    controllers.forEach((controller) => controller.abort());
    await new Promise((resolve) => server.close(resolve));
  }
});
