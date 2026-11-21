import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, jsonResponse, respondWithStream, settle } from '../testing/fakeBrowser.js';
import { TOPIC } from '../../../shared/wireNames.js';

let net;
let store;
let loaded = 0;

beforeEach(async () => {
  installBrowser();
  net = installFetch();
  loaded += 1;
  ({ useVmStore: store } = await import(`./vmStore.js?test=${loaded}`));
});

afterEach(() => {
  // The events module is shared across tests: leave it with no subscriber.
  store.getState().disconnect();
  store.getState().deselect();
});

/** Start the list feed and answer the shared events stream. */
async function startList() {
  store.getState().connect();
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  return stream;
}

test('a list frame is the list', async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', state: 'running' }] });
  await settle();
  assert.deepEqual(store.getState().data, [{ name: 'a', state: 'running' }]);
  assert.equal(store.getState().connection, 'open');
});

test('an error frame on the list keeps the list and shows the error', async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', state: 'running' }] });
  stream.frame({ topic: TOPIC.VMS, data: { error: 'LIBVIRT_ERROR', detail: 'Failed to list VMs' } });
  await settle();
  assert.deepEqual(store.getState().data, [{ name: 'a', state: 'running' }]);
  assert.equal(store.getState().error, 'Failed to list VMs');
});

test("an action's error is cleared when the next action on that VM begins, and leaves with the VM", async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', state: 'running' }] });
  await settle();
  const failing = store.getState().rebootVM('a');
  (await net.nextExact('/api/vms/a/reboot')).respond(jsonResponse({ error: 'VM_NOT_RUNNING', detail: 'Not running' }, 409));
  assert.equal(await failing, false);
  assert.equal(store.getState().errors.a, 'Not running');
  const next = store.getState().rebootVM('a');
  assert.equal(store.getState().errors.a, undefined);
  (await net.nextExact('/api/vms/a/reboot')).respond(jsonResponse({ error: 'VM_NOT_RUNNING', detail: 'Still not' }, 409));
  assert.equal(await next, false);
  stream.frame({ topic: TOPIC.VMS, data: [] });
  await settle();
  assert.equal(store.getState().errors.a, undefined);
});

test('selecting a VM opens its stats stream; deselecting closes it', async () => {
  const { useVmStatsStore } = await import(`./vmStore.js?test=${loaded}`);
  store.getState().select('a');
  const request = await net.next('/api/vms/a/stats');
  respondWithStream(request).frame({ state: 'running', active: true });
  await settle();
  assert.deepEqual(useVmStatsStore.getState().data, { state: 'running', active: true });
  store.getState().deselect();
  assert.equal(request.signal.aborted, true);
  assert.equal(useVmStatsStore.getState().data, null);
});

test('the config shown takes the list fields and the live run state over the record', async () => {
  const { liveConfig } = await import('./workloadStore.js');
  const record = { name: 'a', state: 'shutoff', vcpus: 2, pendingRestart: { since: 1 } };
  assert.deepEqual(liveConfig(record, { name: 'a', state: 'running' }, ['state', 'pendingRestart'], null),
    { name: 'a', state: 'running', vcpus: 2, pendingRestart: null });
  assert.deepEqual(liveConfig(record, null, ['state'], 'paused'), { ...record, state: 'paused' });
  assert.equal(liveConfig(null, { state: 'running' }, ['state'], null), null);
});

test('a workload store over a name that is not on the wire is refused when it is made', async () => {
  const { createWorkloadStore } = await import('./workloadStore.js');
  const notATopic = 'vmz';
  assert.throws(() => createWorkloadStore({ listTopic: notATopic }), /Unknown events topic: vmz/);
});

test("dismissing a VM's action error clears that error, never the list's", async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', state: 'running' }] });
  stream.frame({ topic: TOPIC.VMS, data: { error: 'LIBVIRT_ERROR', detail: 'Failed to list VMs' } });
  await settle();
  const failing = store.getState().rebootVM('a');
  (await net.nextExact('/api/vms/a/reboot')).respond(jsonResponse({ error: 'VM_NOT_RUNNING', detail: 'Not running' }, 409));
  await failing;
  store.getState().dismissActionError('a');
  assert.equal(store.getState().errors.a, undefined);
  assert.equal(store.getState().error, 'Failed to list VMs');
});

test("the icon change is busy in its own slot, fails into the VM's error slot, and leaves the header actions alone", async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', state: 'running' }] });
  await settle();
  const reboot = store.getState().rebootVM('a');
  const icon = store.getState().setVmIcon('a', 'p4-icon');
  assert.deepEqual(store.getState().actions, { a: 'reboot' });
  assert.deepEqual(store.getState().iconChanges, { a: 'icon' });
  (await net.nextExact('/api/vms/a')).respond(jsonResponse({ error: 'VALIDATION_FAILED', detail: 'Bad icon' }, 400));
  assert.equal(await icon, false);
  assert.deepEqual(store.getState().actions, { a: 'reboot' });
  assert.deepEqual(store.getState().iconChanges, {});
  assert.equal(store.getState().errors.a, 'Bad icon');
  (await net.nextExact('/api/vms/a/reboot')).respond(new Response(null, { status: 204 }));
  await reboot;
});

test("an action's end clears the busy slot only while the slot is still its own run", async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', state: 'running' }] });
  await settle();
  const first = store.getState().rebootVM('a');
  const second = store.getState().stopVM('a');
  assert.deepEqual(store.getState().actions, { a: 'stop' });
  (await net.nextExact('/api/vms/a/reboot')).respond(new Response(null, { status: 204 }));
  await first;
  assert.deepEqual(store.getState().actions, { a: 'stop' });
  (await net.nextExact('/api/vms/a/stop')).respond(new Response(null, { status: 204 }));
  await second;
  assert.deepEqual(store.getState().actions, {});
});
