import { buildHostStatsPayload } from '../../hostStatsSnapshot.js';
import { getHostHardwareInfo } from '../../host/index.js';

export const hostTools = [
  {
    name: 'get_host_stats',
    title: 'Host stats snapshot',
    description:
      'One sample of the live host stats (the same payload the UI streams over SSE): CPU usage and ' +
      'per-core load, temperatures and thermal zones, power draw when available, memory and swap, ' +
      'disk and network throughput, running workload counts, pending OS updates, and Wisp ' +
      'self-update status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'read',
    handler: () => buildHostStatsPayload(),
  },
  {
    name: 'get_host_hardware',
    title: 'Host hardware inventory',
    description:
      'Static hardware inventory of the host: CPU model and topology (P/E cores), DMI board/system/BIOS, ' +
      'RAM modules (slot, type, size, speed), block devices with SMART health summaries, PCI devices ' +
      '(display, network, storage controllers), and GPUs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'read',
    handler: () => getHostHardwareInfo(),
  },
];
