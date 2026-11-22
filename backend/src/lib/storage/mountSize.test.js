/*
 * The bounded mount size read, with the worker faked (node --test
 * --experimental-test-module-mocks) and the clock mocked: each fake worker
 * answers, fails or hangs as the test says.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

/** What each new worker does, by mount path: 'answer', 'fail' or 'hang'. */
const behaviour = new Map();
const started = [];

class FakeWorker extends EventEmitter {
  constructor(_url, { workerData }) {
    super();
    started.push(workerData.mountPath);
    const what = behaviour.get(workerData.mountPath);
    queueMicrotask(() => {
      if (what === 'answer') this.emit('message', { sizes: { totalBytes: 100, usedBytes: 40, availBytes: 60 } });
      if (what === 'fail') this.emit('message', { error: { code: 'EIO', message: 'EIO: i/o error' } });
    });
  }

  unref() {}
}

mock.module('node:worker_threads', { namedExports: { Worker: FakeWorker } });
mock.timers.enable({ apis: ['setTimeout', 'Date'] });

const { readMountSize, mountSizeReadsInFlight, MOUNT_SIZE_BOUND_MS } = await import('./mountSize.js');

beforeEach(() => {
  behaviour.clear();
  started.length = 0;
});

test('a mount that answers gives its sizes, and leaves no read in flight', async () => {
  behaviour.set('/ok', 'answer');
  assert.deepEqual(await readMountSize('/ok'), { sizes: { totalBytes: 100, usedBytes: 40, availBytes: 60 } });
  assert.equal(mountSizeReadsInFlight(), 0);
});

test('a read that fails is no size, with its error', async () => {
  behaviour.set('/bad', 'fail');
  assert.deepEqual(await readMountSize('/bad'), { error: { code: 'EIO', message: 'EIO: i/o error' } });
});

test('a mount that does not answer: the first read waits the bound once, later ones answer at once without a new worker', async () => {
  behaviour.set('/dead', 'hang');
  const first = readMountSize('/dead');
  mock.timers.tick(MOUNT_SIZE_BOUND_MS);
  assert.deepEqual(await first, { timedOut: true });
  for (let i = 0; i < 10; i++) assert.deepEqual(await readMountSize('/dead'), { timedOut: true });
  assert.deepEqual(started, ['/dead']);
  assert.equal(mountSizeReadsInFlight(), 1);
});

test('a read joined before its bound gets the answer when it comes', async () => {
  behaviour.set('/slow', 'answer');
  const [a, b] = await Promise.all([readMountSize('/slow'), readMountSize('/slow')]);
  assert.deepEqual(a, b);
  assert.deepEqual(started, ['/slow']);
});
