import { getVMConfig, getGuestNetwork } from '../../vmManager/index.js';

export const vmTools = [
  {
    name: 'get_vm',
    title: 'VM detail',
    description:
      'Full configuration and state of one virtual machine: vCPUs, memory, disks, NICs, firmware, ' +
      'plus the guest network (IP/hostname via qemu-guest-agent, null when the agent is absent).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'VM name' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    scope: 'read',
    handler: async ({ name }) => {
      const config = await getVMConfig(name);
      let guestNetwork = { ip: null, hostname: null };
      try {
        guestNetwork = await getGuestNetwork(name);
      } catch {
        /* stopped VM or no guest agent — network unknown */
      }
      return { ...config, guestNetwork };
    },
  },
];
