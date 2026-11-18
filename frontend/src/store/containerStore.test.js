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
  ({ useContainerStore: store } = await import(`./containerStore.js?test=${loaded}`));
});

afterEach(() => {
  // The events module is shared across tests: leave it with no subscriber.
  store.getState().stopContainerListSSE();
  store.getState().deselectContainer();
});

const containerUrl = (name) => (url) => url === `/api/containers/${name}`;

async function answer(match, data) {
  (await net.next(match)).respond(jsonResponse(data));
  await settle();
}

/** Select container `name` and answer its config read. */
async function select(name, config) {
  const selecting = store.getState().selectContainer(name);
  await answer(containerUrl(name), config);
  await selecting;
}

/** Start the list feed: answer its list GET with `list`, then the shared events stream. */
async function startList(list) {
  store.getState().startContainerListSSE();
  await answer((url) => url === '/api/containers', list);
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  return stream;
}

const running = (name, uuid) => ({ name, uuid, state: 'running', image: 'img' });

test('an older read that answers after a newer one does not overwrite it', async () => {
  const selecting = store.getState().selectContainer('a');
  const older = await net.next(containerUrl('a'));
  const refreshing = store.getState().refreshSelectedContainer();
  const newer = await net.next(containerUrl('a'));
  newer.respond(jsonResponse({ ...running('a', 'u1'), cpuLimit: 2 }));
  await settle();
  older.respond(jsonResponse({ ...running('a', 'u1'), cpuLimit: 1 }));
  await Promise.all([selecting, refreshing]);
  assert.equal(store.getState().containerConfig.cpuLimit, 2);
  assert.equal(store.getState().loading, false);
});

test('a list frame updates the list', async () => {
  const stream = await startList([]);
  stream.frame({ topic: 'containers', data: [running('a', 'u1')] });
  await settle();
  assert.deepEqual(store.getState().containers, [running('a', 'u1')]);
  assert.equal(store.getState().listLoaded, true);
});

test('a rename seen on the list is followed, and the config read again under the new name', async () => {
  const stream = await startList([running('a', 'u1')]);
  await select('a', running('a', 'u1'));

  stream.frame({ topic: 'containers', data: [running('b', 'u1')] });
  await settle();
  assert.equal(store.getState().selectedContainer, 'b');
  assert.deepEqual(store.getState().renamedSelection, { from: 'a', to: 'b' });
  await answer(containerUrl('b'), running('b', 'u1'));
  assert.equal(store.getState().containerConfig.name, 'b');
});

test('a container gone from the list is deselected', async () => {
  const stream = await startList([running('a', 'u1')]);
  await select('a', running('a', 'u1'));

  stream.frame({ topic: 'containers', data: [running('c', 'u3')] });
  await settle();
  assert.equal(store.getState().selectedContainer, null);
  assert.equal(store.getState().containerConfig, null);
});

test('an empty list frame does not deselect', async () => {
  const stream = await startList([running('a', 'u1')]);
  await select('a', running('a', 'u1'));

  stream.frame({ topic: 'containers', data: [] });
  await settle();
  assert.equal(store.getState().selectedContainer, 'a');
  assert.deepEqual(store.getState().containers, []);
});
