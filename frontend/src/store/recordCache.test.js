import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, respondWithStream, settle } from '../testing/fakeBrowser.js';
import { ApiError } from '../api/errors.js';
import { CHANGE_KIND, TOPIC } from '../../../shared/wireNames.js';

let net;
let createRecordCache;
let sendAndAwaitChange;
let loaded = 0;

beforeEach(async () => {
  installBrowser();
  net = installFetch();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  loaded += 1;
  ({ createRecordCache } = await import(`./recordCache.js?test=${loaded}`));
  ({ sendAndAwaitChange } = await import('../api/events.js'));
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

/** A cache over one kind `thing` (id'd, gone on `THING_NOT_FOUND`) with `cues`, its reads answered by hand. */
function cacheWith(cues = [], spec = {}) {
  const reads = handFetch();
  const cache = createRecordCache({ thing: { fetch: reads.fetch, goneCodes: ['THING_NOT_FOUND'], cues, ...spec } });
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
  assert.deepEqual(a.now(), { data: { v: 1 }, status: 'ready', error: null, reading: false });
  assert.equal(b.now(), a.now());
  a.off();
  b.off();
  (await events()).end();
});

test('an older answer that lands after a newer one is not shown', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  cache.reread('thing', 'a');
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
  cache.reread('thing', 'a');
  reads.calls[0].reject(new ApiError({ status: 500, code: 'X', detail: 'old failure' }));
  await settle();
  assert.equal(v.now().status, 'loading');
  reads.calls[1].resolve({ v: 2 });
  await settle();
  assert.deepEqual(v.now(), { data: { v: 2 }, status: 'ready', error: null, reading: false });
  v.off();
});

/** Two reads of one record, settled in `order`; resolves what each read's promise answered. */
async function twoReads(order) {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  reads.calls[0].resolve({ v: 0 });
  await settle();
  const older = cache.reread('thing', 'a');
  const newer = cache.reread('thing', 'a');
  const outcomes = [];
  older.then((ok) => outcomes.push(['older', ok]));
  newer.then((ok) => outcomes.push(['newer', ok]));
  const fail = new ApiError({ status: 503, code: 'X', detail: 'down' });
  for (const step of order) {
    const [which, how] = step.split(' ');
    const call = reads.calls[which === 'older' ? 1 : 2];
    if (how === 'ok') call.resolve({ v: which });
    else call.reject(fail);
    await settle();
  }
  const result = { older: await older, newer: await newer, reading: v.now().reading };
  v.off();
  return result;
}

test('a replaced read that fails takes the newest read\'s outcome, in every order', async () => {
  assert.deepEqual(await twoReads(['newer ok', 'older fail']), { older: true, newer: true, reading: false });
  assert.deepEqual(await twoReads(['older fail', 'newer ok']), { older: true, newer: true, reading: false });
  assert.deepEqual(await twoReads(['newer fail', 'older fail']), { older: false, newer: false, reading: false });
  assert.deepEqual(await twoReads(['older fail', 'newer fail']), { older: false, newer: false, reading: false });
});

test('a Retry after a replaced failure settles, and a command waiting on it ends', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  reads.calls[0].resolve({ v: 0 });
  await settle();
  const older = cache.reread('thing', 'a');
  cache.reread('thing', 'a');
  reads.calls[2].resolve({ v: 2 });
  await settle();
  reads.calls[1].reject(new ApiError({ status: 503, code: 'X', detail: 'down' }));
  assert.equal(await older, true);
  await settle();
  assert.equal(v.now().reading, false);
  const retry = cache.reload('thing', 'a');
  reads.calls[3].resolve({ v: 3 });
  assert.equal(await retry, true);
  v.off();
});

test('the newest read failing keeps the data shown, and an older answer landing after it keeps the error', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  reads.calls[0].resolve({ v: 1 });
  await settle();
  cache.reread('thing', 'a');
  cache.reread('thing', 'a');
  const failure = new ApiError({ status: 503, code: 'NO_CONNECTION', detail: 'libvirt is down' });
  reads.calls[2].reject(failure);
  await settle();
  // The older read is still on its way.
  assert.deepEqual(v.now(), { data: { v: 1 }, status: 'error', error: failure, reading: true });
  reads.calls[1].resolve({ v: 2 });
  await settle();
  assert.deepEqual(v.now(), { data: { v: 2 }, status: 'error', error: failure, reading: false });
  cache.dismiss('thing', 'a');
  assert.deepEqual(v.now(), { data: { v: 2 }, status: 'ready', error: null, reading: false });
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
  assert.deepEqual(v.now(), { data: { v: 1 }, status: 'ready', error: null, reading: false });
  v.off();
});

