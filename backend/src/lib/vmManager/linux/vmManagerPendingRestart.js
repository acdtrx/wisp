/**
 * Restart-required flag: `<wisp:pendingRestart>since</wisp:pendingRestart>`
 * in a domain's persistent metadata marks a saved definition the running QEMU
 * doesn't reflect yet. A VM needs a restart while the flag exists and its
 * QEMU process has not started since `since`; the stored flag is dropped when
 * a QEMU start is observed (STARTED event, or at connect). A guest-side reboot
 * keeps the same QEMU process, so the flag correctly stays.
 */
import {
  connectionState,
  resolveDomain,
  getDomainXML,
  getDomainState,
  vmError,
  subscribeDomainStarted,
  subscribeConnected,
} from './vmManagerConnection.js';
import {
  parseDomainRaw,
  buildXml,
  getWispPendingRestart,
  setWispPendingRestart,
  domainNameFromParsed,
} from './vmManagerXml.js';
import { refreshVMListCache } from './vmManagerList.js';
import { getQemuStartTimeMs } from './vmManagerProc.js';
import { isOfflineState } from './libvirtConstants.js';

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
 * The restart-required rule: the flag still in force — `{ since }` or null.
 * `startedAt` is the QEMU process's start time (epoch ms), null when not
 * running or unreadable. A flag QEMU started after is no longer in force; a
 * stopped VM, or one whose start time can't be read, keeps its flag. Pure:
 * reads apply it, and `clearOutgrownRestartFlag` drops the stored flag.
 */
export function pendingRestartInForce(pendingRestart, startedAt) {
  if (!pendingRestart) return null;
  if (startedAt == null || !(startedAt > Date.parse(pendingRestart.since))) return pendingRestart;
  return null;
}

/**
 * Drop the domain's stored flag when its QEMU started after `since`
 * (conditional on the flag still holding that `since`). Returns
 * `{ vm, result }`, result one of `no flag`, `kept` (still in force) or
 * `cleared`.
 */
async function clearOutgrownRestartFlag(domPath) {
  const dom = parseDomainRaw(await getDomainXML(domPath, { inactive: true })).domain;
  if (!dom) throw vmError('PARSE_ERROR', 'Failed to parse domain XML');
  const vm = domainNameFromParsed(dom);
  const flag = getWispPendingRestart(dom);
  if (!flag) return { vm, result: 'no flag' };
  const { code } = await getDomainState(domPath);
  const startedAt = isOfflineState(code) ? null : await getQemuStartTimeMs(vm);
  if (pendingRestartInForce(flag, startedAt)) return { vm, result: 'kept', since: flag.since };
  const cleared = await writePendingRestart(domPath, null, { expectSince: flag.since });
  return { vm, result: cleared ? 'cleared' : 'kept', since: flag.since };
}

/**
 * Clear outgrown restart flags: of one domain (`domPath`), or of every domain.
 * Triggered by a STARTED DomainEvent and by each (re)connect — the connect
 * pass catches VMs started while Wisp was not connected (host-boot autostart).
 * Logs every pass: one line per started VM, one summary per connect pass
 * (plus a line per flag it clears).
 */
async function clearOutgrownRestartFlags(trigger, domPath = null) {
  const log = connectionState.logger;
  try {
    const paths = domPath ? [domPath] : await connectionState.connectIface.ListDomains(3);
    let clearedCount = 0;
    for (const p of paths) {
      try {
        const outcome = await clearOutgrownRestartFlag(p);
        if (outcome.result === 'cleared') clearedCount += 1;
        if (domPath || outcome.result === 'cleared') {
          log?.info?.({ ...outcome, trigger }, `[vmManager] restart-required flag check: ${outcome.result}`);
        }
      } catch (err) {
        log?.warn?.({ domainPath: p, trigger, err: err?.message || err }, '[vmManager] failed to clear restart-required flag');
      }
    }
    if (!domPath) log?.info?.({ trigger, domains: paths.length, cleared: clearedCount }, '[vmManager] restart-required flags checked');
  } catch (err) {
    log?.warn?.({ trigger, err: err?.message || err }, '[vmManager] restart-required flag check failed');
  }
}

subscribeDomainStarted((domPath) => { clearOutgrownRestartFlags('domain started', domPath); });
subscribeConnected(() => { clearOutgrownRestartFlags('connect'); });
