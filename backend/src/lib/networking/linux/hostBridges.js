/**
 * Linux host network introspection: bridge enumeration from /sys/class/net,
 * default-bridge selection for new VMs and container CNI parents, and
 * container IPv4/IPv6 CIDR readout from /proc/<pid>/net/{fib_trie,if_inet6}.
 */
import { access, readdir, readFile } from 'node:fs/promises';

import { isVlanLikeBridgeName } from '../bridgeNaming.js';

export async function listHostBridges() {
  try {
    const entries = await readdir('/sys/class/net');
    const bridges = [];
    for (const name of entries) {
      try {
        await access(`/sys/class/net/${name}/bridge`);
        bridges.push(name);
      } catch { /* not a bridge */ }
    }
    const envBridge = process.env.WISP_DEFAULT_BRIDGE?.trim();
    if (envBridge && bridges.includes(envBridge)) {
      bridges.splice(bridges.indexOf(envBridge), 1);
      bridges.unshift(envBridge);
    } else {
      bridges.sort((a, b) => {
        const aVirbr = a.startsWith('virbr') ? 1 : 0;
        const bVirbr = b.startsWith('virbr') ? 1 : 0;
        return aVirbr - bVirbr;
      });
    }
    return bridges;
  } catch {
    /* /sys/class/net unreadable (non-Linux layout or permissions) */
    return [];
  }
}

/**
 * First Linux bridge suitable as the **parent bridge** for a new container: prefer a name
 * that is not VLAN-style (see `isVlanLikeBridgeName`), else the first listed bridge.
 * Empty when none.
 */
export async function getDefaultContainerParentBridge() {
  const bridges = await listHostBridges();
  if (bridges.length === 0) return undefined;
  const plain = bridges.find((b) => !isVlanLikeBridgeName(b));
  return plain ?? bridges[0];
}

/**
 * Startup check of WISP_DEFAULT_BRIDGE (CODING-RULES §4): the problem when it
 * names no host bridge, else null — so getDefaultBridge never hands out a
 * bridge that isn't there.
 */
export async function checkDefaultBridgeOverride() {
  const envBridge = process.env.WISP_DEFAULT_BRIDGE?.trim();
  if (!envBridge) return null;
  const bridges = await listHostBridges();
  return bridges.includes(envBridge)
    ? null
    : `WISP_DEFAULT_BRIDGE: no host bridge named "${envBridge}" (bridges: ${bridges.join(', ') || 'none'})`;
}

/**
 * Default bridge for new VMs: WISP_DEFAULT_BRIDGE env, or the one new
 * containers attach to (getDefaultContainerParentBridge), so a VM and a
 * container land on the same segment; null when the host has none — setup
 * gives every Wisp host a bridge, so that is a host setup never finished.
 */
export async function getDefaultBridge() {
  const envBridge = process.env.WISP_DEFAULT_BRIDGE?.trim();
  if (envBridge) return envBridge;
  return (await getDefaultContainerParentBridge()) ?? null;
}

