import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, jsonResponse, respondWithStream, settle } from '../testing/fakeBrowser.js';

let net;
let createStreamStore;
let streamSource;
let loaded = 0;

beforeEach(async () => {
  installBrowser();
  net = installFetch();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  loaded += 1;
  ({ createStreamStore, streamSource } = await import(`./streamStore.js?test=${loaded}`));
});

afterEach(() => {
  mock.timers.reset();
});

/** A store over the scoped stream `/api/s/<id>`, its data the frames that are arrays. */
function listStore(options = {}) {
  return createStreamStore({
    source: streamSource((id) => `/api/s/${id}`),
    toData: (frame) => (Array.isArray(frame) ? frame : undefined),
    ...options,
  });
}

/** Connect `store` to `id` and answer its stream. */
async function connect(store, id = 'a') {
  store.getState().connect(id);
  const request = await net.next(`/api/s/${id}`);
  const stream = respondWithStream(request);
  await settle();
  return { request, stream };
}

const fields = (store) => {
  const { data, connected, error, refused } = store.getState();
  return { data, connected, error, refused };
};

test('before any answer: the empty data, connected null, no error', () => {
  const store = listStore({ empty: [] });
  assert.deepEqual(fields(store), { data: [], connected: null, error: null, refused: false });
});

test('a good frame is the data; an error frame keeps it and says why; the next good frame clears that', async () => {
  const store = listStore();
  const { stream } = await connect(store);
  stream.frame([1]);
  await settle();
  assert.deepEqual(fields(store), { data: [1], connected: true, error: null, refused: false });
  stream.frame({ error: 'LIBVIRT_ERROR', detail: 'Failed to list VMs' });
  await settle();
  assert.deepEqual(fields(store), { data: [1], connected: true, error: 'Failed to list VMs', refused: false });
  stream.frame([2]);
  await settle();
  assert.deepEqual(fields(store), { data: [2], connected: true, error: null, refused: false });
  store.getState().disconnect();
});

test('a frame toData rejects is skipped', async () => {
  const store = listStore();
  const { stream } = await connect(store);
  stream.frame([1]);
  stream.frame({ not: 'a list' });
  await settle();
  assert.deepEqual(fields(store), { data: [1], connected: true, error: null, refused: false });
  store.getState().disconnect();
});

test('a dropped connection keeps the data and the error, and reconnects', async () => {
  const store = listStore();
  const { stream } = await connect(store);
  stream.frame([1]);
  stream.frame({ error: 'X', detail: 'gather failed' });
  await settle();
  stream.drop();
  await settle();
  assert.deepEqual(fields(store), { data: [1], connected: false, error: 'gather failed', refused: false });
  mock.timers.tick(1100);
  await settle();
  assert.equal(net.made('/api/s/a').length, 2);
  store.getState().disconnect();
});

test('a refusal clears the data and shows why; onData sees the cleared data; retry asks again', async () => {
  const seen = [];
  const store = listStore({ empty: [], onData: (data) => seen.push(data) });
  store.getState().connect('a');
  (await net.next('/api/s/a')).respond(jsonResponse({ error: 'VM_NOT_FOUND', detail: 'No VM named a' }, 404));
  await settle();
  assert.deepEqual(fields(store), { data: [], connected: false, error: 'No VM named a', refused: true });
  assert.deepEqual(seen, [[]]);
  store.getState().retry();
  const again = respondWithStream(await net.next('/api/s/a'));
  await settle();
  again.frame([3]);
  await settle();
  assert.deepEqual(fields(store), { data: [3], connected: true, error: null, refused: false });
  store.getState().disconnect();
});

test('onData runs after a good frame is stored, with the data', async () => {
  const seen = [];
  const store = listStore({ onData: (data, set, get) => seen.push([data, get().data]) });
  const { stream } = await connect(store);
  stream.frame([7]);
  await settle();
  assert.deepEqual(seen, [[[7], [7]]]);
  store.getState().disconnect();
});

test('connect opens once; a scoped stream\'s disconnect closes the request and clears the store', async () => {
  const store = listStore({ extend: () => ({ extra: 1 }) });
  const { request, stream } = await connect(store);
  store.getState().connect('a');
  await settle();
  assert.equal(net.made('/api/s/a').length, 1);
  stream.frame([1]);
  await settle();
  store.getState().disconnect();
  assert.equal(request.signal.aborted, true);
  assert.deepEqual(fields(store), { data: null, connected: null, error: null, refused: false });
  assert.equal(store.getState().extra, 1);
});

test('a topic store keeps its data when it disconnects: the next connect is answered with the current frame', async () => {
  const { createStreamStore: make, topicSource } = await import(`./streamStore.js?test=${loaded}`);
  const { TOPIC } = await import('../../../shared/wireNames.js');
  const store = make({ source: topicSource(TOPIC.DISCOVERY) });
  store.getState().connect();
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  stream.frame({ topic: TOPIC.DISCOVERY, data: [{ name: 'peer' }] });
  await settle();
  store.getState().disconnect();
  assert.deepEqual(store.getState().data, [{ name: 'peer' }]);
  assert.equal(store.getState().connected, null);
});
