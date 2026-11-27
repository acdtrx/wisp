/*
 * The VM read's guest network, with libvirt faked: the connection and the VM
 * list are mocked (node --test --experimental-test-module-mocks), so the saved
 * configuration and the guest agent's answers are the test's. The guest is
 * asked only while the VM runs with the agent, at most once per 30 s, through
 * the cache the stats stream fills too.
 */
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { vmError } from '../vmManagerShared.js';

/** The faked VMs, by name: their saved configuration, and their guest agent. */
const vms = new Map();
const agentCalls = [];

function agentOf(name) {
  return {
    InterfaceAddresses: async () => {
      agentCalls.push(name);
      const vm = vms.get(name);
      if (!vm.agent) throw new Error('Guest agent is not responding: QEMU guest agent is not connected');
      return [['lo', '', [[0, '127.0.0.1', 8]]], ['enp1s0', '52:54:00:00:00:01', [[0, vm.agent.ip, 24]]]];
    },
    GetHostname: async () => {
      const vm = vms.get(name);
      if (!vm.agent) throw new Error('Guest agent is not responding: QEMU guest agent is not connected');
      return vm.agent.hostname;
    },
  };
}

const url = (path) => new URL(path, import.meta.url).href;
mock.module(url('./vmManagerConnection.js'), {
  exports: {
    connectionState: { prevVMStats: new Map(), vmStartTimes: new Map(), agentSubscriptions: new Map(), logger: null },
    vmError,
    unwrapVariant: (v) => v,
    unwrapDict: (v) => v,
    resolveDomain: async (name) => {
      if (!vms.has(name)) throw vmError('VM_NOT_FOUND', `VM "${name}" not found`);
      return `/org/libvirt/domain/${name}`;
    },
    getDomainXML: async () => '',
    getDomainObjAndIface: async (path) => {
      const name = path.split('/').pop();
      return { iface: { GetStats: async () => ({}), GetState: async () => [vms.get(name).config.stateCode] }, agentIface: agentOf(name) };
    },
    subscribeAgentEvent: () => () => {},
    attachAgentSubscription: async () => {},
    detachAgentSubscription: () => {},
  },
});
mock.module(url('./vmManagerList.js'), {
  exports: {
    getVMConfig: async (name) => {
      if (!vms.has(name)) throw vmError('VM_NOT_FOUND', `VM "${name}" not found`);
      return { _hostdevs: [], ...vms.get(name).config };
    },
    subscribeVMListChange: () => () => {},
    getCachedStaleBinary: () => false,
    getCachedVcpus: (name) => vms.get(name)?.config.vcpus,
    getCachedGuestAgent: (name) => vms.get(name)?.config.guestAgent ?? false,
    getCachedStateCode: (name) => vms.get(name)?.config.stateCode,
    getCachedDomainPath: () => undefined,
    getCachedStartedAt: (name) => vms.get(name)?.config.startedAt,
  },
});
mock.module(url('./vmManagerXml.js'), { exports: { parseVMFromXML: () => null } });

const { getVMDetail, getVMStats } = await import('./vmManagerStats.js');

let n = 0;
/** A VM of a name of its own (the cache outlives a test), in state `stateCode`. */
function define({ stateCode = 1, guestAgent = true, agent = { ip: '192.168.1.10', hostname: 'guest' } } = {}) {
  n += 1;
  const name = `vm-${n}`;
  const startedAt = stateCode === 5 ? null : 1768392000000;
  vms.set(name, { config: { name, state: 'x', stateCode, vcpus: 2, guestAgent, startedAt }, agent });
  return name;
}

beforeEach(() => {
  agentCalls.length = 0;
  mock.timers.reset();
});

test("a running VM with the agent reads its guest's address and name, and when it started", async () => {
  const name = define();
  const vm = await getVMDetail(name);
  assert.deepEqual(vm.guestNetwork, { ip: '192.168.1.10', hostname: 'guest' });
  assert.equal(vm.startedAt, 1768392000000);
  assert.equal('_hostdevs' in vm, false);
});

test('a VM that is off, paused or has no agent reads nulls, and the guest is not asked', async () => {
  for (const vm of [define({ stateCode: 5 }), define({ stateCode: 3 }), define({ guestAgent: false })]) {
    assert.deepEqual((await getVMDetail(vm)).guestNetwork, { ip: null, hostname: null });
  }
  assert.deepEqual(agentCalls, []);
  assert.equal((await getVMDetail(define({ stateCode: 5 }))).startedAt, null);
});

test('a guest that does not answer reads nulls, never a failed read', async () => {
  const name = define({ agent: null });
  assert.deepEqual((await getVMDetail(name)).guestNetwork, { ip: null, hostname: null });
});

test('the guest is asked at most once per 30 s, by the read and the stats stream together', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const name = define();
  await getVMStats(name);
  await getVMDetail(name);
  await getVMDetail(name);
  assert.equal(agentCalls.length, 1);

  vms.get(name).agent = { ip: '192.168.1.99', hostname: 'renamed' };
  mock.timers.tick(29_000);
  assert.equal((await getVMDetail(name)).guestNetwork.ip, '192.168.1.10');
  mock.timers.tick(1_000);
  assert.deepEqual((await getVMDetail(name)).guestNetwork, { ip: '192.168.1.99', hostname: 'renamed' });
  assert.equal(agentCalls.length, 2);
  assert.equal((await getVMStats(name)).guestIp, '192.168.1.99');
  assert.equal(agentCalls.length, 2);
});

test('an unknown VM is VM_NOT_FOUND', async () => {
  await assert.rejects(getVMDetail('gone'), { code: 'VM_NOT_FOUND' });
});
