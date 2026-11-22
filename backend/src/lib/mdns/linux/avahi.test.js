/*
 * The mDNS bus reopen after a system bus failure, with dbus-next faked
 * (node --test --experimental-test-module-mocks) and the clock mocked: each
 * fake bus is healthy, or fails as soon as it is made, as the test says.
 */
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

const fake = { healthy: true, buses: [] };

class FakeBus extends EventEmitter {
  constructor() {
    super();
    this.healthy = fake.healthy;
    fake.buses.push({ bus: this, at: Date.now() });
    // A bus that cannot connect reports it as an 'error', as dbus-next does.
    if (!this.healthy) queueMicrotask(() => this.emit('error', new Error('connect ENOENT /run/dbus/system_bus_socket')));
  }

  async getProxyObject(name) {
    if (!this.healthy) throw new Error('not connected');
    const iface = new EventEmitter();
    if (name === 'org.freedesktop.Avahi') iface.GetHostNameFqdn = async () => 'mi-nest.local';
    return { getInterface: () => iface };
  }

  async call() {
    if (!this.healthy) throw new Error('not connected');
  }

  disconnect() {}
}

mock.module('dbus-next', {
  defaultExport: { systemBus: () => new FakeBus(), Message: class { constructor(fields) { Object.assign(this, fields); } } },
});
mock.module(new URL('./forwarder.js', import.meta.url).href, {
  namedExports: { startForwarder: async () => {}, stopForwarder: async () => {} },
});
mock.timers.enable({ apis: ['setTimeout', 'Date'] });

const { connect, disconnect } = await import('./avahi.js');
const log = { debug() {}, info() {}, warn() {}, error() {} };

/** Let promises settle between fake clock steps. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Advance the fake clock second by second for `seconds`, settling after each. */
async function advance(seconds) {
  for (let i = 0; i < seconds; i++) {
    mock.timers.tick(1000);
    await settle();
  }
}

test('a bus that fails is reopened, and a reopen that succeeds ends the retries', async () => {
  fake.healthy = true;
  fake.buses.length = 0;
  await connect(log);
  assert.equal(fake.buses.length, 1);
  fake.buses[0].bus.emit('error', new Error('write EPIPE'));
  await settle();
  await advance(2);
  assert.equal(fake.buses.length, 2, 'reopened after 2 s');
  await advance(600);
  assert.equal(fake.buses.length, 2, 'no further reopen once one succeeded');
  await disconnect();
});

test('a bus that keeps failing is retried on a backoff capped at 30 s, never faster', async () => {
  fake.healthy = true;
  fake.buses.length = 0;
  await connect(log);
  fake.healthy = false;
  const failedAt = Date.now();
  fake.buses[0].bus.emit('error', new Error('write EPIPE'));
  await settle();
  await advance(300);
  const times = [failedAt, ...fake.buses.slice(1).map((b) => b.at)];
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 1000);
  assert.deepEqual(gaps.slice(0, 5), [2, 4, 8, 16, 30]);
  for (const gap of gaps.slice(5)) assert.equal(gap, 30);
  assert.ok(gaps.length >= 9, `${gaps.length} reopens in 300 s`);
  fake.healthy = true;
  await advance(30);
  const count = fake.buses.length;
  await advance(300);
  assert.equal(fake.buses.length, count, 'the loop ends once the bus is back');
  await disconnect();
});

test('a bus that fails after disconnect is not reopened', async () => {
  fake.healthy = true;
  fake.buses.length = 0;
  await connect(log);
  const { bus } = fake.buses[0];
  await disconnect();
  bus.emit('error', new Error('write EPIPE'));
  await advance(120);
  assert.equal(fake.buses.length, 1);
});