/** a.b.c.d as a 32-bit number. */
function ipv4ToNumber(ip) {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

/**
 * The first non-loopback, non-link-local local IPv4 address in `/proc/<pid>/net/fib_trie`
 * text, with the prefix length of the on-link route that holds it (`a.b.c.d/len`), or
 * null. In that text an address is a `|-- a.b.c.d` leaf followed by its route lines:
 * `/32 host LOCAL` for an address the namespace holds, `/24 link UNICAST` for the
 * on-link network it sits in (the leaf there is the network's address).
 */
export function ipv4CidrFromFibTrieText(text) {
  if (typeof text !== 'string') return null;
  const locals = [];
  const links = [];
  let leaf = null;
  for (const line of text.split('\n')) {
    const at = /\|--\s+(\d{1,3}(?:\.\d{1,3}){3})\s*$/.exec(line);
    if (at) {
      leaf = at[1];
      continue;
    }
    const route = /^\s*\/(\d{1,2})\s+(\w+)\s+(\w+)/.exec(line);
    if (!route || !leaf) continue;
    const [, len, scope, type] = route;
    if (len === '32' && scope === 'host' && type === 'LOCAL') locals.push(leaf);
    else if (scope === 'link' && type === 'UNICAST') links.push({ net: ipv4ToNumber(leaf), len: Number(len) });
  }
  for (const ip of locals) {
    if (ip === '0.0.0.0' || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
    const n = ipv4ToNumber(ip);
    const holder = links
      .filter(({ net, len }) => len > 0 && len < 32 && Math.floor(n / 2 ** (32 - len)) === Math.floor(net / 2 ** (32 - len)))
      .sort((a, b) => b.len - a.len)[0];
    return `${ip}/${holder ? holder.len : 32}`;
  }
  return null;
}

/**
 * The container's IPv4 CIDR from `/proc/<pid>/net/fib_trie` (ipv4CidrFromFibTrieText).
 * @param {number} pid - Host PID (container init from containerd Tasks.Get)
 * @returns {Promise<string|null>} e.g. `192.168.1.50/24`, or null when the process is
 *   gone or holds no such address
 */
export async function ipv4CidrFromProcFibTrie(pid) {
  if (pid == null || pid <= 0 || !Number.isFinite(pid)) return null;
  let text;
  try {
    text = await readFile(`/proc/${pid}/net/fib_trie`, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ESRCH') return null; // the process is gone
    throw err;
  }
  return ipv4CidrFromFibTrieText(text);
}

// IFA_F_* bits from the if_inet6 flags column that mark an address unusable
// or unstable: temporary (privacy), dadfailed, deprecated, tentative.
const IFA_F_UNUSABLE = 0x01 | 0x08 | 0x20 | 0x40;

/** 32-hex-digit /proc address → colon-grouped text (leading zeros stripped). */
function ifInet6HexToText(hex) {
  const groups = [];
  for (let i = 0; i < 32; i += 4) {
    groups.push(hex.slice(i, i + 4).replace(/^0{1,3}/, ''));
  }
  return groups.join(':');
}

/**
 * First usable global-scope IPv6 CIDR on `ifname` from /proc/<pid>/net/if_inet6
 * (kernel SLAAC lands there; nothing asks the CNI/DHCP layer for IPv6).
 * Line format: `<32-hex address> <ifindex> <prefixlen> <scope> <flags> <ifname>`,
 * numeric fields hex. GUA (2000::/3) preferred over ULA (fc00::/7); link-local
 * and tentative/deprecated/temporary/dadfailed addresses are skipped.
 *
 * @param {number} pid - Host PID (container init from containerd Tasks.Get)
 * @param {string} [ifname]
 * @returns {Promise<string|null>} e.g. `fdc0:b179:e4ea:4cbc:5054:ff:fe91:ad5f/64` or null
 */
export async function ipv6GlobalCidrFromProcIfInet6(pid, ifname = 'eth0') {
  if (pid == null || pid <= 0 || !Number.isFinite(pid)) return null;
  try {
    const text = await readFile(`/proc/${pid}/net/if_inet6`, 'utf8');
    let fallback = null;
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^([0-9a-f]{32})\s+[0-9a-f]+\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\S+)$/i);
      if (!m) continue;
      const [, hex, prefixHex, scopeHex, flagsHex, dev] = m;
      if (dev !== ifname) continue;
      if (parseInt(scopeHex, 16) !== 0) continue; // global scope only
      if (parseInt(flagsHex, 16) & IFA_F_UNUSABLE) continue;
      const cidr = `${ifInet6HexToText(hex.toLowerCase())}/${parseInt(prefixHex, 16)}`;
      const firstNibble = hex[0];
      if (firstNibble === '2' || firstNibble === '3') return cidr; // GUA wins
      if (!fallback) fallback = cidr; // ULA (or other global-scope)
    }
    return fallback;
  } catch {
    /* /proc unavailable, wrong pid, or if_inet6 format changed */
    return null;
  }
}
