/**
 * Which workloads use a host bridge (app-glue). Reads VM and container
 * configs through the managers' facades, so the networking module — which
 * the managers themselves import — never has to import them back.
 */
import { listVMs, getVMConfig } from './vmManager/index.js';
import { listContainers, getContainerConfig } from './containerManager/index.js';
import { createAppError } from './routeErrors.js';

/**
 * Throw NETWORK_BRIDGE_IN_USE when any VM NIC or container network is attached
 * to `bridgeName`. Passed to `deleteManagedNetworkBridge` as its in-use check.
 */
export async function assertBridgeNotInUse(bridgeName) {
  const vmRefs = [];
  const vms = await listVMs();
  for (const vm of vms) {
    try {
      const config = await getVMConfig(vm.name);
      const nics = Array.isArray(config.nics) ? config.nics : [];
      if (nics.some((nic) => nic?.type === 'bridge' && nic?.source === bridgeName)) {
        vmRefs.push(vm.name);
      }
    } catch {
      /* skip VM if config unavailable */
    }
  }

  const containerRefs = [];
  const containers = await listContainers();
  for (const container of containers) {
    try {
      const config = await getContainerConfig(container.name);
      if (config?.network?.interface === bridgeName) {
        containerRefs.push(container.name);
      }
    } catch {
      /* skip container if config unavailable */
    }
  }

  if (vmRefs.length === 0 && containerRefs.length === 0) return;
  const detail = [
    vmRefs.length ? `VMs: ${vmRefs.slice(0, 5).join(', ')}` : null,
    containerRefs.length ? `Containers: ${containerRefs.slice(0, 5).join(', ')}` : null,
  ].filter(Boolean).join(' | ');
  throw createAppError('NETWORK_BRIDGE_IN_USE', `Bridge "${bridgeName}" is in use and cannot be deleted`, detail);
}
