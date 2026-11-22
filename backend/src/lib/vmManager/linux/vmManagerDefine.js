/**
 * The one way a VM's saved definition is changed: read it, apply a change,
 * define it back (docs/specs/VM-MANAGEMENT.md). Every read-change-define in
 * vmManager goes through redefineVM; create and restore define a new domain.
 */
import { connectionState, getDomainObjAndIface, getDomainXML, unwrapVariant, vmError } from './vmManagerConnection.js';
import { parseDomainRaw, buildXml, domainNameFromParsed } from './vmManagerXml.js';

/**
 * domain path -> the tail of its write queue. A domain's writes run one at a
 * time, in order, whoever makes them (an edit, the restart flag cleared on a
 * start, a migration), so none defines over another's change. A domain with
 * nothing queued holds no entry. Each write's define is bounded by the libvirt
 * call bound, so the queue cannot wait for ever.
 */
const writeQueues = new Map();

function inWriteQueue(domPath, write) {
  const before = writeQueues.get(domPath) ?? Promise.resolve();
  const run = before.then(() => write());
  const tail = run.then(() => {}, () => {});
  writeQueues.set(domPath, tail);
  tail.then(() => { if (writeQueues.get(domPath) === tail) writeQueues.delete(domPath); });
  return run;
}

/**
 * Change the saved definition of the domain at `domPath`. Under the domain's
 * write queue: read the definition with the secure flag (so a console
 * password set outside Wisp is written back), call `change(dom, { xml,
 * parsed })` on the parsed `<domain>` (`xml` the definition as read), and
 * define the result — unless `change` returns `false` (nothing to write).
 * `change` may throw before anything is written. A transient domain is never
 * defined (a define would make it persistent): a change it would need is
 * refused with VM_TRANSIENT, or, with `skipTransient`, resolves as not
 * defined. A failed define throws `defineError(err)`, LIBVIRT_ERROR by
 * default. Resolves whether it defined.
 * @param {string} domPath
 * @param {(dom: object, read: { xml: string, parsed: object }) => (boolean | void | Promise<boolean | void>)} change
 * @param {{ defineError?: (err: Error) => Error, skipTransient?: boolean }} [opts]
 */
export function redefineVM(domPath, change, { defineError, skipTransient = false } = {}) {
  return inWriteQueue(domPath, async () => {
    const { props } = await getDomainObjAndIface(domPath);
    let persistent;
    try {
      persistent = !!unwrapVariant(await props.Get('org.libvirt.Domain', 'Persistent'));
    } catch (err) {
      throw vmError('LIBVIRT_ERROR', 'Failed to read whether the VM is persistent', err.message);
    }
    const xml = await getDomainXML(domPath, { inactive: true, secure: true });
    const parsed = parseDomainRaw(xml);
    const dom = parsed?.domain;
    if (!dom) throw vmError('PARSE_ERROR', 'Failed to parse domain XML');
    const name = domainNameFromParsed(dom);
    if ((await change(dom, { xml, parsed })) === false) return false;
    if (!persistent) {
      if (skipTransient) return false;
      throw vmError('VM_TRANSIENT', `VM "${name}" is transient (not defined in libvirt): Wisp does not change its definition`);
    }
    let outXml;
    try {
      outXml = buildXml(parsed);
    } catch (err) {
      throw vmError('CONFIG_ERROR', 'Failed to build domain XML', err.message);
    }
    try {
      await connectionState.connectIface.DomainDefineXML(outXml);
    } catch (err) {
      throw defineError ? defineError(err) : vmError('LIBVIRT_ERROR', `Failed to save the definition of VM "${name}"`, err.message);
    }
    return true;
  });
}

/** How many domains have writes queued: for tests. */
export function definitionWritesQueued() {
  return writeQueues.size;
}
