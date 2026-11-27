import { getVMDetail } from '../../vmManager/index.js';
import { vmNameSchema } from '../../validation.js';

export const vmTools = [
  {
    name: 'get_vm',
    title: 'VM detail',
    description:
      'Full configuration and state of one virtual machine: its profile (what it was made as: linux, windows-11 or other), vCPUs, memory, disks, NICs, firmware, ' +
      'startedAt (epoch ms, null while off), plus the guest network (IP/hostname via qemu-guest-agent, up to 30 s old; null while off or without the agent).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { ...vmNameSchema, description: 'VM name' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'read',
    handler: ({ name }) => getVMDetail(name),
  },
];
