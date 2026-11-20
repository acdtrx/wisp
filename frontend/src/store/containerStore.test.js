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
  ({ useContainerStore: store } = await import(`./containerStore.js?test=${loaded}`));
});

afterEach(() => {
  // The events module is shared across tests: leave it with no subscriber.
  store.getState().disconnect();
  store.getState().deselect();
});

const containerUrl = (name) => `/api/containers/${name}`;

async function answer(url, data) {
  (await net.nextExact(url)).respond(jsonResponse(data));
  await settle();
}

/** Select container `name` and answer its config read. */
async function select(name, config) {
  const selecting = store.getState().select(name);
  await answer(containerUrl(name), config);
  await selecting;
}

/** Start the list feed on the shared events stream, its first frame `list`. */
async function startList(list) {
  store.getState().connect();
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  stream.frame({ topic: TOPIC.CONTAINERS, data: list });
  await settle();
  return stream;
}

const running = (name, uuid) => ({ name, uuid, state: 'running', image: 'img' });

test('an older read that answers after a newer one does not overwrite it', async () => {
  const selecting = store.getState().select('a');
  const older = await net.nextExact(containerUrl('a'));
  const refreshing = store.getState().refreshSelected();
  const newer = await net.nextExact(containerUrl('a'));
  newer.respond(jsonResponse({ ...running('a', 'u1'), cpuLimit: 2 }));
  await settle();
  older.respond(jsonResponse({ ...running('a', 'u1'), cpuLimit: 1 }));
  await Promise.all([selecting, refreshing]);
  assert.equal(store.getState().config.cpuLimit, 2);
  assert.equal(store.getState().configLoading, false);
});

test('of two re-reads, the older answering last does not overwrite the newer', async () => {
  await select('a', { ...running('a', 'u1'), cpuLimit: 1 });
  const first = store.getState().refreshSelected();
  const older = await net.nextExact(containerUrl('a'));
  const second = store.getState().refreshSelected();
  const newer = await net.nextExact(containerUrl('a'));
  newer.respond(jsonResponse({ ...running('a', 'u1'), cpuLimit: 3 }));
  await settle();
  older.respond(jsonResponse({ ...running('a', 'u1'), cpuLimit: 2 }));
  await Promise.all([first, second]);
  assert.equal(store.getState().config.cpuLimit, 3);
});

test('a list frame updates the list', async () => {
  const stream = await startList([]);
  stream.frame({ topic: TOPIC.CONTAINERS, data: [running('a', 'u1')] });
  await settle();
  assert.deepEqual(store.getState().data, [running('a', 'u1')]);
  assert.equal(store.getState().connected, true);
});

test('a rename seen on the list is followed, and the config read again under the new name', async () => {
  const stream = await startList([running('a', 'u1')]);
  await select('a', running('a', 'u1'));

  stream.frame({ topic: TOPIC.CONTAINERS, data: [running('b', 'u1')] });
  await settle();
  assert.equal(store.getState().selected, 'b');
  assert.deepEqual(store.getState().renamedSelection, { from: 'a', to: 'b' });
  await answer(containerUrl('b'), running('b', 'u1'));
  assert.equal(store.getState().config.name, 'b');
});

test('a container gone from the list is deselected', async () => {
  const stream = await startList([running('a', 'u1')]);
  await select('a', running('a', 'u1'));

  stream.frame({ topic: TOPIC.CONTAINERS, data: [running('c', 'u3')] });
  await settle();
  assert.equal(store.getState().selected, null);
  assert.equal(store.getState().config, null);
});

test('an empty list frame does not deselect', async () => {
  const stream = await startList([running('a', 'u1')]);
  await select('a', running('a', 'u1'));

  stream.frame({ topic: TOPIC.CONTAINERS, data: [] });
  await settle();
  assert.equal(store.getState().selected, 'a');
  assert.deepEqual(store.getState().data, []);
});

test('a list field the item lacks is null in the config', async () => {
  const stream = await startList([{ ...running('a', 'u1'), pendingRestart: { since: 1 } }]);
  await select('a', { ...running('a', 'u1'), pendingRestart: { since: 1 } });
  stream.frame({ topic: TOPIC.CONTAINERS, data: [running('a', 'u1')] });
  await settle();
  assert.equal(store.getState().config.pendingRestart, null);
  assert.equal(store.getState().config.scheduledRestart, null);
});
