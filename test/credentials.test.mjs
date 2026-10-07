import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials } from '../server.mjs';

test('creates owner-only credentials and reuses them on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aether-credentials-'));
  const filePath = join(directory, 'credentials.json');
  try {
    const generated = await loadCredentials({ filePath, accountName: 'test-account' });
    const metadata = await stat(filePath);
    assert.equal(generated.username, 'test-account');
    assert.ok(generated.password.length >= 40);
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), generated);
    assert.deepEqual(await loadCredentials({ filePath }), generated);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects credential files with group or world permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aether-credentials-'));
  const filePath = join(directory, 'credentials.json');
  try {
    await loadCredentials({ filePath, accountName: 'test-account' });
    await chmod(filePath, 0o644);
    await assert.rejects(loadCredentials({ filePath }), /owner-only file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects incomplete environment credentials', async () => {
  await assert.rejects(
    loadCredentials({ username: 'test-account', password: '' }),
    /Set both HEALTHDASH_USERNAME and a HEALTHDASH_PASSWORD/
  );
});

test('rejects short configured passwords', async () => {
  await assert.rejects(
    loadCredentials({ username: 'test-account', password: 'too-short' }),
    /at least 16 characters/
  );
});
