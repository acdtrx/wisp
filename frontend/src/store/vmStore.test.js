import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, jsonResponse, respondWithStream, settle } from '../testing/fakeBrowser.js';
import { CHANGE_KIND, TOPIC } from '../../../shared/wireNames.js';

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
  assert.equal(store.getState().errors['action:a'].message, 'Not running');
  const next = store.getState().rebootVM('a');
  assert.equal(store.getState().errors['action:a'], undefined);
  (await net.nextExact('/api/vms/a/reboot')).respond(jsonResponse({ error: 'VM_NOT_RUNNING', detail: 'Still not' }, 409));
  assert.equal(await next, false);
  stream.frame({ topic: TOPIC.VMS, data: [] });
  await settle();
  assert.equal(store.getState().errors['action:a'], undefined);
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
  assert.throws(() => createWorkloadStore({ listTopic: notATopic, changeKind: CHANGE_KIND.VM }), /Unknown events topic: vmz/);
  assert.throws(() => createWorkloadStore({ listTopic: TOPIC.VMS, changeKind: notATopic }), /Unknown change kind: vmz/);
});

test("a rename on the list moves the VM's undismissed error to its new name", async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', uuid: 'u1', state: 'running' }] });
  await settle();
  const failing = store.getState().rebootVM('a');
  (await net.nextExact('/api/vms/a/reboot')).respond(jsonResponse({ error: 'VM_NOT_RUNNING', detail: 'Not running' }, 409));
  await failing;
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'b', uuid: 'u1', state: 'running' }] });
  await settle();
  assert.equal(store.getState().errors['action:a'], undefined);
  assert.equal(store.getState().errors['action:b'].message, 'Not running');
});

test("a rename seen across a refused stream still moves the VM's error: the refusal is no list", async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', uuid: 'u1', state: 'running' }] });
  await settle();
  const failing = store.getState().rebootVM('a');
  (await net.nextExact('/api/vms/a/reboot')).respond(jsonResponse({ error: 'VM_NOT_RUNNING', detail: 'Not running' }, 409));
  await failing;
  // The stream is asked again and refused: the list empties, the error stays.
  store.getState().retry();
  (await net.next('/api/events')).respond(jsonResponse({ error: 'FORBIDDEN', detail: 'No' }, 403));
  await settle();
  assert.equal(store.getState().errors['action:a'].message, 'Not running');
  // Asked again, the next list has the VM renamed: its error follows it.
  store.getState().retry();
  const again = respondWithStream(await net.next('/api/events'));
  await settle();
  again.frame({ topic: TOPIC.VMS, data: [{ name: 'b', uuid: 'u1', state: 'running' }] });
  await settle();
  assert.equal(store.getState().errors['action:a'], undefined);
  assert.equal(store.getState().errors['action:b'].message, 'Not running');
});
