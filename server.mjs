import { createServer } from 'node:http';
import { constants as fsConstants } from 'node:fs';
import { isIP } from 'node:net';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { createMetricsCollector } from './metrics.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cache-control': 'no-store'
};

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(value));
}

export function assertLoopbackHost(host) {
  const normalized = host.toLowerCase().replace(/^\\[|\\]$/g, '');
  if (normalized !== 'localhost' && !(isIP(normalized) && (normalized === '127.0.0.1' || normalized === '::1'))) {
    throw new Error('The dashboard only supports localhost binding. Use an SSH tunnel for remote access.');
  }
  return normalized === 'localhost' ? '127.0.0.1' : normalized;
}

function isLoopbackRequestHost(value) {
  if (!value) return false;
  let hostname;
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    if (closingBracket < 0) return false;
    hostname = value.slice(1, closingBracket);
    const suffix = value.slice(closingBracket + 1);
    if (suffix && !/^:\\d{1,5}$/.test(suffix)) return false;
  } else {
    const separator = value.lastIndexOf(':');
    if (separator >= 0) {
      if (value.indexOf(':') !== separator || !/^:\\d{1,5}$/.test(value.slice(separator))) return false;
      hostname = value.slice(0, separator);
    } else {
      hostname = value;
    }
  }
  return hostname.toLowerCase() === 'localhost'
    || (isIP(hostname) === 4 && hostname === '127.0.0.1')
    || (isIP(hostname) === 6 && hostname === '::1');
}

export function createApp({ snapshotProvider, credentials } = {}) {
  if (typeof snapshotProvider !== 'function') {
    throw new TypeError('A metrics snapshot provider is required');
  }
  const clients = new Set();
  let latestSnapshot;
  let streamTimer;
  let streamInFlight = false;
  let snapshotInFlight;
  const getSnapshot = () => {
    if (!snapshotInFlight) {
      snapshotInFlight = Promise.resolve()
        .then(snapshotProvider)
        .finally(() => { snapshotInFlight = undefined; });
    }
    return snapshotInFlight;
  };
  const publishMetrics = async () => {
    streamTimer = undefined;
    if (streamInFlight || clients.size === 0) return;
    streamInFlight = true;
    try {
      latestSnapshot = await getSnapshot();
      const message = `data: ${JSON.stringify(latestSnapshot)}\\n\\n`;
      for (const client of clients) {
        if (!client.destroyed) client.write(message);
      }
    } catch (error) {
      console.error(`Metrics snapshot unavailable: ${error.message}`);
      for (const client of clients) {
        if (!client.destroyed) client.write('event: error\\ndata: {"error":"Metrics are temporarily unavailable"}\\n\\n');
      }
    } finally {
      streamInFlight = false;
      if (clients.size > 0) streamTimer = setTimeout(publishMetrics, 1000);
    }
  };

  const server = createServer(async (request, response) => {
    if (!isLoopbackRequestHost(request.headers.host)) {
      sendJson(response, 403, { error: 'Host not allowed' });
      return;
    }
    if (credentials && !matchesCredentials(request.headers.authorization, credentials)) {
      response.writeHead(401, {
        ...SECURITY_HEADERS,
        'www-authenticate': 'Basic realm="AETHER Local Observatory", charset="UTF-8"',
        'content-type': 'application/json; charset=utf-8'
      });
      response.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }

    if (pathname === '/api/metrics') {
      try {
        sendJson(response, 200, await getSnapshot());
      } catch (error) {
        console.error(`Metrics snapshot unavailable: ${error.message}`);
        sendJson(response, 503, { error: 'Metrics are temporarily unavailable' });
      }
      return;
    }

    if (pathname === '/api/events') {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      clients.add(response);
      if (latestSnapshot) response.write(`data: ${JSON.stringify(latestSnapshot)}\\n\\n`);
      response.on('close', () => {
        clients.delete(response);
        if (clients.size === 0 && streamTimer) {
          clearTimeout(streamTimer);
          streamTimer = undefined;
        }
      });
      if (!streamTimer && !streamInFlight) void publishMetrics();
      return;
    }

    const asset = ASSETS.get(pathname);
    if (!asset) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    try {
      const body = await readFile(join(ROOT, 'public', asset[0]));
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': asset[1],
        'content-length': body.length
      });
      response.end(body);
    } catch {
      sendJson(response, 500, { error: 'Dashboard asset is unavailable' });
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 5000;
  return server;
}

function validCredential(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\r\\n:]/.test(value);
}

