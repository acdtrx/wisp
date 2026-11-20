import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppError } from '../lib/appErrors.js';
import { eventFrame, latestGatherSender } from './events.js';
import { TOPIC } from '../../../shared/wireNames.js';

/** A gather the test settles by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a topic whose gather fails sends the error body as its data, the cause redacted", async () => {
  const frames = [];
  const failures = [];
  const err = createAppError('LIBVIRT_ERROR', 'Failed to list VMs', "Failed to connect socket to '/var/run/libvirt/libvirt-sock'");
  const send = latestGatherSender((topic, data) => frames.push({ topic, data }), TOPIC.VMS, async () => { throw err; }, (e) => failures.push(e));
  await send();
  assert.deepEqual(frames, [{
    topic: TOPIC.VMS,
    data: { error: 'LIBVIRT_ERROR', detail: "Failed to list VMs: Failed to connect socket to '<path>'" },
  }]);
  assert.deepEqual(failures, [err]);
});

test('only the latest gather started sends its frame, its error frame included', async () => {
  const frames = [];
  const gathers = [deferred(), deferred()];
  let n = 0;
  const send = latestGatherSender((topic, data) => frames.push({ topic, data }), TOPIC.VMS, () => gathers[n++].promise, () => {});
  const first = send();
  const second = send();
  gathers[1].resolve(['new']);
  await second;
  gathers[0].reject(createAppError('LIBVIRT_ERROR', 'Failed to list VMs'));
  await first;
  assert.deepEqual(frames, [{ topic: TOPIC.VMS, data: ['new'] }]);
});

test('a frame names a topic and a change kind of the wire, or is refused', () => {
  assert.equal(eventFrame(TOPIC.VMS, []), `data: ${JSON.stringify({ topic: TOPIC.VMS, data: [] })}\n\n`);
  assert.throws(() => eventFrame('vmz', []), /Unknown events topic: vmz/);
  assert.throws(() => eventFrame(TOPIC.CHANGES, { kind: 'vms' }), /Unknown change kind: vms/);
  assert.throws(() => latestGatherSender(() => {}, 'homes', async () => ({}), () => {}), /Unknown events topic: homes/);
});
