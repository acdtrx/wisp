/**
 * CNI-based bridge networking for containers.
 * Invokes the bridge CNI plugin to attach containers as veth ports on a host Linux bridge
 * (br0 or a VLAN sub-bridge br0-vlanN), so containers look like VMs on the wire and the host
 * can reach them directly.
 *
 * Network namespace creation and CNI require privileges. As the deploy user (systemd
 * `User=`), the backend uses **`sudo -n`** with **`wisp-netns`** and **`wisp-cni`**
 * installed by `install-helpers.sh` (same pattern as `wisp-mount`).
 */
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';

import { containerError, containerState } from './containerManagerConnection.js';
import { getContainerNetnsPath } from './containerPaths.js';
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { isVlanLikeBridgeName } from '../../networking/index.js';
import { createEmitter } from '../../base/index.js';
import { runPrivileged, helperPath } from '../../base/index.js';


/** Unicast locally administered MAC (same idea as VM NICs). */
export function generateContainerMac() {
  const b = randomBytes(3);
  const h = (n) => n.toString(16).padStart(2, '0');
  return `52:54:00:${h(b[0])}:${h(b[1])}:${h(b[2])}`;
}

/**
 * Normalize and validate a MAC for the CNI bridge plugin `mac` field.
 * Returns lowercase `aa:bb:...` or null.
 */
export function normalizeContainerMac(input) {
  if (input == null || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(s)) return null;
  return s;
}

const RUN_SETUP = 'run setup (sudo scripts/linux/setup/common-steps.sh <install-dir> <deploy-user>)';

/* wisp-netns bounds each command at 10 s (+2 to end): an add runs three, a
 * delete or a route one. */
const NETNS_ADD_TIMEOUT_MS = 40_000;
const NETNS_STEP_TIMEOUT_MS = 15_000;

/**
 * Reject anything that isn't an existing Linux bridge.
 * `/sys/class/net/<iface>/bridge` is a directory that exists only on bridges — not on
 * macvlan/bond/veth/physical — so a pair of sysfs access() calls is enough.
 *
 * Without this, the bridge CNI plugin will happily create an orphan bridge under that name.
 */
async function assertIsLinuxBridge(iface) {
  if (!iface || typeof iface !== 'string') {
    throw containerError('CONTAINERD_ERROR', 'Container bridge interface is not set');
  }
  try {
    await access(`/sys/class/net/${iface}`);
  } catch {
    throw containerError(
      'CONTAINERD_ERROR',
      `Container bridge "${iface}" does not exist on the host`,
    );
  }
  try {
    await access(`/sys/class/net/${iface}/bridge`);
  } catch {
    throw containerError(
      'CONTAINERD_ERROR',
      `Container interface "${iface}" is not a Linux bridge`,
    );
  }
}

/** A plugin's answer: empty is `{}` (a DEL), anything else must be JSON. */
function parseCniStdout(stdout, command, containerID) {
  if (!stdout || !stdout.trim()) return {};
  try {
    return JSON.parse(stdout);
  } catch {
    throw containerError('CONTAINERD_ERROR', `CNI ${command} for "${containerID}" answered something that is not JSON`, stdout.slice(0, 500));
  }
}

/* wisp-cni bounds the plugin at 25 s (+2 to end): an ADD waits for the DHCP lease. */
const CNI_TIMEOUT_MS = 30_000;

/**
 * The container's port on `bridge`, through wisp-cni: `ADD` (with its MAC
 * address; answers the CNI result) or `DEL`. The helper writes Wisp's network
 * configuration itself; its netns is the container's own.
 */
async function execCNI(command, name, bridge, mac) {
  const args = command === 'ADD' ? ['add', name, bridge ?? '', mac ?? ''] : ['del', name, bridge ?? ''];
  let stdout;
  try {
    ({ stdout } = await runPrivileged(helperPath('wisp-cni'), args, { timeoutMs: CNI_TIMEOUT_MS }));
  } catch (err) {
    throw containerError('CONTAINERD_ERROR', `CNI ${command} failed for "${name}" (${err.reason ?? 'error'})`, err.detail ?? err.message);
  }
  return parseCniStdout(stdout, command, name);
}

/**
 * Create a network namespace for a container through wisp-netns.
 */
async function ensureNetNS(name) {
  const nsPath = getContainerNetnsPath(name);
  try {
    await access(nsPath);
    return nsPath;
  } catch {
    /* need to create */
  }
  try {
    await runPrivileged(helperPath('wisp-netns'), ['add', name], { timeoutMs: NETNS_ADD_TIMEOUT_MS });
  } catch (err) {
    throw containerError(
      'CONTAINERD_ERROR',
      `Failed to create netns for "${name}" (${err.reason ?? 'error'}). Install the helpers: ${RUN_SETUP}`,
      err.detail ?? err.message,
    );
  }
  try {
    await access(nsPath);
    return nsPath;
  } catch {
    throw containerError('CONTAINERD_ERROR', `Netns path missing after create: ${nsPath}`);
  }
}

const netnsRemoved = createEmitter('[containerManager] netns-removed', () => containerState.logger);

