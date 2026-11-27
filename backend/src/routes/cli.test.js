/*
 * The CLI's downloads and its version check on the real app (built without
 * listening, as in app.test.js), from a development checkout: its cli/ holds
 * the install scripts and no binary. A staged tree's binaries are verified on
 * a host (CODING-RULES §14).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';

const ROOT_PACKAGE = fileURLToPath(new URL('../../../package.json', import.meta.url));
const VERSION = JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')).version;

const AGENT_TOKEN = 'wisp_agent_test-cli-token';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-cli-routes-test-'));
writeFileSync(path.join(dir, 'wisp-config.json'), JSON.stringify({
  apiTokens: [{
    id: 'agent', label: 'agent', scope: 'agent', createdAt: '2026-01-01T00:00:00.000Z',
    tokenHash: createHash('sha256').update(AGENT_TOKEN).digest('hex'),
  }],
}));
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

const asCli = (version, token = AGENT_TOKEN) => ({ authorization: `Bearer ${token}`, 'wisp-cli-version': version });

test('a CLI of another version is refused with 409 naming both versions, before the route runs', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: asCli('0.0.1-old') });
  assert.equal(res.statusCode, 409);
  const { error, detail } = res.json();
  assert.equal(error, 'CLI_VERSION_MISMATCH');
  assert.ok(detail.includes('0.0.1-old') && detail.includes(VERSION), detail);
  assert.ok(detail.includes('run `wisp update`'), detail);

  // A body the route's schema refuses (400) is not read: the version comes first.
  const patch = await app.inject({
    method: 'PATCH', url: '/api/containers/web', headers: asCli('0.0.1-old'), payload: { bogus: true },
  });
  assert.equal(patch.statusCode, 409);
  assert.equal(patch.json().error, 'CLI_VERSION_MISMATCH');
});

test('a CLI of this version, or a request without the header, is served', async () => {
  const same = await app.inject({ method: 'GET', url: '/api/jobs', headers: asCli(VERSION) });
  assert.equal(same.statusCode, 200);
  const none = await app.inject({ method: 'GET', url: '/api/jobs', headers: { authorization: `Bearer ${AGENT_TOKEN}` } });
  assert.equal(none.statusCode, 200);
});

test('the token is checked before the version; the public routes never check it', async () => {
  const badToken = await app.inject({
    method: 'GET', url: '/api/jobs', headers: asCli('0.0.1-old', 'wisp_agent_not-a-token'), remoteAddress: '10.9.9.1',
  });
  assert.equal(badToken.statusCode, 401);
  assert.equal(badToken.json().error, 'AUTH_INVALID');

  const cli = await app.inject({ method: 'GET', url: '/api/cli', headers: { 'wisp-cli-version': '0.0.1-old' } });
  assert.equal(cli.statusCode, 200);
  const download = await app.inject({ method: 'GET', url: '/api/cli/wisp-linux-amd64', headers: { 'wisp-cli-version': '0.0.1-old' } });
  assert.equal(download.json().error, 'CLI_NOT_AVAILABLE');
});

test("MCP's instructions say what the CLI does beyond the tools, and how to install it from this Wisp", async () => {
  const res = await app.inject({
    method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${AGENT_TOKEN}`, host: 'wisp.test:8080' },
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  });
  assert.equal(res.statusCode, 200);
  const { instructions } = res.json().result;
  assert.ok(instructions.includes('curl -fsSL http://wisp.test:8080/api/cli/install.sh | sh'), instructions);
  assert.ok(instructions.includes('irm http://wisp.test:8080/api/cli/install.ps1 | iex'), instructions);
  assert.ok(instructions.includes('Host → App Config → API tokens'), instructions);
  for (const beyond of ['settings', 'mounts', 'uploads files', 'image archives']) {
    assert.ok(instructions.includes(beyond), `the CLI's line says what it does beyond the tools: ${beyond}`);
  }
});
