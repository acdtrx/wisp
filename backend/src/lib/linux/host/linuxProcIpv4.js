/**
 * Read container IPv4 from the task's network namespace via /proc/<pid>/net (no sudo / ip(8)).
 */
import { readFile } from 'node:fs/promises';

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
    // /proc unavailable, wrong pid, or fib_trie format changed
    return null;
  }
}
