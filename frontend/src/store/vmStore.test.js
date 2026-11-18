import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, jsonResponse, respondWithStream, settle } from '../testing/fakeBrowser.js';

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
  store.getState().stopVMListSSE();
  store.getState().deselectVM();
});

const vmUrl = (name) => `/api/vms/${name}`;

async function answer(url, data) {
  (await net.nextExact(url)).respond(jsonResponse(data));
  await settle();
}

/** Select VM `name` and answer its config read. */
async function select(name, config) {
  const selecting = store.getState().selectVM(name);
  await answer(vmUrl(name), config);
  await selecting;
}

/** Start the list feed and answer the shared events stream. */
async function startList() {
  store.getState().startVMListSSE();
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  return stream;
}

test('an older read that answers after a newer one does not overwrite it', async () => {
  const selecting = store.getState().selectVM('a');
  const older = await net.nextExact(vmUrl('a'));
  const refreshing = store.getState().refreshSelectedVM();
  const newer = await net.nextExact(vmUrl('a'));
  newer.respond(jsonResponse({ name: 'a', uuid: 'u1', state: 'running', vcpus: 2 }));
  await settle();
  older.respond(jsonResponse({ name: 'a', uuid: 'u1', state: 'running', vcpus: 1 }));
  await Promise.all([selecting, refreshing]);
  assert.equal(store.getState().vmConfig.vcpus, 2);
  assert.equal(store.getState().configLoading, false);
});

test('of two re-reads, the older answering last does not overwrite the newer', async () => {
  await select('a', { name: 'a', uuid: 'u1', state: 'running', vcpus: 1 });
  const first = store.getState().refreshSelectedVM();
  const older = await net.nextExact(vmUrl('a'));
  const second = store.getState().refreshSelectedVM();
  const newer = await net.nextExact(vmUrl('a'));
  newer.respond(jsonResponse({ name: 'a', uuid: 'u1', state: 'running', vcpus: 3 }));
  await settle();
  older.respond(jsonResponse({ name: 'a', uuid: 'u1', state: 'running', vcpus: 2 }));
  await Promise.all([first, second]);
  assert.equal(store.getState().vmConfig.vcpus, 3);
});

test('a list frame updates the list', async () => {
  const stream = await startList();
  stream.frame({ topic: 'vms', data: [{ name: 'a', state: 'running' }] });
  await settle();
  assert.deepEqual(store.getState().vms, [{ name: 'a', state: 'running' }]);
  assert.equal(store.getState().listLoaded, true);
});

test('a rename seen on the list is followed, and the config read again under the new name', async () => {
  const stream = await startList();
  stream.frame({ topic: 'vms', data: [{ name: 'a', uuid: 'u1', state: 'running' }] });
  await settle();
  await select('a', { name: 'a', uuid: 'u1', state: 'running' });

  stream.frame({ topic: 'vms', data: [{ name: 'b', uuid: 'u1', state: 'running' }] });
  await settle();
  assert.equal(store.getState().selectedVM, 'b');
  assert.deepEqual(store.getState().renamedSelection, { from: 'a', to: 'b' });
  await answer(vmUrl('b'), { name: 'b', uuid: 'u1', state: 'running' });
  assert.equal(store.getState().vmConfig.name, 'b');
});

test('a VM gone from the list is deselected', async () => {
  const stream = await startList();
  stream.frame({ topic: 'vms', data: [{ name: 'a', uuid: 'u1', state: 'running' }] });
  await settle();
  await select('a', { name: 'a', uuid: 'u1', state: 'running' });

  stream.frame({ topic: 'vms', data: [{ name: 'c', uuid: 'u3', state: 'running' }] });
  await settle();
  assert.equal(store.getState().selectedVM, null);
  assert.equal(store.getState().vmConfig, null);
});

test('an empty list frame deselects', async () => {
  const stream = await startList();
  stream.frame({ topic: 'vms', data: [{ name: 'a', uuid: 'u1', state: 'running' }] });
  await settle();
  await select('a', { name: 'a', uuid: 'u1', state: 'running' });

  stream.frame({ topic: 'vms', data: [] });
  await settle();
  assert.equal(store.getState().selectedVM, null);
});
