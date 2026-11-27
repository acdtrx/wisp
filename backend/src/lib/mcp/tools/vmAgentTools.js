/**
 * A VM's lifecycle — agent scope (an admin token calls them too): start, force
 * stop and restart, the commands the REST routes run (lib/vmOperations.js),
 * their lock included — a busy VM answers VM_BUSY. Nothing that changes what
 * a VM is: creating, editing, its devices, pause and resume stay off MCP.
 *
 * Start and force stop are jobs, as on the REST API: the tool checks what it
 * can at once (those errors return immediately), starts the job and returns
 * its ack `{ jobId, kind, title, subject }`; `get_job` reads it to the end. A
 * restart is a request the guest acts on: it answers at once.
 */
import { vmNameSchema } from '../../validation.js';
import { startVmStartJob, startVmForceStopJob, requestVmReboot } from '../../vmOperations.js';

const JOB_NOTE = 'A job: returns { jobId, kind, title, subject } at once; read it with get_job until it is done.';

const nameOnly = {
  type: 'object',
  properties: { name: { ...vmNameSchema, description: 'VM name' } },
  required: ['name'],
  additionalProperties: false,
};

export const vmAgentTools = [
  {
    name: 'start_vm',
    title: 'Start a VM',
    description: 'Start a stopped virtual machine. Its job ends once QEMU runs; the guest then boots on its own. ' + JOB_NOTE,
    inputSchema: nameOnly,
    scope: 'agent',
    handler: async ({ name }, { log } = {}) => startVmStartJob({ name, log }),
  },
  {
    name: 'force_stop_vm',
    title: 'Force stop a VM',
    description:
      'Power a running virtual machine off at once, as pulling its plug: the guest gets no chance to shut down ' +
      'and loses what it has not written. ' + JOB_NOTE,
    inputSchema: nameOnly,
    scope: 'agent',
    handler: async ({ name }, { log } = {}) => startVmForceStopJob({ name, log }),
  },
  {
    name: 'restart_vm',
    title: 'Restart a VM',
    description:
      'Ask a running virtual machine\'s guest to restart, and answer { name } at once: nothing tells when the guest ' +
      'is back up (get_vm shows its state and address). The guest keeps the running settings; a saved change ' +
      'waits for a stop and a start.',
    inputSchema: nameOnly,
    scope: 'agent',
    handler: async ({ name }) => {
      await requestVmReboot(name);
      return { name };
    },
  },
];
