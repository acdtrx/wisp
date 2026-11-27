/**
 * The deployment aggregate — one join over settings, host identity, bridges,
 * every container (list summary + its full `container.json`) and every VM
 * (+ guest network when running).
 *
 * Two consumers, one join (CODING-RULES §2): `GET /api/overview` and the MCP
 * `get_deployment_overview` tool both answer `buildDeploymentOverview()`, and the Home page's
 * tile derivation (`lib/homeTiles.js`) reads `gatherDeployment()` for the
 * appConfig/services detail the MCP shape doesn't carry. Keeping both on the
 * same gather means a workload that appears to one always appears to the other.
 */
import { getSettings } from './settings.js';
import { getCurrentVersion } from './wispUpdate.js';
import { getHostInfo, listVMs, getGuestNetwork } from './vmManager/index.js';
import { listContainers, getContainerConfig } from './containerManager/index.js';
import { listHostBridges } from './networking/index.js';
import { getHeldCertificateSummary } from './hostCertificateStore.js';

/**
 * @typedef {object} DeploymentContainer
 * @property {object} summary — the `listContainers()` row (name, state, image, iconId, …)
 * @property {object} config — the full container config
 */

/**
 * @typedef {object} DeploymentVM
 * @property {object} vm — the `listVMs()` row
 * @property {{ ip: string|null, hostname: string|null }} net — guest-agent
 *   network snapshot; all-null when the VM is stopped or the agent is silent.
 */

/**
 * Gather the whole deployment in one pass: all of it, or the error of the read
 * that failed.
 *
 * @returns {Promise<{
 *   settings: object,
 *   certificate: { domain: string, validUntil: string } | null,
 *   hostInfo: object,
 *   bridges: object[],
 *   containers: DeploymentContainer[],
 *   vms: DeploymentVM[],
 * }>}
 */
export async function gatherDeployment() {
  const [settings, hostInfo, bridges, containers, vms, certificate] = await Promise.all([
    getSettings(),
    getHostInfo(),
    listHostBridges(),
    listContainers(),
    listVMs(),
    getHeldCertificateSummary(),
  ]);

  const containerEntries = await Promise.all(containers.map(async (summary) => (
    { summary, config: await getContainerConfig(summary.name) }
  )));

  const vmEntries = await Promise.all(vms.map(async (vm) => ({
    vm,
    net: vm.state === 'running' ? await getGuestNetwork(vm.name, { domainPath: vm.domainPath }) : { ip: null, hostname: null },
  })));

  return {
    settings,
    certificate,
    hostInfo,
    bridges,
    containers: containerEntries,
    vms: vmEntries,
  };
}

/** A stored container address without its mask (`192.168.1.20/24` → `192.168.1.20`), or null. */
function bareAddress(ip) {
  return ip ? ip.split('/')[0] : null;
}

/**
 * Project the aggregate into the body of `GET /api/overview`, which the MCP
 * `get_deployment_overview` tool returns too. The field set is the route's
 * public contract (docs/specs/API-HOST.md), and its response schema lists it.
 */
export async function buildDeploymentOverview() {
  const deployment = await gatherDeployment();
  const { settings, hostInfo, bridges, certificate } = deployment;

  const containers = deployment.containers.map(({ summary, config }) => {
    // A stopped container's persisted address is only a DHCP lease
    // memory — the lease may have been reassigned to another workload
    // by now, so never present it as a current `ip`.
    const running = summary.state === 'running';
    const address = bareAddress(config.network?.ip);
    return {
      name: summary.name,
      state: summary.state,
      image: summary.image,
      updateAvailable: summary.updateAvailable === true,
      ip: running ? address : null,
      ...(running ? {} : { lastKnownIp: address }),
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
    profile: vm.profile ?? null,
    ip: net.ip ?? null,
    guestHostname: net.hostname ?? null,
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
    certificate,
    containers,
    vms,
  };
}
