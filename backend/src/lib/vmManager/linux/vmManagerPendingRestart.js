/**
 * Restart-required flag: `<wisp:pendingRestart>since</wisp:pendingRestart>`
 * in a domain's persistent metadata marks a saved definition the running QEMU
 * doesn't reflect yet. A VM needs a restart while the flag exists and its
 * QEMU process has not started since `since`; the flag is dropped when a read
 * observes a QEMU that started later. A guest-side reboot keeps the same QEMU
 * process, so the flag correctly stays.
 */
import { connectionState, resolveDomain, getDomainXML, vmError } from './vmManagerConnection.js';
import { parseDomainRaw, buildXml, getWispPendingRestart, setWispPendingRestart } from './vmManagerXml.js';
import { refreshVMListCache } from './vmManagerList.js';

/**
 * Write the flag into the inactive definition, leaving every other part of
 * the XML as libvirt returned it. `since` null clears it. `expectSince`
 * (when given) makes the write conditional on the stored flag still being
 * that one. Returns whether it defined.
 */
async function writePendingRestart(domPath, since, { expectSince } = {}) {
  const xml = await getDomainXML(domPath, { inactive: true });
  const parsed = parseDomainRaw(xml);
  const dom = parsed.domain;
  if (!dom) throw vmError('PARSE_ERROR', 'Failed to parse domain XML');
  const current = getWispPendingRestart(dom)?.since ?? null;
  if (expectSince !== undefined && current !== expectSince) return false;
  if (current === since) return false;
  setWispPendingRestart(dom, since);
  await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
  return true;
}

/**
 * Set or clear a VM's restart-required flag. `true` records `since = now`
 * (a later change moves it forward); `false` removes the flag. For callers
 * that change a VM's definition outside updateVMConfig (migrations) and know
 * whether the running VM needs a restart to pick it up. Returns `{ changed }`.
 */
export async function setVMPendingRestart(name, value) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  const domPath = await resolveDomain(name);
  try {
    const changed = await writePendingRestart(domPath, value === true ? new Date().toISOString() : null);
    if (changed) refreshVMListCache();
    return { changed };
  } catch (err) {
    if (err.code) throw err;
    throw vmError('LIBVIRT_ERROR', `Failed to update the restart flag of VM "${name}"`, err.message);
  }
}

/**
 * The restart-required rule, applied wherever a VM's state is read (list
 * refresh — including the first build at Wisp startup — and detail).
 * `startedAt` is the QEMU process's start time (epoch ms), null when not
 * running or unreadable. Returns the flag still in force — `{ since }` or
 * null — and drops it from the definition when QEMU started after `since`.
 * A stopped VM, or one whose start time can't be read, keeps its flag.
 */
export async function resolveVMPendingRestart(domPath, name, pendingRestart, startedAt) {
  if (!pendingRestart) return null;
  if (startedAt == null || !(startedAt > Date.parse(pendingRestart.since))) return pendingRestart;
  try {
    const cleared = await writePendingRestart(domPath, null, { expectSince: pendingRestart.since });
    if (cleared) {
      connectionState.logger?.info?.({ vm: name, since: pendingRestart.since }, '[vmManager] restart-required flag cleared: qemu started after it was set');
    }
  } catch (err) {
    connectionState.logger?.warn?.({ vm: name, err: err?.message || err }, '[vmManager] failed to clear restart-required flag');
  }
  return null;
}
