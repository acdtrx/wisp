import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { installBrowser, installFetch, jsonResponse, respondWithStream, settle } from '../testing/fakeBrowser.js';
import { CHANGE_KIND, TOPIC } from '../../../shared/wireNames.js';

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

test('all subscribers share one stream, opened by the first and closed by the last', async () => {
  const vms = [];
  const stats = [];
  const offVms = events.subscribeTopic(TOPIC.VMS, (d) => vms.push(d));
  const offStats = events.subscribeTopic(TOPIC.STATS, (d) => stats.push(d));
  const offChanges = events.subscribeChanges([CHANGE_KIND.VM], () => {});
  const stream = await openStream();
  assert.equal(net.made('/api/events').length, 1);

  stream.frame({ topic: TOPIC.VMS, data: ['a'] });
  await settle();
  assert.deepEqual(vms, [['a']]);
  assert.deepEqual(stats, []);

  const request = net.made('/api/events')[0];
  offVms();
  offStats();
  assert.equal(request.signal.aborted, false);
  offChanges();
  assert.equal(request.signal.aborted, true);

  const offAgain = events.subscribeTopic(TOPIC.VMS, () => {});
  assert.equal(net.made('/api/events').length, 2);
  offAgain();
});

test('a dropped stream tells every subscriber', async () => {
  const down = [];
  const offs = [
    events.subscribeTopic(TOPIC.VMS, () => {}, () => down.push('vms 1')),
    events.subscribeTopic(TOPIC.VMS, () => {}, () => down.push('vms 2')),
    events.subscribeTopic(TOPIC.STATS, () => {}, () => down.push('stats')),
  ];
  const stream = await openStream();
  stream.drop();
  await settle();
  assert.deepEqual(down.sort(), ['stats', 'vms 1', 'vms 2']);
  for (const off of offs) off();
});

test('a stream the server ends cleanly tells no subscriber', async () => {
  const down = [];
  const off = events.subscribeTopic(TOPIC.STATS, () => {}, () => down.push('stats'));
  const stream = await openStream();
  stream.end();
  await settle();
  assert.deepEqual(down, []);
  off();
});

test('a topic\'s last frame is kept across a drop and given to a late subscriber, except on changes', async () => {
  const off = events.subscribeTopic(TOPIC.VMS, () => {});
  const offChanges = events.subscribeChanges([CHANGE_KIND.VM], () => {});
  const stream = await openStream();
  stream.frame({ topic: TOPIC.VMS, data: ['a'] });
  stream.frame({ topic: TOPIC.CHANGES, data: { kind: CHANGE_KIND.VM, id: 'a' } });
  await settle();
  stream.drop();
  await settle();

  const late = [];
  const offLate = events.subscribeTopic(TOPIC.VMS, (d) => late.push(d));
  assert.deepEqual(late, [['a']]);
  const lateChanges = [];
  const offLateChanges = events.subscribeChanges([CHANGE_KIND.VM], (c) => lateChanges.push(c));
  assert.deepEqual(lateChanges, []);
  off();
  offChanges();
  offLate();
  offLateChanges();
});

test('the last unsubscribe clears the kept frames', async () => {
  const off = events.subscribeTopic(TOPIC.VMS, () => {});
  const stream = await openStream();
  stream.frame({ topic: TOPIC.VMS, data: ['a'] });
  await settle();
  off();

  const seen = [];
  const offAgain = events.subscribeTopic(TOPIC.VMS, (d) => seen.push(d));
  assert.deepEqual(seen, []);
  offAgain();
});

test('the connect frame { kind: "all" } reaches every change handler; another kind only its own', async () => {
  const seen = [];
  const offVm = events.subscribeChanges([CHANGE_KIND.VM], (c) => seen.push(['vm', c.kind]));
  const offSettings = events.subscribeChanges([CHANGE_KIND.SETTINGS], (c) => seen.push(['settings', c.kind]));
  const stream = await openStream();
  stream.frame({ topic: TOPIC.CHANGES, data: { kind: CHANGE_KIND.ALL } });
  stream.frame({ topic: TOPIC.CHANGES, data: { kind: CHANGE_KIND.VM, id: 'a' } });
  await settle();
  assert.deepEqual(seen, [['vm', 'all'], ['settings', 'all'], ['vm', 'vm']]);
  offVm();
  offSettings();
});

test('a stream Wisp refuses ends: every subscriber, and a late one, is told why; no reconnect', async () => {
  const down = [];
  const off = events.subscribeTopic(TOPIC.STATS, () => {}, (err) => down.push(err));
  const request = await net.next('/api/events');
  request.respond(jsonResponse({ error: 'SCOPE_INSUFFICIENT', detail: 'This route needs an admin token' }, 403));
  await settle();
  assert.equal(down.length, 1);
  assert.deepEqual({ code: down[0].code, status: down[0].status, detail: down[0].detail },
    { code: 'SCOPE_INSUFFICIENT', status: 403, detail: 'This route needs an admin token' });

  const late = [];
  const offLate = events.subscribeTopic(TOPIC.VMS, () => {}, (err) => late.push(err));
  assert.equal(late.length, 1);
  assert.equal(late[0].code, 'SCOPE_INSUFFICIENT');

  mock.timers.tick(120_000);
  await settle();
  assert.equal(net.made('/api/events').length, 1);

  off();
  offLate();
  const again = [];
  const offAgain = events.subscribeTopic(TOPIC.STATS, () => {}, (err) => again.push(err));
  assert.deepEqual(again, []);
  assert.equal(net.made('/api/events').length, 2);
  offAgain();
});

test('a 4xx that is not Wisp\'s (a proxy\'s page) is a lost connection: subscribers told with no error, then a reconnect', async () => {
  const down = [];
  const off = events.subscribeTopic(TOPIC.STATS, () => {}, (err) => down.push(err));
  const request = await net.next('/api/events');
  request.respond(new Response('<html>403 Forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
  await settle();
  assert.deepEqual(down, [undefined]);
  mock.timers.tick(1100);
  await settle();
  assert.equal(net.made('/api/events').length, 2);
  off();
});

test('a topic or change kind that is not on the wire is refused when the code runs', () => {
  assert.throws(() => events.subscribeTopic('vmz', () => {}), /Unknown events topic: vmz/);
  const topicNotKind = TOPIC.VMS; // a topic where a change kind goes: only the run-time check sees it
  assert.throws(() => events.subscribeChanges([CHANGE_KIND.VM, topicNotKind], () => {}), /Unknown change kind: vms/);
  assert.throws(() => events.assertChangeKind(CHANGE_KIND.ALL), /Unknown change kind: all/);
  assert.equal(net.made('/api/events').length, 0);
});

test('reconnectEvents opens the stream anew after a refusal: the subscribers get its frames', async () => {
  const frames = [];
  const off = events.subscribeTopic(TOPIC.VMS, (d) => frames.push(d), () => {});
  (await net.next('/api/events')).respond(jsonResponse({ error: 'SCOPE_INSUFFICIENT', detail: 'No' }, 403));
  await settle();
  events.reconnectEvents();
  const stream = respondWithStream(await net.next('/api/events'));
  await settle();
  stream.frame({ topic: TOPIC.VMS, data: ['a'] });
  await settle();
  assert.deepEqual(frames, [['a']]);
  assert.equal(net.made('/api/events').length, 2);
  off();
});
