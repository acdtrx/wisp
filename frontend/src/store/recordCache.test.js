import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, respondWithStream, settle } from '../testing/fakeBrowser.js';
import { ApiError } from '../api/errors.js';
import { CHANGE_KIND, TOPIC } from '../../../shared/wireNames.js';

let net;
let createRecordCache;
let loaded = 0;

beforeEach(async () => {
  installBrowser();
  net = installFetch();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  loaded += 1;
  ({ createRecordCache } = await import(`./recordCache.js?test=${loaded}`));
});

afterEach(() => {
  mock.timers.reset();
});

/** A fetch the test answers by hand: `calls` holds `{ id, signal, resolve, reject }` per read. */
function handFetch() {
  const calls = [];
  const fetch = (id, { signal }) => new Promise((resolve, reject) => {
    calls.push({ id, signal, resolve, reject });
  });
  return { calls, fetch };
}

/** A cache over one kind `thing` (id'd) with `cues`, its reads answered by hand. */
function cacheWith(cues = []) {
  const reads = handFetch();
  const cache = createRecordCache({ thing: { fetch: reads.fetch, cues } });
  return { cache, reads };
}

/** Follow `thing` `id`; returns the unsubscribe and the snapshots seen. */
function follow(cache, id = 'a') {
  const seen = [];
  const off = cache.subscribe('thing', id, () => seen.push(cache.get('thing', id)));
  return { off, seen, now: () => cache.get('thing', id) };
}

/** Answer the shared events stream (opened by the cache's cue subscriptions). */
async function events() {
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  return stream;
}

test('a record is read once for everyone who shows it, and loading until it answers', async () => {
  const { cache, reads } = cacheWith();
  const a = follow(cache);
  const b = follow(cache);
  assert.equal(reads.calls.length, 1);
  assert.equal(a.now().status, 'loading');
  reads.calls[0].resolve({ v: 1 });
  await settle();
  assert.deepEqual(a.now(), { data: { v: 1 }, status: 'ready', error: null, reads: 1 });
  assert.equal(b.now(), a.now());
  a.off();
  b.off();
  (await events()).end();
});

test('an older answer that lands after a newer one is not shown', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  cache.reload('thing', 'a');
  reads.calls[1].resolve({ v: 2 });
  await settle();
  reads.calls[0].resolve({ v: 1 });
  await settle();
  assert.deepEqual(v.now().data, { v: 2 });
  v.off();
});

test('a failed read that a newer read has replaced shows nothing', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  cache.reload('thing', 'a');
  reads.calls[0].reject(new ApiError({ status: 500, code: 'X', detail: 'old failure' }));
  await settle();
  assert.equal(v.now().status, 'loading');
  reads.calls[1].resolve({ v: 2 });
  await settle();
  assert.deepEqual(v.now(), { data: { v: 2 }, status: 'ready', error: null, reads: 1 });
  v.off();
});

test('the newest read failing keeps the data shown, and an older answer landing after it keeps the error', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  reads.calls[0].resolve({ v: 1 });
  await settle();
  cache.reload('thing', 'a');
  cache.reload('thing', 'a');
  const failure = new ApiError({ status: 503, code: 'NO_CONNECTION', detail: 'libvirt is down' });
  reads.calls[2].reject(failure);
  await settle();
  assert.deepEqual(v.now(), { data: { v: 1 }, status: 'error', error: failure, reads: 1 });
  reads.calls[1].resolve({ v: 2 });
  await settle();
  assert.deepEqual(v.now(), { data: { v: 2 }, status: 'error', error: failure, reads: 2 });
  cache.dismiss('thing', 'a');
  assert.deepEqual(v.now(), { data: { v: 2 }, status: 'ready', error: null, reads: 2 });
  v.off();
});

