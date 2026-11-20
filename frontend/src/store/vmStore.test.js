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

const vmUrl = (name) => `/api/vms/${name}`;

async function answer(url, data) {
  (await net.nextExact(url)).respond(jsonResponse(data));
  await settle();
}

/** Select VM `name` and answer its config read. */
async function select(name, config) {
  const selecting = store.getState().select(name);
  await answer(vmUrl(name), config);
  await selecting;
}

/** Start the list feed and answer the shared events stream. */
async function startList() {
  store.getState().connect();
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  return stream;
}

test('an older read that answers after a newer one does not overwrite it', async () => {
  const selecting = store.getState().select('a');
  const older = await net.nextExact(vmUrl('a'));
  const refreshing = store.getState().refreshSelected();
  const newer = await net.nextExact(vmUrl('a'));
  newer.respond(jsonResponse({ name: 'a', uuid: 'u1', state: 'running', vcpus: 2 }));
  await settle();
  older.respond(jsonResponse({ name: 'a', uuid: 'u1', state: 'running', vcpus: 1 }));
  await Promise.all([selecting, refreshing]);
  assert.equal(store.getState().config.vcpus, 2);
  assert.equal(store.getState().configLoading, false);
});

test('of two re-reads, the older answering last does not overwrite the newer', async () => {
  await select('a', { name: 'a', uuid: 'u1', state: 'running', vcpus: 1 });
  const first = store.getState().refreshSelected();
  const older = await net.nextExact(vmUrl('a'));
  const second = store.getState().refreshSelected();
  const newer = await net.nextExact(vmUrl('a'));
  newer.respond(jsonResponse({ name: 'a', uuid: 'u1', state: 'running', vcpus: 3 }));
  await settle();
  older.respond(jsonResponse({ name: 'a', uuid: 'u1', state: 'running', vcpus: 2 }));
  await Promise.all([first, second]);
  assert.equal(store.getState().config.vcpus, 3);
});

test('a list frame updates the list', async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', state: 'running' }] });
  await settle();
  assert.deepEqual(store.getState().data, [{ name: 'a', state: 'running' }]);
  assert.equal(store.getState().connected, true);
});

test('a rename seen on the list is followed, and the config read again under the new name', async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', uuid: 'u1', state: 'running' }] });
  await settle();
  await select('a', { name: 'a', uuid: 'u1', state: 'running' });

  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'b', uuid: 'u1', state: 'running' }] });
  await settle();
  assert.equal(store.getState().selected, 'b');
  assert.deepEqual(store.getState().renamedSelection, { from: 'a', to: 'b' });
  await answer(vmUrl('b'), { name: 'b', uuid: 'u1', state: 'running' });
  assert.equal(store.getState().config.name, 'b');
});

test('a VM gone from the list is deselected', async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', uuid: 'u1', state: 'running' }] });
  await settle();
  await select('a', { name: 'a', uuid: 'u1', state: 'running' });

  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'c', uuid: 'u3', state: 'running' }] });
  await settle();
  assert.equal(store.getState().selected, null);
  assert.equal(store.getState().config, null);
});

test('an empty list frame does not deselect: it may mean libvirt is down', async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', uuid: 'u1', state: 'running' }] });
  await settle();
  await select('a', { name: 'a', uuid: 'u1', state: 'running' });

  stream.frame({ topic: TOPIC.VMS, data: [] });
  await settle();
  assert.equal(store.getState().selected, 'a');
  assert.deepEqual(store.getState().data, []);
});

test('an error frame on the list keeps the list and shows the error', async () => {
  const stream = await startList();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a', state: 'running' }] });
  stream.frame({ topic: TOPIC.VMS, data: { error: 'LIBVIRT_ERROR', detail: 'Failed to list VMs' } });
  await settle();
  assert.deepEqual(store.getState().data, [{ name: 'a', state: 'running' }]);
  assert.equal(store.getState().error, 'Failed to list VMs');
});

test("a stats frame carries a new state into the config, and leaves it be when the state is the same", async () => {
  await select('a', { name: 'a', uuid: 'u1', state: 'running', vcpus: 1 });
  const stats = respondWithStream(await net.next('/api/vms/a/stats'));
  await settle();
  const before = store.getState().config;
  stats.frame({ state: 'running', active: true });
  await settle();
  assert.equal(store.getState().config, before);
  stats.frame({ state: 'paused', active: true });
  await settle();
  assert.equal(store.getState().config.state, 'paused');
});

test("an action's error is cleared when the next action on that VM begins", async () => {
  const failing = store.getState().rebootVM('a');
  (await net.nextExact('/api/vms/a/reboot')).respond(jsonResponse({ error: 'VM_NOT_RUNNING', detail: 'Not running' }, 409));
  assert.equal(await failing, false);
  assert.equal(store.getState().errors['action:a'].message, 'Not running');
  const next = store.getState().rebootVM('a');
  assert.equal(store.getState().errors['action:a'], undefined);
  (await net.nextExact('/api/vms/a/reboot')).respond(new Response(null, { status: 204 }));
  assert.equal(await next, true);
});

test('a workload store over a name that is not on the wire is refused when it is made', async () => {
  const { createWorkloadStore } = await import('./workloadStore.js');
  assert.throws(() => createWorkloadStore({ listTopic: 'vmz', changeKind: CHANGE_KIND.VM }), /Unknown events topic: vmz/);
  assert.throws(() => createWorkloadStore({ listTopic: TOPIC.VMS, changeKind: 'vmz' }), /Unknown change kind: vmz/);
});
