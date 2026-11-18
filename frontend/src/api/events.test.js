import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, respondWithStream, settle } from '../testing/fakeBrowser.js';

let net;
let events;
let loaded = 0;

beforeEach(async () => {
  installBrowser();
  net = installFetch();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // A fresh copy per test: events.js keeps its subscribers and last frames in module state.
  loaded += 1;
  events = await import(`./events.js?test=${loaded}`);
});

afterEach(() => {
  mock.timers.reset();
});

/** Answer the shared stream's next request. */
async function openStream() {
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  return stream;
}

/** Track a promise's settling without awaiting it. */
function track(promise) {
  const state = { done: false, value: undefined };
  promise.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
}

test('all subscribers share one stream, opened by the first and closed by the last', async () => {
  const vms = [];
  const stats = [];
  const offVms = events.subscribeTopic('vms', (d) => vms.push(d));
  const offStats = events.subscribeTopic('stats', (d) => stats.push(d));
  const offChanges = events.subscribeChanges(['vm'], () => {});
  const stream = await openStream();
  assert.equal(net.made('/api/events').length, 1);

  stream.frame({ topic: 'vms', data: ['a'] });
  await settle();
  assert.deepEqual(vms, [['a']]);
  assert.deepEqual(stats, []);

  const request = net.made('/api/events')[0];
  offVms();
  offStats();
  assert.equal(request.signal.aborted, false);
  offChanges();
  assert.equal(request.signal.aborted, true);

  const offAgain = events.subscribeTopic('vms', () => {});
  assert.equal(net.made('/api/events').length, 2);
  offAgain();
});

test('a dropped stream tells every subscriber', async () => {
  const down = [];
  const offs = [
    events.subscribeTopic('vms', () => {}, () => down.push('vms 1')),
    events.subscribeTopic('vms', () => {}, () => down.push('vms 2')),
    events.subscribeTopic('stats', () => {}, () => down.push('stats')),
  ];
  const stream = await openStream();
  stream.drop();
  await settle();
  assert.deepEqual(down.sort(), ['stats', 'vms 1', 'vms 2']);
  for (const off of offs) off();
});

test('a stream the server ends cleanly tells no subscriber', async () => {
  const down = [];
  const off = events.subscribeTopic('stats', () => {}, () => down.push('stats'));
  const stream = await openStream();
  stream.end();
  await settle();
  assert.deepEqual(down, []);
  off();
});

test('a topic\'s last frame is kept across a drop and given to a late subscriber, except on changes', async () => {
  const off = events.subscribeTopic('vms', () => {});
  const offChanges = events.subscribeChanges(['vm'], () => {});
  const stream = await openStream();
  stream.frame({ topic: 'vms', data: ['a'] });
  stream.frame({ topic: 'changes', data: { kind: 'vm', id: 'a' } });
  await settle();
  stream.drop();
  await settle();

  const late = [];
  const offLate = events.subscribeTopic('vms', (d) => late.push(d));
  assert.deepEqual(late, [['a']]);
  const lateChanges = [];
  const offLateChanges = events.subscribeChanges(['vm'], (c) => lateChanges.push(c));
  assert.deepEqual(lateChanges, []);
  off();
  offChanges();
  offLate();
  offLateChanges();
});

test('the last unsubscribe clears the kept frames', async () => {
  const off = events.subscribeTopic('vms', () => {});
  const stream = await openStream();
  stream.frame({ topic: 'vms', data: ['a'] });
  await settle();
  off();

  const seen = [];
  const offAgain = events.subscribeTopic('vms', (d) => seen.push(d));
  assert.deepEqual(seen, []);
  offAgain();
});

test('the connect frame { kind: "all" } reaches every change handler; another kind only its own', async () => {
  const seen = [];
  const offVm = events.subscribeChanges(['vm'], (c) => seen.push(['vm', c.kind]));
  const offSettings = events.subscribeChanges(['settings'], (c) => seen.push(['settings', c.kind]));
  const stream = await openStream();
  stream.frame({ topic: 'changes', data: { kind: 'all' } });
  stream.frame({ topic: 'changes', data: { kind: 'vm', id: 'a' } });
  await settle();
  assert.deepEqual(seen, [['vm', 'all'], ['settings', 'all'], ['vm', 'vm']]);
  offVm();
  offSettings();
});