test("the kind's own not-found is gone, not an error; an answer equal to the shown one keeps its object", async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  reads.calls[0].resolve({ v: 1 });
  await settle();
  const shown = v.now().data;
  cache.reload('thing', 'a');
  reads.calls[1].resolve({ v: 1 });
  await settle();
  assert.equal(v.now().data, shown);
  cache.reload('thing', 'a');
  reads.calls[2].reject(new ApiError({ status: 404, code: 'THING_NOT_FOUND', detail: 'No thing named a' }));
  await settle();
  assert.deepEqual(v.now(), { data: null, status: 'gone', error: null, reading: false });
  v.off();
});

test('any other 404 is an error, and a kind with no not-found code is never gone', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  const other = new ApiError({ status: 404, code: 'OTHER_NOT_FOUND', detail: 'No route' });
  reads.calls[0].reject(other);
  await settle();
  assert.deepEqual(v.now(), { data: null, status: 'error', error: other, reading: false });
  v.off();
  const plain = cacheWith([], { goneCodes: undefined });
  const w = follow(plain.cache);
  plain.reads.calls[0].reject(new ApiError({ status: 404, code: 'THING_NOT_FOUND', detail: 'x' }));
  await settle();
  assert.equal(w.now().status, 'error');
  w.off();
});

test('a Retry joins the read on its way, and shows it busy; a command\'s re-read is always a new read', async () => {
  const { cache, reads } = cacheWith();
  const v = follow(cache);
  assert.equal(v.now().reading, true);
  const joined = cache.reload('thing', 'a');
  assert.equal(reads.calls.length, 1);
  reads.calls[0].resolve({ v: 1 });
  await joined;
  assert.equal(v.now().reading, false);
  cache.reload('thing', 'a');
  assert.equal(reads.calls.length, 2);
  cache.reread('thing', 'a');
  assert.equal(reads.calls.length, 3);
  reads.calls[1].resolve({ v: 1 });
  reads.calls[2].resolve({ v: 2 });
  await settle();
  assert.deepEqual(v.now().data, { v: 2 });
  v.off();
});

test('a record without an id keeps its last data for the session; sign-out drops it', async () => {
  const reads = handFetch();
  const cache = createRecordCache({ one: { fetch: reads.fetch, singleton: true, cues: [] } });
  const first = cache.subscribe('one', undefined, () => {});
  reads.calls[0].resolve({ v: 1 });
  await settle();
  first();
  assert.deepEqual(cache.get('one'), { data: { v: 1 }, status: 'ready', error: null, reading: false });
  const again = cache.subscribe('one', undefined, () => {});
  assert.equal(reads.calls.length, 2);
  assert.deepEqual(cache.get('one').data, { v: 1 });
  assert.equal(cache.get('one').reading, true);
  cache.clear();
  assert.equal(reads.calls[1].signal.aborted, true);
  assert.equal(cache.get('one').status, 'loading');
  assert.equal(cache.get('one').data, null);
  again();
});

test('a cue of a kind no command waits for gives the frame nothing to wait on', async () => {
  const { cache, reads } = cacheWith([{ change: CHANGE_KIND.CONTAINER, byId: true }], { awaited: false });
  const v = follow(cache);
  reads.calls[0].resolve({ v: 1 });
  const stream = await events();
  let done = false;
  sendAndAwaitChange(CHANGE_KIND.CONTAINER, 'a', async () => ({ ok: true })).then(() => { done = true; });
  await settle();
  stream.frame({ topic: TOPIC.CHANGES, data: { kind: CHANGE_KIND.CONTAINER, id: 'a' } });
  await settle();
  // The re-read is on its way, unanswered, and the command has ended.
  assert.equal(reads.calls.length, 2);
  assert.equal(done, true);
  reads.calls[1].resolve({ v: 1 });
  v.off();
  stream.end();
});

test('when nothing shows a keyed record any more, its reads are aborted and nothing is kept', async () => {
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
  reads.calls[0].resolve({ v: 1 });
  const stream = await events();
  stream.frame({ topic: TOPIC.CHANGES, data: { kind: CHANGE_KIND.VM, id: 'b' } });
  await settle();
  assert.equal(reads.calls.length, 1);
  let done = false;
  sendAndAwaitChange(CHANGE_KIND.VM, 'a', async () => ({ ok: true })).then(() => { done = true; });
  await settle();
  stream.frame({ topic: TOPIC.CHANGES, data: { kind: CHANGE_KIND.VM, id: 'a' } });
  await settle();
  assert.equal(reads.calls.length, 2);
  // The command waits for the re-read its frame started.
  assert.equal(done, false);
  reads.calls[1].resolve({ v: 2 });
  await settle();
  assert.equal(done, true);
  stream.frame({ topic: TOPIC.CHANGES, data: { kind: CHANGE_KIND.ALL } });
  await settle();
  assert.equal(reads.calls.length, 3);
  reads.calls[2].resolve({ v: 2 });
  v.off();
  stream.end();
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
