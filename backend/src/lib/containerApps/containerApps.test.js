/*
 * An app config save on a stand-in containerManager (node --test
 * --experimental-test-module-mocks), and the Caddy app's own module: when a save
 * reloads a running container and when it leaves everything to the restart
 * (docs/specs/CUSTOM-APPS.md, Live Reload), and what the Caddy app derives
 * with and without the host's certificate.
 */
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

/** The stand-in container: its record, its task, its files and what was run in it. */
let box;

function restartSignature(config) {
  return JSON.stringify({ env: config.env ?? {}, mounts: config.mounts ?? [], devices: config.devices ?? [] });
}

// The real facade's validators and the like, with every call the save makes stood in.
const realManager = await import('../containerManager/index.js');
mock.module(new URL('../containerManager/index.js', import.meta.url).href, {
  exports: {
    ...realManager,
    getContainerConfig: async () => structuredClone(box.config),
    getTaskState: async () => (box.running ? { status: 'RUNNING', pid: 1 } : null),
    isTaskOn: (task) => !!task,
    updateContainerConfig: async (_name, changes) => {
      const before = restartSignature(box.config);
      const env = { ...box.config.env };
      for (const [k, v] of Object.entries(changes.envPatch ?? {})) {
        if (v === null) delete env[k];
        else env[k] = v;
      }
      box.config = { ...box.config, env, mounts: changes.mounts ?? box.config.mounts, metadata: changes.metadata ?? box.config.metadata };
      const requiresRestart = box.running && restartSignature(box.config) !== before;
      if (requiresRestart) box.config.pendingRestart = { since: 'persist' };
      return { removedMounts: [], requiresRestart };
    },
    setContainerPendingRestart: async (_name, value) => {
      box.flagWrites += 1;
      if (value === true) box.config.pendingRestart = { since: 'set' };
      else if (value && value.since) box.config.pendingRestart = value;
      else delete box.config.pendingRestart;
    },
    putMountFileTextContent: async (_name, mount, content, options) => {
      box.files[mount] = { content, mode: options?.mode ?? null };
    },
    getMountFileTextContent: async (_name, mount) => ({ content: box.files[mount]?.content ?? '' }),
    getMountFileSize: async (_name, mount) => box.files[mount]?.content.length ?? null,
    execCommandInContainer: async (_name, cmd) => {
      box.execs.push(cmd);
      return box.reloadAnswer;
    },
    deleteRemovedMountData: async () => {},
    createContainer: async () => ({ name: 'caddy' }),
    deleteContainer: async () => {},
    updateContainerMount: async () => {},
  },
});

const { applyAppConfig, appPublishedLinks } = await import('./index.js');
const { caddyAppModule } = await import('./caddy.js');

const CERT = {
  domain: 'home.example.com',
  chain: '-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n',
  key: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n',
};
const HOSTS = [{ subdomain: 'ha', target: '192.0.2.5:8123' }];

/** A running Caddy container whose files are those of `certificate`. */
function caddyBox({ certificate = null, pendingRestart = null } = {}) {
  const derived = caddyAppModule.generateDerivedConfig({ hosts: HOSTS }, { certificate });
  const config = { name: 'caddy', env: {}, mounts: derived.mounts, metadata: { app: 'caddy-reverse-proxy', appConfig: { hosts: HOSTS } } };
  if (pendingRestart) config.pendingRestart = pendingRestart;
  const files = Object.fromEntries(Object.entries(derived.mountContents).map(([k, v]) => [k, { content: v, mode: null }]));
  return { config, running: true, files, execs: [], flagWrites: 0, reloadAnswer: { exitCode: 0, stdout: '', stderr: '' } };
}

beforeEach(() => {
  box = caddyBox();
});

