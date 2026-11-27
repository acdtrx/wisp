import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, respondWithStream, settle } from '../testing/fakeBrowser.js';
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
  store.getState().disconnect();
  store.getState().deselect();
});

const running = (name, uuid) => ({ name, uuid, state: 'running', image: 'img' });

test('a list frame is the list, from the topic alone (no GET)', async () => {
  store.getState().connect();
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  stream.frame({ topic: TOPIC.CONTAINERS, data: [running('a', 'u1')] });
  await settle();
  assert.deepEqual(store.getState().data, [running('a', 'u1')]);
  assert.equal(net.made('/api/containers').length, 0);
});

test('selecting a container opens its stats stream at its interval', async () => {
  store.getState().select('a');
  const request = await net.next('/api/containers/a/stats');
  assert.equal(request.url, '/api/containers/a/stats?intervalMs=3000');
  store.getState().deselect();
  assert.equal(request.signal.aborted, true);
});

test("a container's page takes the list's state, scheduled restart and pending restart over its record", async () => {
  const { liveConfig } = await import('./workloadStore.js');
  const record = { name: 'a', state: 'running', image: 'nginx', scheduledRestart: null, pendingRestart: { since: 1 } };
  const item = { name: 'a', state: 'stopped', scheduledRestart: { attempt: 1, at: 5 } };
  assert.deepEqual(liveConfig(record, item, ['state', 'scheduledRestart', 'pendingRestart']),
    { name: 'a', state: 'stopped', image: 'nginx', scheduledRestart: { attempt: 1, at: 5 }, pendingRestart: null });
});