/**
 * Subscribe to "Wisp removed a container's network namespace". Handler
 * signature: (name). Fires after the removal has returned — the netns and the
 * host-side veth CNI put on the bridge are gone (CNI DEL, run first, deletes
 * the veth; deleting the netns takes any leftover with it). Covers the stale
 * netns a start clears, teardown on delete / failed start, and rename's
 * orphan cleanup. A plain stop keeps the netns, so it does not fire.
 * Returns an unsubscribe function.
 */
export const subscribeContainerNetnsRemoved = netnsRemoved.subscribe;

export function notifyContainerNetnsRemoved(name) {
  netnsRemoved.emit(name);
}

/**
 * Remove a network namespace. Notifies netns-removed subscribers when one
 * existed; a delete that fails throws.
 */
async function removeNetNS(name) {
  try {
    await access(getContainerNetnsPath(name));
  } catch {
    return; // no netns, nothing to remove
  }
  try {
    await runPrivileged(helperPath('wisp-netns'), ['delete', name], { timeoutMs: NETNS_STEP_TIMEOUT_MS });
  } catch (err) {
    if (err.reason === 'not-found') return; // gone meanwhile: nothing was removed here
    throw containerError('CONTAINERD_ERROR', `Failed to remove the netns of "${name}" (${err.reason ?? 'error'})`, err.detail ?? err.message);
  }
  notifyContainerNetnsRemoved(name);
}

const IPV4_CIDR_RE = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/;

/**
 * An IPv4 entry of a CNI result's `ips`: by its address (CNI 1.0 results carry
 * no `version`; 0.4 ones say "4").
 */
function isIpv4Entry(e) {
  return !!e && typeof e.address === 'string' && IPV4_CIDR_RE.test(e.address);
}

/**
 * First IPv4 address from a CNI ADD `ips` array (e.g. `"192.168.1.50/24"`).
 */
export function primaryIPv4FromCni(ips) {
  if (!Array.isArray(ips)) return null;
  return ips.find(isIpv4Entry)?.address ?? null;
}

function pickMacFromCniResult(result) {
  const ifs = result?.interfaces;
  if (!Array.isArray(ifs) || !ifs.length) return null;
  const v4 = result.ips?.find(isIpv4Entry);
  if (v4 && typeof v4.interface === 'number' && ifs[v4.interface]?.mac) {
    return ifs[v4.interface].mac;
  }
  const withSandbox = ifs.find((i) => i.sandbox && i.mac);
  return withSandbox?.mac || ifs.find((i) => i.mac)?.mac || null;
}

/**
 * Persist CNI ADD lease (IP, MAC) into `container.json` so the API/UI can show them.
 * Writes into the latest container.json rather than the caller's copy: the
 * caller read its copy before a DHCP wait of up to several seconds, and a
 * config edit saved meanwhile must survive this write. Returns the merged
 * latest config.
 */
export async function mergeNetworkLeaseIntoConfig(name, config, lease) {
  if (!lease) return config;
  const ip = primaryIPv4FromCni(lease.ips);
  const latest = await readContainerConfig(name);
  const next = {
    ...latest,
    network: { ...(latest.network || {}) },
  };
  if (ip) next.network.ip = ip;
  if (lease.mac && !next.network.mac) next.network.mac = lease.mac;
  await writeContainerConfig(name, next);
  return next;
}

const WISP_MDNS_STUB_IP = '169.254.53.53';
const WISP_CONTAINER_RESOLV_CONF = '/var/lib/wisp/container-resolv.conf';

/**
 * Whether the wisp DNS forwarder (`169.254.53.53`) is reachable from a container
 * on this bridge. The stub IP lives on the host's `wisp-dns0` dummy interface —
 * declared by `scripts/linux/setup/container-dns.sh` through the daemon that
 * runs the links — and the host answers ARP for it from the
 * primary bridge (weak host model). VLAN sub-bridges (`br0-vlan10`, `eth0.100`, …)
 * carry no host address, so the host has no on-link route back to containers
 * there and the forwarder's replies would leave via the default route instead:
 * containers attached there fall back to upstream resolvers and don't get
 * `.local` resolution.
 *
 * Decided by name (not by probing the bridge's current addresses): the stub IP
 * is asserted on every wisp start, so probing introduces a timing race
 * (container created during a window where the IP is briefly missing keeps
 * the wrong resolv.conf for its whole run).
 */
function bridgeHasMdnsForwarder(bridgeInterface) {
  return Boolean(bridgeInterface) && !isVlanLikeBridgeName(bridgeInterface);
}

/**
 * Install an on-link /32 route for the mDNS stub IP inside the container's netns.
 *
 * Why: the container gets its default route via DHCP (LAN gateway). Without a specific
 * route for 169.254.53.53, the kernel forwards DNS queries to the LAN gateway, which
 * black-holes them (3-second timeout). Adding `169.254.53.53/32 dev eth0` makes the
 * container ARP directly on its veth; the host answers from br0 (the IP itself is
 * on wisp-dns0) and wisp's DNS forwarder handles the query.
 *
 * Best-effort: a failure here logs a warning but does not block the container start.
 */
