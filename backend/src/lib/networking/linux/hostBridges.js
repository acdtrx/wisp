/**
 * Linux host network introspection: bridge enumeration from /sys/class/net,
 * default-bridge selection for new VMs and container CNI parents, and
 * container IPv4 CIDR readout from /proc/<pid>/net/fib_trie.
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
 * Default bridge for new VMs: WISP_DEFAULT_BRIDGE env, or first non-virbr bridge, or virbr0.
 */
export async function getDefaultBridge() {
  const envBridge = process.env.WISP_DEFAULT_BRIDGE?.trim();
  if (envBridge) return envBridge;
  const bridges = await listHostBridges();
  return bridges.length > 0 ? bridges[0] : 'virbr0';
}

/**
 * First non-loopback IPv4 CIDR from /proc/<pid>/net/fib_trie (host LOCAL routes).
 * @param {number} pid - Host PID (container init from containerd Tasks.Get)
 * @returns {Promise<string|null>} e.g. `192.168.1.50/24` or null
 */
export async function ipv4CidrFromProcFibTrie(pid) {
  if (pid == null || pid <= 0 || !Number.isFinite(pid)) return null;
  try {
    const text = await readFile(`/proc/${pid}/net/fib_trie`, 'utf8');
    // Typical line: `|           |-- 192.168.1.50/24 ... host LOCAL`
    const inline = /\b(\d{1,3}(?:\.\d{1,3}){3})\/(\d+)\b[^\n]*\bhost\s+LOCAL\b/gi;
    let m;
    while ((m = inline.exec(text)) !== null) {
      const ip = m[1];
      const len = m[2];
      if (ip === '0.0.0.0' || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      return `${ip}/${len}`;
    }
    // Some kernels split tokens across lines
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const mm = lines[i].match(/\b(\d{1,3}(?:\.\d{1,3}){3})\/(\d+)/);
      if (!mm) continue;
      const chunk = `${lines[i]} ${lines[i + 1] || ''}`;
      if (!/\bhost\s+LOCAL\b/i.test(chunk)) continue;
      const ip = mm[1];
      const len = mm[2];
      if (ip === '0.0.0.0' || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      return `${ip}/${len}`;
    }
    return null;
  } catch {
    /* /proc unavailable, wrong pid, or fib_trie format changed */
    return null;
  }
}
