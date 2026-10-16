/**
 * Restart-required flag: `<wisp:pendingRestart>` in a domain's persistent
 * metadata marks a saved definition the running QEMU doesn't reflect yet.
 * updateVMConfig sets it on a running VM; it clears when QEMU boots fresh
 * from the definition (a guest-side reboot keeps the same QEMU, so the flag
 * stays).
 */
import { connectionState, resolveDomain, getDomainXML, subscribeDomainEvent, vmError } from './vmManagerConnection.js';
import { parseDomainRaw, buildXml, hasWispPendingRestart, setWispPendingRestart } from './vmManagerXml.js';
import { refreshVMListCache } from './vmManagerList.js';
import { VIR_DOMAIN_EVENT_STARTED, VIR_DOMAIN_EVENT_STARTED_BOOTED } from './libvirtConstants.js';

/**
 * Write the flag into the inactive definition, leaving every other part of
 * the XML as libvirt returned it. Defines only when the value changes.
 * Returns `{ changed, name }`.
 */
async function writePendingRestart(domPath, value) {
  const xml = await getDomainXML(domPath, { inactive: true });
  const parsed = parseDomainRaw(xml);
  const dom = parsed.domain;
  if (!dom) throw vmError('PARSE_ERROR', 'Failed to parse domain XML');
  const name = String(dom.name ?? '');
  if (hasWispPendingRestart(dom) === value) return { changed: false, name };
  setWispPendingRestart(dom, value);
  await connectionState.connectIface.DomainDefineXML(buildXml(parsed));
  refreshVMListCache();
  return { changed: true, name };
}

/**
 * Set or clear a VM's restart-required flag. For callers that change a VM's
 * definition outside updateVMConfig (migrations) and know whether the running
 * VM needs a restart to pick it up. Returns `{ changed }`.
 */
export async function setVMPendingRestart(name, value) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');
  const domPath = await resolveDomain(name);
  try {
    const { changed } = await writePendingRestart(domPath, value === true);
    return { changed };
  } catch (err) {
    if (err.code) throw err;
    throw vmError('LIBVIRT_ERROR', `Failed to update the restart flag of VM "${name}"`, err.message);
  }
}

function clearOnBoot(domainPath, event, detail) {
  if (event !== VIR_DOMAIN_EVENT_STARTED || detail !== VIR_DOMAIN_EVENT_STARTED_BOOTED) return;
  writePendingRestart(domainPath, false).then(
    ({ changed, name }) => {
      if (changed) connectionState.logger?.info?.({ vm: name }, '[vmManager] restart-required flag cleared on start');
    },
    (err) => {
      connectionState.logger?.warn?.({ domainPath, err: err?.message || err }, '[vmManager] failed to clear restart-required flag on start');
    },
  );
}

subscribeDomainEvent(clearOnBoot);
