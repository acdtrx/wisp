import { getSettings } from '../../settings.js';
import { getCurrentVersion } from '../../wispUpdate.js';
import { getHostInfo, listVMs, getGuestNetwork } from '../../vmManager/index.js';
import { listContainers, getContainerConfig } from '../../containerManager/index.js';
import { listHostBridges } from '../../networking/index.js';

export const overviewTools = [
  {
    name: 'get_deployment_overview',
    title: 'Deployment overview',
    description:
      'One-call map of everything on this Wisp host: wisp version, host identity, network bridges, ' +
      'sidebar sections, every container (state, image, LAN IP, mDNS name, app template, autostart) ' +
      'and every VM (state, resources, LAN IP when the guest agent reports one). Start here to ' +
      'understand the deployment; drill into a workload with get_container / get_vm.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'read',
    handler: async () => {
      const [settings, hostInfo, bridges, containers, vms] = await Promise.all([
        getSettings(),
        getHostInfo(),
        listHostBridges(),
        listContainers(),
        listVMs(),
      ]);

      const containerDetails = await Promise.all(containers.map(async (c) => {
        const summary = {
          name: c.name,
          state: c.state,
          image: c.image,
          updateAvailable: c.updateAvailable === true,
        };
        try {
          const cfg = await getContainerConfig(c.name);
          return {
            ...summary,
            ip: cfg.network?.ip ?? null,
            bridge: cfg.network?.interface ?? null,
            mdnsName: cfg.localDns ? `${c.name}.local` : null,
            app: cfg.metadata?.app ?? null,
            autostart: cfg.autostart === true,
            restartPolicy: cfg.restartPolicy ?? null,
          };
        } catch {
          /* container.json unreadable — keep the containerd-level summary */
          return summary;
        }
      }));

      const vmDetails = await Promise.all(vms.map(async (vm) => {
        let net = { ip: null, hostname: null };
        if (vm.state === 'running') {
          try {
            net = await getGuestNetwork(vm.name);
          } catch {
            /* guest agent not running — IP unknown */
          }
        }
        return {
          name: vm.name,
          state: vm.state,
          vcpus: vm.vcpus,
          memoryMiB: vm.memoryMiB,
          autostart: vm.autostart === true,
          ip: net.ip ?? null,
          guestHostname: net.hostname ?? null,
          mdnsName: vm.localDns ? `${vm.name}.local` : null,
        };
      }));

      return {
        wispVersion: getCurrentVersion(),
        serverName: settings.serverName,
        host: {
          hostname: hostInfo.hostname,
          kernel: hostInfo.kernel,
          primaryAddress: hostInfo.primaryAddress ?? null,
          uptimeSeconds: hostInfo.uptimeSeconds,
          libvirtVersion: hostInfo.libvirtVersion ?? null,
          qemuVersion: hostInfo.qemuVersion ?? null,
        },
        bridges,
        sections: (settings.sections || []).map((s) => ({ id: s.id, name: s.name })),
        containers: containerDetails,
        vms: vmDetails,
      };
    },
  },
];