test('a running container whose files change only in content is reloaded, the certificate delivered', async () => {
  const result = await applyAppConfig('caddy', { hosts: HOSTS }, { certificate: CERT });
  assert.deepEqual(result, { requiresRestart: false, reloaded: true });
  assert.deepEqual(box.execs, [['caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--force']]);
  assert.equal(box.files['tls-cert'].content, CERT.chain);
  assert.equal(box.files['tls-key'].content, CERT.key);
  assert.equal(box.files['tls-key'].mode, 0o600, 'the key is a secret file');
  assert.match(box.files.Caddyfile.content, /^\*\.home\.example\.com \{$/m);
  assert.equal(box.config.pendingRestart, undefined);
});

test('a save that changes the mount layout is not reloaded: stored, flagged, applied by the restart', async () => {
  // A container made before the host's certificate: no tls- mounts, and the token in its env.
  box.config.mounts = box.config.mounts.filter((m) => !m.name.startsWith('tls-'));
  const result = await applyAppConfig('caddy', { hosts: HOSTS }, { certificate: CERT });
  assert.deepEqual(result, { requiresRestart: true });
  assert.deepEqual(box.execs, [], 'no reload');
  assert.ok(box.config.pendingRestart, 'flagged restart required');
  assert.deepEqual(box.config.mounts.map((m) => m.name), ['Caddyfile', 'tls-cert', 'tls-key', 'caddy-data', 'caddy-config']);
  assert.equal(box.files['tls-cert'].content, CERT.chain, 'the files are written for the restart');
});

test('a save that changes the env is not reloaded either', async () => {
  box.config.env = { CLOUDFLARE_API_TOKEN: { value: 'old', secret: true } };
  const result = await applyAppConfig('caddy', { hosts: HOSTS }, { certificate: CERT });
  assert.deepEqual(result, { requiresRestart: true });
  assert.deepEqual(box.execs, []);
  assert.deepEqual(box.config.env, {});
  assert.ok(box.config.pendingRestart);
});

test('a content-only save on a container already flagged restart required is not reloaded, and its flag stays as it was', async () => {
  box = caddyBox({ pendingRestart: { since: '2026-11-25T10:00:00.000Z' } });
  const result = await applyAppConfig('caddy', { hosts: HOSTS }, { certificate: CERT });
  assert.deepEqual(result, { requiresRestart: true });
  assert.deepEqual(box.execs, [], 'no reload');
  assert.deepEqual(box.config.pendingRestart, { since: '2026-11-25T10:00:00.000Z' });
  assert.equal(box.flagWrites, 0);
  assert.equal(box.files['tls-key'].content, CERT.key);
});

test('a refused reload rolls the files back', async () => {
  box.reloadAnswer = { exitCode: 1, stdout: '', stderr: 'Error: loading certificate: bad' };
  await assert.rejects(applyAppConfig('caddy', { hosts: HOSTS }, { certificate: CERT }), { code: 'APP_RELOAD_FAILED' });
  assert.equal(box.files['tls-cert'].content, '');
});

test('a stopped container is stored, with no reload and no flag', async () => {
  box.running = false;
  assert.deepEqual(await applyAppConfig('caddy', { hosts: HOSTS }, { certificate: CERT }), { requiresRestart: false });
  assert.deepEqual(box.execs, []);
});

test('the Caddy app: hosts only; without a certificate no site and empty tls- files, always mounted', () => {
  assert.deepEqual(caddyAppModule.getDefaultAppConfig(), { hosts: [] });
  assert.throws(() => caddyAppModule.validateAppConfig({ hosts: [], domain: 'example.com' }), { code: 'INVALID_APP_CONFIG' });
  assert.throws(() => caddyAppModule.validateAppConfig({ hosts: [{ subdomain: 'a', target: 'x}' }] }), { code: 'INVALID_APP_CONFIG' });
  assert.deepEqual(caddyAppModule.validateAppConfig({ hosts: [{ subdomain: ' HA ', target: ' 192.0.2.5 ' }] }), { hosts: [{ subdomain: 'ha', target: '192.0.2.5' }] });

  const none = caddyAppModule.generateDerivedConfig({ hosts: HOSTS });
  assert.deepEqual(none.env, {});
  assert.deepEqual(none.mounts.map((m) => [m.name, m.containerPath]), [
    ['Caddyfile', '/etc/caddy/Caddyfile'],
    ['tls-cert', '/etc/caddy/tls/fullchain.pem'],
    ['tls-key', '/etc/caddy/tls/key.pem'],
    ['caddy-data', '/data'],
    ['caddy-config', '/config'],
  ]);
  assert.equal(none.mountContents['tls-cert'], '');
  assert.equal(none.mountContents['tls-key'], '');
  assert.doesNotMatch(none.mountContents.Caddyfile, /\*\./);
  assert.match(none.mountContents.Caddyfile, /level ERROR/);

  const withCert = caddyAppModule.generateDerivedConfig({ hosts: HOSTS }, { certificate: CERT });
  assert.deepEqual(withCert.mounts, none.mounts, 'the certificate changes contents, never the layout');
  const caddyfile = withCert.mountContents.Caddyfile;
  assert.match(caddyfile, /tls \/etc\/caddy\/tls\/fullchain\.pem \/etc\/caddy\/tls\/key\.pem/);
  assert.match(caddyfile, /@ha host ha\.home\.example\.com/);
  assert.match(caddyfile, /reverse_proxy 192\.0\.2\.5:8123/);
  assert.match(caddyfile, /respond "No matching host" 404/);
  assert.deepEqual(caddyAppModule.getSecretMountNames({ hosts: HOSTS }), ['tls-key']);
});

test("the Caddy app's links are under the certificate's domain, and none while Wisp holds none", () => {
  const config = { metadata: { app: 'caddy-reverse-proxy', appConfig: { hosts: HOSTS } } };
  assert.deepEqual(appPublishedLinks(config, { certificate: { domain: 'home.example.com' } }), [
    { url: 'https://ha.home.example.com', target: '192.0.2.5:8123' },
  ]);
  assert.deepEqual(appPublishedLinks(config, { certificate: null }), []);
});
