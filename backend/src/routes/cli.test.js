/*
 * The CLI's downloads on the real app (built without listening, as in
 * app.test.js), from a development checkout: its cli/ holds the install
 * scripts and no binary. A staged tree's binaries are verified on a host
 * (CODING-RULES §14).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';

const ROOT_PACKAGE = fileURLToPath(new URL('../../../package.json', import.meta.url));
const VERSION = JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')).version;

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-cli-routes-test-'));
writeFileSync(path.join(dir, 'wisp-config.json'), '{}\n');
// config.js reads the path when it loads: set it before the app is imported.
process.env.WISP_CONFIG_PATH = path.join(dir, 'wisp-config.json');

let app;

before(async () => {
  const { setPassword } = await import('../lib/auth.js');
  await setPassword('test-login-password');
  const { buildApp } = await import('../app.js');
  ({ app } = await buildApp(Fastify({ logger: { level: 'silent' } }).log));
});

after(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/cli answers the version and no platforms, with no credentials', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/cli' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { version: VERSION, platforms: [] });
});

test('a binary this checkout does not carry, or of no platform, is 404 CLI_NOT_AVAILABLE', async () => {
  for (const platform of ['linux-amd64', 'windows-arm64', 'plan9-mips']) {
    const res = await app.inject({ method: 'GET', url: `/api/cli/wisp-${platform}` });
    assert.equal(res.statusCode, 404, platform);
    assert.equal(res.json().error, 'CLI_NOT_AVAILABLE', platform);
  }
});

test('the install scripts download from the address the request came to', async () => {
  const sh = await app.inject({ method: 'GET', url: '/api/cli/install.sh', headers: { host: 'wisp.test:8080' } });
  assert.equal(sh.statusCode, 200);
  assert.match(sh.headers['content-type'], /^text\/x-shellscript/);
  assert.match(sh.body, /^#!\/bin\/sh\n/);
  assert.ok(sh.body.includes("wisp_url='http://wisp.test:8080'\n"));
  assert.ok(!sh.body.includes('{{wisp_url}}'));

  const ps = await app.inject({ method: 'GET', url: '/api/cli/install.ps1', headers: { host: '[fd00::1]:8080' } });
  assert.equal(ps.statusCode, 200);
  assert.ok(ps.body.includes("$wispUrl = 'http://[fd00::1]:8080'\n"));
});

test('a Host the scripts could not carry is refused, never written into a script', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/cli/install.sh', headers: { host: "evil'$(id)" } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'BAD_REQUEST');
});
