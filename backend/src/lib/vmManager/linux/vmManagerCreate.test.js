/*
 * deleteVM's stop before the undefine, with libvirt faked: the connection
 * module is mocked (node --test --experimental-test-module-mocks).
 */
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { vmError } from '../vmManagerShared.js';

const RUNNING = 1;
const SHUTOFF = 5;
/** The faked domain: its state as each GetState read answers it, and the calls made. */
const domain = { states: [], destroyFails: false, calls: [] };

const iface = {
  Destroy: async () => {
    domain.calls.push('Destroy');
    if (domain.destroyFails) throw new Error('Requested operation is not valid: domain is not running');
  },
  Undefine: async (flags) => { domain.calls.push(['Undefine', flags]); },
};

const url = (path) => new URL(path, import.meta.url).href;
mock.module(url('./vmManagerConnection.js'), {
  exports: {
    connectionState: { vmStartTimes: new Map(), prevVMStats: new Map(), logger: null },
    vmError,
    generateMAC: () => '52:54:00:00:00:01',
    resolveDomain: async () => '/org/libvirt/QEMU/domain/_v',
    domainExists: async () => true,
    getDomainState: async () => {
      const code = domain.states.length > 1 ? domain.states.shift() : domain.states[0];
      return { code };
    },
    getDomainXML: async () => '<domain><name>v</name><os><type>hvm</type></os></domain>',
    getDomainObjAndIface: async () => ({ iface }),
    getLibvirtInterface: async () => ({}),
  },
});
mock.module(url('../../storage/index.js'), {
  exports: {
    resizeDisk: async () => {}, copyAndConvert: async () => {}, getDiskInfo: async () => ({}),
    imageFormatForFile: async () => 'qcow2', inspectDiskImage: async () => {},
  },
});
mock.module(url('../../networking/index.js'), { exports: { getDefaultBridge: async () => 'br0' } });
mock.module(url('./vmManagerList.js'), { exports: { refreshVMListCache: () => {} } });

const { setVmManagerPaths } = await import('./vmManagerPaths.js');
const { deleteVM } = await import('./vmManagerCreate.js');
setVmManagerPaths({ vmsPath: '/nonexistent/wisp-test-vms' });

beforeEach(() => {
  domain.states = [];
  domain.destroyFails = false;
  domain.calls = [];
});

test('a VM that finished shutting down as its Destroy ran is deleted', async () => {
  domain.states = [RUNNING, SHUTOFF];
  domain.destroyFails = true;
  await deleteVM('v', false);
  assert.deepEqual(domain.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['Destroy', 'Undefine']);
});

test('a VM still running after a failed Destroy is not deleted', async () => {
  domain.states = [RUNNING, RUNNING];
  domain.destroyFails = true;
  await assert.rejects(deleteVM('v', false), (err) => err.code === 'LIBVIRT_ERROR' && err.message.includes('Failed to stop VM "v"'));
  assert.deepEqual(domain.calls, ['Destroy']);
});

test('a shut off VM is undefined without a Destroy', async () => {
  domain.states = [SHUTOFF];
  await deleteVM('v', false);
  assert.deepEqual(domain.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['Undefine']);
});