function validCredentialPair(credentials) {
  return credentials
    && validCredential(credentials.username)
    && validCredential(credentials.password)
    && credentials.password.length >= 16;
}

function matchesCredentials(header, credentials) {
  if (!header || !/^Basic /i.test(header)) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const supplied = [decoded.slice(0, separator), decoded.slice(separator + 1)];
  return [credentials.username, credentials.password].every((expected, index) => {
    const actualBytes = Buffer.from(supplied[index]);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  });
}

export function createAuthenticatedApp({ snapshotProvider, credentials } = {}) {
  if (!validCredentialPair(credentials)) {
    throw new TypeError('Valid dashboard credentials are required');
  }
  return createApp({ snapshotProvider, credentials });
}

export async function loadCredentials(options = {}) {
  const username = options.username ?? process.env.HEALTHDASH_USERNAME;
  const password = options.password ?? process.env.HEALTHDASH_PASSWORD;
  if (username !== undefined || password !== undefined) {
    if (!validCredentialPair({ username, password })) {
      throw new Error('Set both HEALTHDASH_USERNAME and a HEALTHDASH_PASSWORD of at least 16 characters without colons or newlines');
    }
    return { username, password };
  }

  const path = resolve(options.filePath ?? process.env.HEALTHDASH_CREDENTIALS_FILE
    ?? join(os.homedir(), '.config', 'aether', 'credentials.json'));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const pathInfo = await lstat(path);
    if (!pathInfo.isFile() || (pathInfo.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && pathInfo.uid !== process.getuid())) {
      throw new Error(`Credentials file must be a regular owner-only file owned by this account: ${path}`);
    }
    const info = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const details = await info.stat();
      if (!details.isFile() || (details.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && details.uid !== process.getuid())) {
        throw new Error(`Credentials file must be a regular owner-only file owned by this account: ${path}`);
      }
      const saved = JSON.parse(await info.readFile({ encoding: 'utf8' }));
      if (!validCredentialPair(saved)) {
        throw new Error(`Credentials file has an invalid format: ${path}`);
      }
      return saved;
    } finally {
      await info.close();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const generated = {
    username: options.accountName ?? (() => {
      try {
        return os.userInfo().username;
      } catch {
        return process.env.USER || process.env.LOGNAME || 'local-user';
      }
    })(),
    password: randomBytes(32).toString('base64url')
  };
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(generated, null, 2)}\\n`, 'utf8');
    } finally {
      await file.close();
    }
    console.log(`Generated private dashboard credentials at ${path}`);
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return loadCredentials({ ...options, username: undefined, password: undefined });
  }
}

async function main() {
  const host = assertLoopbackHost(process.env.HEALTHDASH_HOST ?? '127.0.0.1');
  const port = Number(process.env.HEALTHDASH_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('HEALTHDASH_PORT must be an integer from 1 through 65535');
  }
  const snapshotProvider = createMetricsCollector();
  const credentials = await loadCredentials();
  const server = createAuthenticatedApp({ snapshotProvider, credentials });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  console.log(`AETHER listening at http://${host}:${address.port}`);
  const shutdown = () => {
    server.close((error) => {
      if (error) {
        console.error(`Dashboard shutdown failed: ${error.message}`);
        process.exitCode = 1;
      }
    });
    server.closeAllConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Failed to start dashboard: ${error.message}`);
    process.exitCode = 1;
  });
}
