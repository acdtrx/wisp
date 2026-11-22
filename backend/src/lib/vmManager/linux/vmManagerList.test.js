/*
 * The VM list's cache and its announcements, with libvirt faked: the
 * connection module is mocked (node --test --experimental-test-module-mocks),
 * so ListDomains, each domain's reads, and the connection's signals are the
 * test's.
 */
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { vmError } from '../vmManagerShared.js';

/** The faked libvirt: domain path → its summary; `down` fails every call. */
const libvirt = { domains: new Map(), down: false, reads: 0 };
const signals = {};

function notFound() {
  return new Error('Domain not found: no domain with matching uuid');
}

const connectionState = {
  watchEvents: true,
  logger: null,
  // The bounded interface's property read: a failure tells the call-failed subscribers.
  connectProps: {
    Get: async () => {
      if (!libvirt.down) return 12000000;
      signals.callFailed();
      throw new Error("Failed to connect socket to '/var/run/libvirt/libvirt-sock'");
    },
  },
  connectIface: {
    ListDomains: async () => {
      libvirt.reads += 1;
      if (libvirt.down) throw new Error("Failed to connect socket to '/var/run/libvirt/libvirt-sock'");
      return [...libvirt.domains.keys()];
    },
  },
};

const url = (path) => new URL(path, import.meta.url).href;
mock.module(url('./vmManagerConnection.js'), {
  namedExports: {
    connectionState,
    vmError,
    unwrapVariant: (v) => v,
    resolveDomain: async () => { throw vmError('VM_NOT_FOUND', 'not found'); },
    getDomainXML: async () => '',
    isDomainNotFound: (err) => (err?.message || '').includes('Domain not found'),
    getDomainObjAndIface: async (path) => ({
      iface: {
        GetXMLDesc: async () => {
          const d = libvirt.domains.get(path);
          if (!d) throw notFound();
          return JSON.stringify(d);
        },
        GetState: async () => {
          const d = libvirt.domains.get(path);
          if (!d) throw notFound();
          return [d.stateCode];
        },
      },
    }),
    subscribeDomainChange: (h) => { signals.domainChange = h; return () => {}; },
    subscribeDisconnect: (h) => { signals.disconnect = h; return () => {}; },
    subscribeCallFailed: (h) => { signals.callFailed = h; return () => {}; },
  },
});
mock.module(url('../../storage/index.js'), { namedExports: { getDiskInfo: async () => ({ virtualSize: 0 }) } });
mock.module(url('./vmManagerXml.js'), { namedExports: { parseVMFromXML: (xml) => JSON.parse(xml) } });
mock.module(url('./vmManagerProc.js'), {
  namedExports: { isVMBinaryStale: async () => false, getQemuStartTimeMs: async () => null },
});

const { listVMs, pingLibvirt, subscribeVMListChange } = await import('./vmManagerList.js');

/** Each announcement the subscribers got: a list's names, or null for an error. */
const frames = [];
subscribeVMListChange((list) => { frames.push(list ? list.map((v) => v.name) : null); });

function define(name, stateCode = 5) {
  libvirt.domains.set(`/org/libvirt/QEMU/domain/_${name}`, { name, uuid: name, vcpus: 1, memoryMiB: 256, stateCode });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  // A disconnect: the list is stale and the next outcome is announced afresh.
  signals.disconnect();
  libvirt.domains.clear();
  libvirt.down = false;
  libvirt.reads = 0;
  frames.length = 0;
});

test('a subscriber whose own libvirt call fails on every change cannot set off read after read', async () => {
  define('a');
  let failingCalls = 0;
  const unsubscribe = subscribeVMListChange(() => {
    // Home's gather: a reporting call that fails, which marks the list stale.
    failingCalls += 1;
    signals.callFailed();
  });
  await listVMs();
  assert.equal(frames.length, 1);
  // 2 s of 5 s-stats-like ticks at a fake 5 ms each: the stats gather asks every tick.
  const ticks = 400;
  for (let i = 0; i < ticks; i++) {
    await listVMs();
    signals.callFailed();
  }
  assert.ok(libvirt.reads <= ticks + 1, `${libvirt.reads} reads for ${ticks} ticks`);
  assert.equal(frames.length, 1, 'no frame after the first');
  assert.equal(failingCalls, 1);
  unsubscribe();
});

test('list to error announces one error; the same error again announces nothing', async () => {
  define('a');
  await listVMs();
  libvirt.down = true;
  signals.callFailed();
  await assert.rejects(listVMs(), (err) => err.code === 'LIBVIRT_ERROR');
  await assert.rejects(listVMs(), (err) => err.code === 'LIBVIRT_ERROR');
  assert.deepEqual(frames, [['a'], null]);
});

test('error to list announces the list', async () => {
  libvirt.down = true;
  define('a');
  await assert.rejects(listVMs());
  libvirt.down = false;
  assert.deepEqual((await listVMs()).map((v) => v.name), ['a']);
  assert.deepEqual(frames, [null, ['a']]);
});

test('a read that gives the same list announces nothing, a DomainEvent refresh included', async () => {
  define('a');
  await listVMs();
  signals.callFailed();
  await listVMs();
  signals.domainChange();
  await settle();
  assert.equal(libvirt.reads, 3);
  assert.deepEqual(frames, [['a']]);
  libvirt.domains.get('/org/libvirt/QEMU/domain/_a').stateCode = 1;
  signals.domainChange();
  await settle();
  assert.deepEqual(frames, [['a'], ['a']]);
  assert.equal((await listVMs())[0].state, 'running');
});

test('a domain gone between ListDomains and its read is left out, not an error', async () => {
  define('a');
  define('b');
  const real = connectionState.connectIface.ListDomains;
  connectionState.connectIface.ListDomains = async () => {
    const paths = await real();
    libvirt.domains.delete('/org/libvirt/QEMU/domain/_b');
    return paths;
  };
  try {
    assert.deepEqual((await listVMs()).map((v) => v.name), ['a']);
  } finally {
    connectionState.connectIface.ListDomains = real;
  }
  assert.deepEqual(frames, [['a']]);
});

/** One host stats tick: the libvirt question, then the list the stats read. */
async function statsTick() {
  await pingLibvirt();
  try {
    return await listVMs();
  } catch {
    return null;
  }
}

test('a healthy stats tick reads no list and announces nothing', async () => {
  define('a');
  await statsTick();
  for (let i = 0; i < 20; i++) await statsTick();
  assert.equal(libvirt.reads, 1);
  assert.deepEqual(frames, [['a']]);
});

test('a stats tick whose libvirt question fails marks the list stale: the same tick reads and announces the error', async () => {
  define('a');
  await statsTick();
  libvirt.down = true;
  assert.equal(await statsTick(), null);
  assert.equal(libvirt.reads, 2);
  assert.deepEqual(frames, [['a'], null]);
  libvirt.down = false;
  assert.deepEqual((await statsTick()).map((v) => v.name), ['a']);
  assert.deepEqual(frames, [['a'], null, ['a']]);
});
