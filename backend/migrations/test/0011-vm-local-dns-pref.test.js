/*
 * 0011 with the ctx the runner builds (lib/stateMigrations.js, buildContext),
 * its vmManager a stand-in that records the calls: the XML change itself is
 * vmManager's (removeWispPref, tested beside vmManagerXml.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../0011-vm-local-dns-pref.js';

/** The ctx the runner gives a migration, with VMs `withPref` holding the pref among `names`. */
function context(names, withPref) {
  const calls = [];
  const changes = [];
  const has = new Set(withPref);
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
  const refuse = (what) => () => { throw new Error(`0011 ${what}`); };
  return {
    calls,
    changes,
    ctx: {
      log,
      vmManager: {
        listVMs: async () => names.map((name) => ({ name, stateCode: 5 })),
        removeVMPref: async (name, key) => {
          calls.push([name, key]);
          return { changed: has.delete(name) };
        },
      },
      containerManager: new Proxy({}, { get: (_t, key) => refuse(`reached the container manager (${String(key)})`) }),
      getConfig: refuse('read the config'),
      paths: {},
      setVMPendingRestart: refuse('set a restart flag'),
      setContainerPendingRestart: refuse('set a restart flag'),
      recordChange: (text) => changes.push(text),
    },
  };
}

test('every VM loses the localDns pref, and each removal is recorded', async () => {
  const { ctx, calls, changes } = context(['web', 'db', 'nas'], ['web', 'nas']);
  await run(ctx);
  assert.deepEqual(calls, [['web', 'localDns'], ['db', 'localDns'], ['nas', 'localDns']]);
  assert.deepEqual(changes, ['web: wisp:localDns removed', 'nas: wisp:localDns removed']);
});

test('a second run changes nothing and records nothing', async () => {
  const { ctx, changes } = context(['web'], ['web']);
  await run(ctx);
  changes.length = 0;
  await run(ctx);
  assert.deepEqual(changes, []);
});

test('a failed removal fails the migration', async () => {
  const { ctx } = context(['web'], ['web']);
  ctx.vmManager.removeVMPref = async () => { throw Object.assign(new Error('libvirt down'), { code: 'LIBVIRT_ERROR' }); };
  await assert.rejects(run(ctx), (err) => err.code === 'LIBVIRT_ERROR');
});
