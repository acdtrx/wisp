/**
 * The deployment aggregate — one join over settings, host identity, bridges,
 * every container (list summary + its full `container.json`) and every VM
 * (+ guest network when running).
 *
 * Two consumers, one join (CODING-RULES §2): the MCP `get_deployment_overview`
 * tool projects `buildDeploymentOverview()` straight out, and the Home page's
 * tile derivation (`lib/homeTiles.js`) reads `gatherDeployment()` for the
 * appConfig/services detail the MCP shape doesn't carry. Keeping both on the
 * same gather means a workload that appears to one always appears to the other.
 */
import { getSettings } from './settings.js';
import { getCurrentVersion } from './wispUpdate.js';
import { getHostInfo, listVMs, getGuestNetwork } from './vmManager/index.js';
import { listContainers, getContainerConfig } from './containerManager/index.js';
import { listHostBridges } from './networking/index.js';

/**
 * @typedef {object} DeploymentContainer
 * @property {object} summary — the `listContainers()` row (name, state, image, iconId, …)
 * @property {object|null} config — the full container config, or null when
 *   `container.json` was unreadable (mid-create, mid-delete, malformed).
 */

/**
 * @typedef {object} DeploymentVM
 * @property {object} vm — the `listVMs()` row
 * @property {{ ip: string|null, hostname: string|null }} net — guest-agent
 *   network snapshot; all-null when the VM is stopped or the agent is silent.
 */

/**
 * Gather the whole deployment in one pass.
 *
 * @returns {Promise<{
 *   settings: object,
 *   hostInfo: object,
 *   bridges: object[],
 *   containers: DeploymentContainer[],
 *   vms: DeploymentVM[],
 * }>}
 */
export async function gatherDeployment() {
  const [settings, hostInfo, bridges, containers, vms] = await Promise.all([
    getSettings(),
    getHostInfo(),
    listHostBridges(),
    listContainers(),
    listVMs(),
  ]);

  const containerEntries = await Promise.all(containers.map(async (summary) => {
    try {
      return { summary, config: await getContainerConfig(summary.name) };
    } catch {
      /* container.json unreadable — callers fall back to the containerd-level summary */
      return { summary, config: null };
    }
  }));

  const vmEntries = await Promise.all(vms.map(async (vm) => {
    let net = { ip: null, hostname: null };
    if (vm.state === 'running') {
      try {
        net = await getGuestNetwork(vm.name);
      } catch {
        /* guest agent not running — IP unknown */
      }
    }
    return { vm, net };
  }));

  return {
    settings,
    hostInfo,
    bridges,
    containers: containerEntries,
    vms: vmEntries,
  };
}

/**
 * Project the aggregate into the MCP `get_deployment_overview` payload. The
 * field set and ordering here are the tool's public contract — change them
 * only alongside docs/spec/MCP.md.
 */
export async function buildDeploymentOverview() {
  const deployment = await gatherDeployment();
  const { settings, hostInfo, bridges } = deployment;

  const containers = deployment.containers.map(({ summary, config }) => {
    const base = {
      name: summary.name,
      state: summary.state,
      image: summary.image,
      updateAvailable: summary.updateAvailable === true,
    };
    if (!config) return base;
    // A stopped container's persisted address is only a DHCP lease
    // memory — the lease may have been reassigned to another workload
    // by now, so never present it as a current `ip`.
    const running = summary.state === 'running';
    return {
      ...base,
      ip: running ? config.network?.ip ?? null : null,
      ...(running ? {} : { lastKnownIp: config.network?.ip ?? null }),
      bridge: config.network?.interface ?? null,
      mdnsName: config.localDns ? `${summary.name}.local` : null,
      app: config.metadata?.app ?? null,
      autostart: config.autostart === true,
      autoBackup: config.autoBackup === true,
      restartPolicy: config.restartPolicy ?? null,
    };
  });

  // No autostart on VMs here: listVMs() items don't carry it (only the full
  // getVMConfig does) — use get_vm for per-VM detail.
  const vms = deployment.vms.map(({ vm, net }) => ({
    name: vm.name,
    state: vm.state,
    vcpus: vm.vcpus,
    memoryMiB: vm.memoryMiB,
    osCategory: vm.osCategory ?? null,
    ip: net.ip ?? null,
    guestHostname: net.hostname ?? null,
    mdnsName: vm.localDns ? `${vm.name}.local` : null,
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
    containers,
    vms,
  };
}
