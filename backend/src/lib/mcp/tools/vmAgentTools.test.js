/*
 * The VM lifecycle tools through the MCP server, with the VM manager's facade
 * mocked (node --test --experimental-test-module-mocks): the operations, the
 * job starter and the lock are the real ones.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createEmitter } from '../../base/index.js';
import { JOB_KIND } from '../../../../../shared/wireNames.js';

const facade = new URL('../../vmManager/index.js', import.meta.url);
const listChange = createEmitter('test VM list', () => undefined);
let stateCode = 1;
const impl = {
  assertVMState: async () => {},
  stopVM: async () => {},
  listVMs: async () => [{ name: 's', stateCode }],
  isShutOff: (code) => code === 5,
  subscribeVMListChange: listChange.subscribe,
};
// Every name the facade exports, so whatever the tools import from it links.
const names = [...readFileSync(facade, 'utf8').matchAll(/^export const (\w+)/gm)].map(([, name]) => name);
mock.module(facade.href, {
  exports: Object.fromEntries(names.map((name) => [name, (...args) => impl[name]?.(...args)])),
});

const { handleMcpMessage } = await import('../mcpServer.js');
const { whenJobEnds } = await import('../../jobs/index.js');

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };

test('stop_vm returns the stop job\'s ack', async () => {
  const { body } = await handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stop_vm', arguments: { name: 's' } } },
    { scope: 'agent', log },
  );
  const ack = body.result.structuredContent;
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(ack, { jobId: ack.jobId, kind: JOB_KIND.VM_STOP, title: 'Stop s', subject: { type: 'vm', name: 's' } });
  assert.equal(typeof ack.jobId, 'string');
  // The VM goes off: the job ends, and leaves no wait behind.
  stateCode = 5;
  listChange.emit([{ name: 's', stateCode }]);
  assert.equal(await whenJobEnds(ack.jobId), 'done');
});