async function installMdnsStubRoute(name) {
  try {
    await runPrivileged(helperPath('wisp-netns'), ['route-add', name, 'eth0', WISP_MDNS_STUB_IP], { timeoutMs: NETNS_STEP_TIMEOUT_MS });
  } catch (err) {
    containerState.logger?.warn(
      `Failed to install mDNS stub route (169.254.53.53) in netns "${name}": ${err.detail ?? err.message}. ` +
      '.local resolution inside this container will not work until helpers are refreshed.',
    );
  }
}

/**
 * Determine the resolv.conf to bind-mount into a container.
 * On the primary bridge — where wisp's DNS forwarder is reachable — use the
 * shared `/var/lib/wisp/container-resolv.conf` (single `nameserver 169.254.53.53`
 * line) so `.local` names resolve through the forwarder; that file missing
 * (setup never ran) fails the step. On VLAN sub-bridges, use
 * the host's upstream resolvers — on systemd-resolved hosts, `/etc/resolv.conf`
 * points at the stub (`127.0.0.53`) which is unreachable from a container
 * netns, so prefer `/run/systemd/resolve/resolv.conf` when present.
 */
export async function resolveContainerResolvConf(bridgeInterface = null) {
  if (bridgeHasMdnsForwarder(bridgeInterface)) {
    try {
      await access(WISP_CONTAINER_RESOLV_CONF);
      return WISP_CONTAINER_RESOLV_CONF;
    } catch (err) {
      throw containerError('CONTAINER_NETWORK_SETUP_FAILED', `The containers' resolver file ${WISP_CONTAINER_RESOLV_CONF} is missing: ${RUN_SETUP}`, err.message);
    }
  }
  const upstream = '/run/systemd/resolve/resolv.conf';
  try {
    await access(upstream);
    return upstream;
  } catch {
    return '/etc/resolv.conf'; // no systemd-resolved upstream file: the host's own resolv.conf is the one
  }
}

/**
 * Set up bridge networking for a container.
 * Creates a network namespace and invokes the bridge CNI plugin to attach a veth
 * pair into the chosen host bridge (br0 or a VLAN sub-bridge).
 */
export async function setupNetwork(name, networkConfig = {}) {
  await assertIsLinuxBridge(networkConfig.interface);
  const bridge = networkConfig.interface;
  const mac = normalizeContainerMac(networkConfig.mac);
  if (!mac) throw containerError('CONTAINERD_ERROR', `Container "${name}" has no valid MAC address`);

  const nsPath = getContainerNetnsPath(name);

  // Reusing a netns that still has CNI's eth0 (e.g. after a failed stop) can make ADD fail.
  let hadNetns = false;
  try {
    await access(nsPath);
    hadNetns = true;
  } catch {
    /* will create below */
  }

  if (hadNetns) {
    try {
      await execCNI('DEL', name, bridge);
    } catch (err) {
      // The netns goes next either way; a DEL that failed is said, not hidden.
      containerState.logger?.warn?.({ err: err.message, container: name }, '[containerManager] CNI DEL of a stale netns failed — removing the netns');
    }
    await removeNetNS(name);
    let stillThere = false;
    try {
      await access(nsPath);
      stillThere = true;
    } catch {
      /* expected: path gone */
    }
    if (stillThere) {
      throw containerError(
        'CONTAINERD_ERROR',
        `Could not remove stale netns for "${name}" (busy or permission). On the host run: sudo ip netns delete ${name}`,
        nsPath,
      );
    }
  }

  const freshPath = await ensureNetNS(name);

  const result = await execCNI('ADD', name, bridge, mac);

  if (bridgeHasMdnsForwarder(networkConfig.interface)) {
    await installMdnsStubRoute(name);
  }

  // The ADD's result carries the address: the dhcp IPAM plugin answers only
  // once its daemon holds a lease (else the ADD fails). The 60 s probe
  // (containerManagerNetworkEvents.js) follows a later change.
  return {
    netns: freshPath,
    ips: result.ips || [],
    mac: pickMacFromCniResult(result),
  };
}

/**
 * Release a container's network attachment through CNI DEL: the DHCP lease
 * held under its id, and the veth. Throws when the plugin fails.
 */
export async function releaseNetworkLease(name, networkConfig = {}) {
  await execCNI('DEL', name, networkConfig.interface);
}

/** Remove a container's netns (its veth goes with it); throws when the delete fails. */
export async function removeContainerNetns(name) {
  await removeNetNS(name);
}

/**
 * Tear down networking for a container: CNI DEL, then the netns, which is
 * removed even when the DEL failed. A step that fails throws (the DEL's error
 * after the netns is gone); a caller that only tidies up after another failure
 * catches it.
 */
export async function teardownNetwork(name, networkConfig = {}) {
  let leaseError = null;
  try {
    await releaseNetworkLease(name, networkConfig);
  } catch (err) {
    leaseError = err;
  }
  await removeNetNS(name);
  if (leaseError) throw leaseError;
}
