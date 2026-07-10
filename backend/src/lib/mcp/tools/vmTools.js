import { getVMConfig, getGuestNetwork, listSnapshots } from '../../vmManager/index.js';

export const vmTools = [
  {
    name: 'get_vm',
    title: 'VM detail',
    description:
      'Full configuration and state of one virtual machine: vCPUs, memory, disks, NICs, firmware, ' +
      'plus the guest network (IP/hostname via qemu-guest-agent, null when the agent is absent) and ' +
      'the snapshot list.',
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
      let snapshots = [];
      try {
        snapshots = await listSnapshots(name);
      } catch {
        /* snapshot listing unavailable (e.g. non-qcow2) — omit */
      }
      return { ...config, guestNetwork, snapshots };
    },
  },
];
