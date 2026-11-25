/*
 * 0017 over stored fixtures: a temporary wisp-config.json and container.json
 * records held by a stand-in containerManager, with the ctx the runner builds.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../0017-caddy-certificate-to-settings.js';

let dir = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A Caddy container as an earlier release stored it. */
function oldCaddy(name, appConfig) {
  return {
    name,
    image: 'ghcr.io/someone/caddy-cloudflare:latest',
    env: { CLOUDFLARE_API_TOKEN: { value: appConfig.cloudflareApiToken ?? '', secret: true } },
    mounts: [{ type: 'file', name: 'Caddyfile', containerPath: '/etc/caddy/Caddyfile', readonly: true }],
    metadata: { app: 'caddy-reverse-proxy', appConfig },
  };
}

function context(settings, containers) {
  dir = mkdtempSync(path.join(tmpdir(), 'wisp-0017-test-'));
  const configFile = path.join(dir, 'wisp-config.json');
  if (settings !== undefined) writeFileSync(configFile, JSON.stringify(settings), { mode: 0o600 });
  const records = new Map(containers.map((c) => [c.name, structuredClone(c)]));
  const changes = [];
  const containerManager = {
    // In the store's order, not by name: the migration orders them itself.
    listContainers: async () => [...records.keys()].map((name) => ({ name })),
    readContainerConfig: async (name) => structuredClone(records.get(name)),
    writeContainerConfig: async (name, config) => { records.set(name, structuredClone(config)); },
  };
  return {
    file: configFile,
    records,
    changes,
    ctx: { containerManager, paths: { configFile }, recordChange: (t) => changes.push(t) },
  };
}

const readConfig = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('of two Caddy containers the first by name gives its domain and token; both lose the four fields', async () => {
  const zeta = oldCaddy('zeta', { domain: 'other.example.org', email: 'z@x', hosts: [{ subdomain: 'b', target: 'b:2' }], cloudflareDnsEnabled: true, cloudflareApiToken: 'tok-zeta' });
  const alpha = oldCaddy('alpha', { domain: 'Home.Example.com', email: 'a@x', hosts: [{ subdomain: 'a', target: 'a:1' }], cloudflareDnsEnabled: true, cloudflareApiToken: 'tok-alpha' });
  const { file, records, changes, ctx } = context({ serverName: 'box' }, [zeta, alpha]);
  await run(ctx);

  const data = readConfig(file);
  assert.equal(data.serverName, 'box');
  assert.deepEqual(data.certificate, { domain: 'home.example.com', cloudflareApiToken: 'tok-alpha' });
  assert.equal(statSync(file).mode & 0o777, 0o600);

  assert.deepEqual(records.get('alpha').metadata.appConfig, { hosts: [{ subdomain: 'a', target: 'a:1' }] });
  assert.deepEqual(records.get('zeta').metadata.appConfig, { hosts: [{ subdomain: 'b', target: 'b:2' }] });
  // Its env, mounts and image are left as they were: it serves with its own certificate until Wisp's delivery.
  assert.deepEqual(records.get('alpha').env, alpha.env);
  assert.deepEqual(records.get('alpha').mounts, alpha.mounts);
  assert.equal(records.get('alpha').image, alpha.image);

  assert.ok(changes.every((c) => !c.includes('tok-')), 'no token in what the migration reports');
});

test('a host that already has a setting keeps it', async () => {
  const kept = { domain: 'kept.example.net', cloudflareApiToken: 'tok-kept' };
  const { file, records, ctx } = context({ certificate: kept }, [
    oldCaddy('caddy', { domain: 'home.example.com', email: '', hosts: [], cloudflareDnsEnabled: true, cloudflareApiToken: 'tok-caddy' }),
  ]);
  await run(ctx);
  assert.deepEqual(readConfig(file).certificate, kept);
  assert.deepEqual(records.get('caddy').metadata.appConfig, { hosts: [] });
});

test('a container without both a domain and a token gives nothing; one with a domain the setting cannot hold is reported', async () => {
  const { file, records, changes, ctx } = context({}, [
    oldCaddy('a-empty', { domain: '', email: '', hosts: [], cloudflareDnsEnabled: false, cloudflareApiToken: '' }),
    oldCaddy('b-no-token', { domain: 'example.com', email: '', hosts: [], cloudflareDnsEnabled: false, cloudflareApiToken: '' }),
    oldCaddy('c-bad-domain', { domain: 'https://example.com', email: '', hosts: [], cloudflareDnsEnabled: true, cloudflareApiToken: 't' }),
  ]);
  await run(ctx);
  assert.equal(readConfig(file).certificate, undefined);
  assert.ok(changes.some((c) => c.startsWith('c-bad-domain: domain "https://example.com" not moved')));
  for (const name of ['a-empty', 'b-no-token', 'c-bad-domain']) assert.deepEqual(records.get(name).metadata.appConfig, { hosts: [] });
});

test('run again, it changes nothing; a host with no Caddy container is not touched', async () => {
  const { file, changes, ctx } = context({}, [
    oldCaddy('caddy', { domain: 'example.com', email: '', hosts: [], cloudflareDnsEnabled: true, cloudflareApiToken: 't' }),
  ]);
  await run(ctx);
  const first = readFileSync(file, 'utf8');
  changes.length = 0;
  await run(ctx);
  assert.equal(readFileSync(file, 'utf8'), first);
  assert.deepEqual(changes, []);

  const other = context(undefined, [{ name: 'web', metadata: { app: 'jellyfin', appConfig: { libraries: [] } } }]);
  await run(other.ctx);
  assert.deepEqual(other.changes, []);
  assert.deepEqual(other.records.get('web').metadata.appConfig, { libraries: [] });
});
