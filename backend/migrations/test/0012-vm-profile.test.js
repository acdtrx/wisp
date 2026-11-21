/*
 * 0012 with the ctx the runner builds (lib/stateMigrations.js, buildContext), its
 * vmManager a stand-in that records the calls: the rule and the XML change are
 * vmManager's (profileFromDefinition, setWispProfile, tested beside vmManagerXml.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../0012-vm-profile.js';

/** The ctx the runner gives a migration: `vms` maps each VM to its stored profile (null: none) and what it reads as. */
function context(vms) {
  const calls = [];
  const changes = [];
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
  const refuse = (what) => () => { throw new Error(`0012 ${what}`); };
  return {
    calls,
    changes,
    ctx: {
      log,
      vmManager: {
        listVMs: async () => Object.keys(vms).map((name) => ({ name, stateCode: 5 })),
        setMissingVMProfile: async (name) => {
          calls.push(name);
          const vm = vms[name];
          if (vm.stored) return { changed: false, profile: vm.stored };
          vm.stored = vm.readsAs;
          return { changed: true, profile: vm.readsAs };
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

test('every VM without a profile gets the one it reads as, each recorded', async () => {
  const { ctx, calls, changes } = context({
    dubi: { stored: null, readsAs: 'linux' },
    gubi: { stored: null, readsAs: 'windows-11' },
    made: { stored: 'other', readsAs: 'linux' },
  });
  await run(ctx);
  assert.deepEqual(calls, ['dubi', 'gubi', 'made']);
  assert.deepEqual(changes, ['dubi: profile linux', 'gubi: profile windows-11']);
});

test('a second run changes nothing and records nothing', async () => {
  const { ctx, changes } = context({ dubi: { stored: null, readsAs: 'linux' } });
  await run(ctx);
  changes.length = 0;
  await run(ctx);
  assert.deepEqual(changes, []);
});

test('a failed write fails the migration', async () => {
  const { ctx } = context({ dubi: { stored: null, readsAs: 'linux' } });
  ctx.vmManager.setMissingVMProfile = async () => { throw Object.assign(new Error('libvirt down'), { code: 'LIBVIRT_ERROR' }); };
  await assert.rejects(run(ctx), (err) => err.code === 'LIBVIRT_ERROR');
});