test('a read sent after a failure clears it when it succeeds', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  reads.calls[0].reject(new ApiError({ status: 503, code: 'X', detail: 'down' }));
  await settle();
  assert.equal(v.now().status, 'error');
  assert.equal(v.now().data, null);
  cache.reload('thing', 'a');
  reads.calls[1].resolve({ v: 1 });
  await settle();
  assert.deepEqual(v.now(), { data: { v: 1 }, status: 'ready', error: null, reads: 1 });
  v.off();
});

test('a 404 is gone, not an error; an answer equal to the shown one keeps its object', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  reads.calls[0].resolve({ v: 1 });
  await settle();
  const shown = v.now().data;
  cache.reload('thing', 'a');
  reads.calls[1].resolve({ v: 1 });
  await settle();
  assert.equal(v.now().data, shown);
  assert.equal(v.now().reads, 2);
  cache.reload('thing', 'a');
  reads.calls[2].reject(new ApiError({ status: 404, code: 'VM_NOT_FOUND', detail: 'No VM named a' }));
  await settle();
  assert.deepEqual(v.now(), { data: null, status: 'gone', error: null, reads: 2 });
  v.off();
});

test('when nothing shows the record any more, its reads are aborted and nothing is kept', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  v.off();
  assert.equal(reads.calls[0].signal.aborted, true);
  reads.calls[0].resolve({ v: 1 });
  await settle();
  const again = follow(cache);
  assert.equal(again.now().status, 'loading');
  assert.equal(reads.calls.length, 2);
  again.off();
});

test('a change naming the record reads it again, and the reconnect frame reads every record; the frame waits for the read', async () => {
  const { cache, reads } = cacheWith([{ change: CHANGE_KIND.VM, byId: true }]);
  const v = follow(cache, 'a');
  const stream = await events();
  stream.frame({ topic: TOPIC.CHANGES, data: { kind: CHANGE_KIND.VM, id: 'b' } });
  await settle();
  assert.equal(reads.calls.length, 1);
  stream.frame({ topic: TOPIC.CHANGES, data: { kind: CHANGE_KIND.VM, id: 'a' } });
  await settle();
  assert.equal(reads.calls.length, 2);
  stream.frame({ topic: TOPIC.CHANGES, data: { kind: CHANGE_KIND.ALL } });
  await settle();
  assert.equal(reads.calls.length, 3);
  v.off();
});

test('a topic cue with a key reads again only when the key changes; error frames are skipped', async () => {
  const { cache, reads } = cacheWith([{ topic: TOPIC.VMS, key: (list, id) => list.some((x) => x.name === id) }]);
  const v = follow(cache, 'a');
  const stream = await events();
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a' }] });
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'a' }, { name: 'b' }] });
  stream.frame({ topic: TOPIC.VMS, data: { error: 'LIBVIRT_ERROR', detail: 'Failed' } });
  await settle();
  assert.equal(reads.calls.length, 1);
  stream.frame({ topic: TOPIC.VMS, data: [{ name: 'b' }] });
  await settle();
  assert.equal(reads.calls.length, 2);
  v.off();
});

test('a topic cue with no key reads again on every frame after the first', async () => {
  const { cache, reads } = cacheWith([{ topic: TOPIC.BACKUPS }]);
  const v = follow(cache, 'a');
  const stream = await events();
  stream.frame({ topic: TOPIC.BACKUPS, data: {} });
  await settle();
  assert.equal(reads.calls.length, 1);
  stream.frame({ topic: TOPIC.BACKUPS, data: {} });
  await settle();
  assert.equal(reads.calls.length, 2);
  v.off();
});

test('a kind is checked when the table is made, and an unknown kind when it is followed', () => {
  assert.throws(() => createRecordCache({ x: { fetch: () => {}, cues: [{ change: 'nope' }] } }), /Unknown change kind: nope/);
  assert.throws(() => createRecordCache({ x: { fetch: () => {}, cues: [{ topic: 'nope' }] } }), /Unknown events topic: nope/);
  const { cache } = cacheWith();
  assert.throws(() => cache.subscribe('other', 'a', () => {}), /Unknown record kind: other/);
});
