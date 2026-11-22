/**
 * Which workloads use a host bridge (app-glue). Reads VM and container
 * configs through the managers' facades, so the networking module — which
 * the managers themselves import — never has to import them back.
 */
import { listVMs, getVMConfig } from './vmManager/index.js';
import { listContainers, getContainerConfig } from './containerManager/index.js';
import { createAppError, inUseCheckFailed } from './appErrors.js';

/** The VMs and containers whose NIC or network is on `bridgeName`; a read that fails throws. */
async function findBridgeUsers(bridgeName) {
  const vmRefs = [];
  for (const vm of await listVMs()) {
    const config = await getVMConfig(vm.name);
    const nics = Array.isArray(config.nics) ? config.nics : [];
    if (nics.some((nic) => nic?.type === 'bridge' && nic?.source === bridgeName)) vmRefs.push(vm.name);
  }
  const containerRefs = [];
  for (const container of await listContainers()) {
    const config = await getContainerConfig(container.name);
    if (config?.network?.interface === bridgeName) containerRefs.push(container.name);
  }
  return { vmRefs, containerRefs };
}

/**
 * Throw NETWORK_BRIDGE_IN_USE when any VM NIC or container network is attached
 * to `bridgeName`, and refuse the delete when that cannot be read. Passed to
 * `planManagedNetworkBridgeDelete` as its in-use check.
 */
export async function assertBridgeNotInUse(bridgeName) {
  let vmRefs;
  let containerRefs;
  try {
    ({ vmRefs, containerRefs } = await findBridgeUsers(bridgeName));
  } catch (err) {
    throw inUseCheckFailed(`bridge "${bridgeName}"`, err);
  }
  if (vmRefs.length === 0 && containerRefs.length === 0) return;
  const detail = [
    vmRefs.length ? `VMs: ${vmRefs.slice(0, 5).join(', ')}` : null,
    containerRefs.length ? `Containers: ${containerRefs.slice(0, 5).join(', ')}` : null,
  ].filter(Boolean).join(' | ');
  throw createAppError('NETWORK_BRIDGE_IN_USE', `Bridge "${bridgeName}" is in use and cannot be deleted`, detail);
}