test('sendAndAwaitTopic ends on the topic\'s next matching frame, with the ack', async () => {
  const off = events.subscribeTopic('vms', () => {});
  const stream = await openStream();
  const wait = track(events.sendAndAwaitTopic('vms', async () => 'ack', (list) => list.includes('b')));
  await settle();
  stream.frame({ topic: 'stats', data: {} });
  stream.frame({ topic: 'vms', data: ['a'] });
  await settle();
  assert.equal(wait.done, false);
  stream.frame({ topic: 'vms', data: ['a', 'b'] });
  await settle();
  assert.deepEqual(wait, { done: true, value: 'ack' });
  off();
});

test('a frame that arrives before the ack still ends the wait', async () => {
  const off = events.subscribeTopic('vms', () => {});
  const stream = await openStream();
  let ack;
  const wait = track(events.sendAndAwaitTopic('vms', () => new Promise((resolve) => { ack = resolve; })));
  stream.frame({ topic: 'vms', data: [] });
  await settle();
  assert.equal(wait.done, false);
  ack('ack');
  await settle();
  assert.deepEqual(wait, { done: true, value: 'ack' });
  off();
});

test('sendAndAwaitChange ends on a change naming its kind and id, or on { kind: "all" }', async () => {
  const off = events.subscribeChanges(['vm'], () => {});
  const stream = await openStream();

  const named = track(events.sendAndAwaitChange('vm', 'a', async () => 'ack'));
  await settle();
  stream.frame({ topic: 'changes', data: { kind: 'vm', id: 'b' } });
  stream.frame({ topic: 'changes', data: { kind: 'container', id: 'a' } });
  await settle();
  assert.equal(named.done, false);
  stream.frame({ topic: 'changes', data: { kind: 'vm', id: 'a' } });
  await settle();
  assert.deepEqual(named, { done: true, value: 'ack' });

  const all = track(events.sendAndAwaitChange('vm', 'a', async () => 'ack'));
  await settle();
  stream.frame({ topic: 'changes', data: { kind: 'all' } });
  await settle();
  assert.equal(all.done, true);
  off();
});

test('sendAndAwaitChange waits for the re-reads the change starts', async () => {
  let finishRead;
  const off = events.subscribeChanges(['vm'], () => new Promise((resolve) => { finishRead = resolve; }));
  const stream = await openStream();
  const wait = track(events.sendAndAwaitChange('vm', 'a', async () => 'ack'));
  await settle();
  stream.frame({ topic: 'changes', data: { kind: 'vm', id: 'a' } });
  await settle();
  assert.equal(wait.done, false);
  finishRead();
  await settle();
  assert.equal(wait.done, true);
  off();
});

test('both waits end with the ack after 30 s without a frame', async () => {
  const off = events.subscribeTopic('vms', () => {});
  const offChanges = events.subscribeChanges(['vm'], () => {});
  await openStream();
  const topic = track(events.sendAndAwaitTopic('vms', async () => 'topic-ack'));
  const change = track(events.sendAndAwaitChange('vm', 'a', async () => 'change-ack'));
  await settle();
  mock.timers.tick(29_999);
  await settle();
  assert.equal(topic.done, false);
  assert.equal(change.done, false);
  mock.timers.tick(1);
  await settle();
  assert.deepEqual(topic, { done: true, value: 'topic-ack' });
  assert.deepEqual(change, { done: true, value: 'change-ack' });
  off();
  offChanges();
});

test('with no stream open, both only send', async () => {
  let sent = 0;
  const send = async () => {
    sent += 1;
    return 'ack';
  };
  assert.equal(await events.sendAndAwaitTopic('vms', send), 'ack');
  assert.equal(await events.sendAndAwaitChange('vm', 'a', send), 'ack');
  assert.equal(sent, 2);
  assert.equal(net.made('/api/events').length, 0);
});

test('a failed send ends the wait with its error', async () => {
  const off = events.subscribeTopic('vms', () => {});
  await openStream();
  await assert.rejects(
    events.sendAndAwaitTopic('vms', async () => { throw new Error('refused'); }),
    /refused/,
  );
  off();
});

test('the last unsubscribe releases the waiting commands with their ack', async () => {
  const off = events.subscribeTopic('vms', () => {});
  await openStream();
  const wait = track(events.sendAndAwaitTopic('vms', async () => 'ack'));
  await settle();
  assert.equal(wait.done, false);
  off();
  await settle();
  assert.deepEqual(wait, { done: true, value: 'ack' });
});
