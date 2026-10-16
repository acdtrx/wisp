/**
 * A backup's domain.xml is untrusted input — anyone who can write to a backup
 * destination (an SMB share, a removable drive) can edit it — and restore
 * hands it to DomainDefineXML. libvirt opens, executes or exposes to the guest
 * whatever host paths a definition names: a CD-ROM on /etc/shadow, a disk on
 * /dev/sda, a `<hostdev>` PCI controller, a `<qemu:commandline>` argument, an
 * interface `<script>` run as root, a serial port logging into any file.
 *
 * `assertRestorableDomain` checks the domain about to be defined (after
 * restore rewrote its name, UUID, MACs and paths) against what a Wisp VM can
 * hold: file-backed disks and CD-ROMs whose sources are inside the new VM's
 * directory — or, for CD-ROMs, a path the caller allows (the image library;
 * that policy is Wisp's, passed in) — NVRAM in the VM directory, firmware
 * from the distro's firmware directories, and an allowlist of device kinds
 * with their host-facing attributes pinned. Anything else is BACKUP_INVALID
 * with the rule that failed.
 */
import { resolve } from 'node:path';

import { vmError } from './vmManagerConnection.js';
import { FIRMWARE_SEARCH_PATHS } from './vmManagerHost.js';

/** fast-xml-parser yields one object (or a text string) for a single child, an array for several. */
function asList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Text content of a parsed element: a bare string, or `#text` beside attributes. */
function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && v['#text'] != null) return String(v['#text']).trim();
  return '';
}

function attr(node, name) {
  return node && typeof node === 'object' ? node[`@_${name}`] : undefined;
}

function invalid(reason) {
  return vmError('BACKUP_INVALID', `Backup domain.xml can't be restored: ${reason}`);
}

function isInside(path, dir) {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  const p = resolve(path);
  const d = resolve(dir);
  return p === d || p.startsWith(`${d}/`);
}

/** Element names in the parsed object (attributes and text excluded). */
function childNames(node) {
  return node && typeof node === 'object' ? Object.keys(node).filter((k) => !k.startsWith('@_') && k !== '#text') : [];
}

/**
 * A namespaced element outside `<metadata>` is a hypervisor extension —
 * `<qemu:commandline>`, `<qemu:override>` (raw QEMU arguments / device
 * properties), or another driver's — whatever prefix the file binds it to.
 */
function assertNoNamespacedElements(node, where) {
  for (const name of childNames(node)) {
    if (name.includes(':')) throw invalid(`hypervisor extension element <${name}> in ${where}`);
    for (const child of asList(node[name])) {
      if (child && typeof child === 'object') assertNoNamespacedElements(child, `<${name}>`);
    }
  }
}

const OS_CHILDREN = new Set(['type', 'loader', 'nvram', 'boot', 'bootmenu', 'smbios', 'bios', 'firmware']);

function isFirmwarePath(p) {
  return FIRMWARE_SEARCH_PATHS.some((dir) => isInside(p, dir));
}

function checkOs(os, vmDir) {
  if (os == null) return;
  if (typeof os !== 'object') throw invalid('malformed <os>');
  for (const name of childNames(os)) {
    // kernel / initrd / dtb / acpi tables / cmdline load host files into the guest.
    if (!OS_CHILDREN.has(name)) throw invalid(`<os><${name}> is not supported`);
  }
  for (const loader of asList(os.loader)) {
    const path = textOf(loader);
    if (path && !isFirmwarePath(path) && !isInside(path, vmDir)) {
      throw invalid(`firmware loader ${path} is not in a firmware directory (${FIRMWARE_SEARCH_PATHS.join(', ')})`);
    }
  }
  for (const nvram of asList(os.nvram)) {
    const type = attr(nvram, 'type');
    if (type != null && type !== 'file') throw invalid(`NVRAM of type "${type}" is not supported`);
    const paths = [textOf(nvram), attr(nvram?.source, 'file')].filter(Boolean);
    for (const path of paths) {
      if (!isInside(path, vmDir)) throw invalid(`NVRAM ${path} is outside the new VM's directory`);
    }
    const template = attr(nvram, 'template');
    if (template != null && !isFirmwarePath(template)) {
      throw invalid(`NVRAM template ${template} is not in a firmware directory`);
    }
  }
}

function checkSeclabels(dom) {
  for (const label of asList(dom.seclabel)) {
    // type none / static (or relabel='no', or an explicit label) would run
    // QEMU unconfined or as a user of the file's choosing — e.g. root.
    const type = attr(label, 'type');
    if (type != null && type !== 'dynamic') throw invalid(`<seclabel type="${type}"> is not supported`);
    if (attr(label, 'relabel') === 'no') throw invalid('<seclabel relabel="no"> is not supported');
    if (childNames(label).length > 0) throw invalid('<seclabel> with an explicit label is not supported');
  }
}

/** An element is "empty" when it carries no attributes and no children: `<backingStore/>`. */
function isEmptyElement(v) {
  if (v == null || v === '') return true;
  return typeof v === 'object' && Object.keys(v).length === 0;
}

function checkDisk(d, { vmDir, isExternalSourceAllowed }) {
  const slot = attr(d.target, 'dev') || '?';
  const type = attr(d, 'type') ?? 'file';
  const device = attr(d, 'device') ?? 'disk';
  if (device !== 'disk' && device !== 'cdrom') throw invalid(`disk ${slot} has device="${device}" (only disk and cdrom are supported)`);
  if (type !== 'file') throw invalid(`disk ${slot} is of type "${type}" (only file-backed disks are supported)`);
  const format = attr(d.driver, 'type') ?? 'raw';
  const allowedFormats = device === 'cdrom' ? ['raw'] : ['qcow2', 'raw'];
  if (!allowedFormats.includes(format)) throw invalid(`disk ${slot} has driver type "${format}"`);
  for (const name of ['backingStore', 'dataStore', 'mirror']) {
    if (d[name] != null && !(name === 'backingStore' && isEmptyElement(d[name]))) {
      throw invalid(`disk ${slot} has a <${name}>`);
    }
  }
  const file = attr(d.source, 'file');
  if (file == null && device === 'cdrom') return; // empty CD-ROM
  if (typeof file !== 'string' || !file) throw invalid(`disk ${slot} has no source file`);
  if (isInside(file, vmDir)) return;
  if (device === 'cdrom' && typeof isExternalSourceAllowed === 'function' && isExternalSourceAllowed(file)) return;
  throw invalid(device === 'cdrom'
    ? `CD-ROM ${slot} source ${file} is outside the new VM's directory and the allowed image paths`
    : `disk ${slot} source ${file} is outside the new VM's directory`);
}

const INTERFACE_TYPES = ['bridge', 'network', 'direct'];
const INPUT_TYPES = ['tablet', 'mouse', 'keyboard'];
const GRAPHICS_TYPES = ['vnc', 'spice'];
const GRAPHICS_LISTEN_TYPES = ['address', 'network', 'none'];
const CHARDEV_TYPES = ['pty', 'unix', 'spicevmc', 'spiceport', 'qemu-vdagent', 'vc', 'null'];
const AUDIO_TYPES = ['none', 'spice', 'pulseaudio', 'pipewire', 'dbus', 'sdl'];
const RNG_DEVICES = ['/dev/random', '/dev/urandom', '/dev/hwrng'];
/** Where libvirt itself places the sockets of auto-configured unix channels (guest agent). */
const LIBVIRT_SOCKET_DIRS = ['/var/lib/libvirt', '/run/libvirt', '/var/run/libvirt'];

function assertNoHostFileRom(dev, what) {
  for (const rom of asList(dev.rom)) {
    if (attr(rom, 'file') != null) throw invalid(`${what} loads an option ROM from a host file`);
  }
}

function checkInterface(nic) {
  const type = attr(nic, 'type');
  if (!INTERFACE_TYPES.includes(type)) throw invalid(`network interface of type "${type}" is not supported`);
  // script / downscript run as root; backend names host tap/vhost device nodes.
  for (const name of ['script', 'downscript', 'backend']) {
    if (nic[name] != null) throw invalid(`network interface with a <${name}> is not supported`);
  }
  assertNoHostFileRom(nic, 'a network interface');
}

function checkChardev(dev, kind) {
  const type = attr(dev, 'type');
  // file / dev / pipe write to or read from a host path (libvirt chowns it to QEMU).
  if (!CHARDEV_TYPES.includes(type)) throw invalid(`<${kind} type="${type}"> is not supported`);
  if (dev.log != null) throw invalid(`<${kind}> with a <log> file is not supported`);
  if (type === 'unix') {
    for (const src of asList(dev.source)) {
      const path = attr(src, 'path');
      if (path != null && !LIBVIRT_SOCKET_DIRS.some((dir) => isInside(path, dir))) {
        throw invalid(`<${kind}> unix socket ${path} is outside libvirt's own directories`);
      }
    }
  }
}

/** USB passthrough by vendor/product id — the shape Wisp's own USB attach writes. */
function checkHostdev(hd) {
  const vendor = attr(hd.source?.vendor, 'id');
  const product = attr(hd.source?.product, 'id');
  const usbById = attr(hd, 'mode') === 'subsystem' && attr(hd, 'type') === 'usb'
    && vendor && product && childNames(hd.source).every((n) => n === 'vendor' || n === 'product');
  if (!usbById) {
    throw invalid(`host device passthrough <hostdev type="${attr(hd, 'type') ?? '?'}"> is not supported (only USB by vendor and product id)`);
  }
  assertNoHostFileRom(hd, 'a host device');
}

const DEVICE_CHECKS = {
  emulator: (e) => {
    const path = textOf(e);
    if (!path.startsWith('/usr/') || resolve(path) !== path) throw invalid(`emulator ${path || '(empty)'} is not under /usr/`);
  },
  disk: (d, ctx) => checkDisk(d, ctx),
  controller: () => {},
  interface: (nic) => checkInterface(nic),
  input: (i) => {
    const type = attr(i, 'type');
    if (!INPUT_TYPES.includes(type)) throw invalid(`input device of type "${type}" is not supported`);
  },
  graphics: (g) => {
    const type = attr(g, 'type');
    if (!GRAPHICS_TYPES.includes(type)) throw invalid(`graphics of type "${type}" is not supported`);
    if (attr(g, 'socket') != null) throw invalid('graphics on a unix socket path is not supported');
    for (const l of asList(g.listen)) {
      if (!GRAPHICS_LISTEN_TYPES.includes(attr(l, 'type'))) throw invalid(`graphics listen of type "${attr(l, 'type')}" is not supported`);
    }
  },
  video: () => {},
  sound: () => {},
  audio: (a) => {
    const type = attr(a, 'type');
    if (!AUDIO_TYPES.includes(type)) throw invalid(`audio backend "${type}" is not supported`);
  },
  console: (c) => checkChardev(c, 'console'),
  serial: (s) => checkChardev(s, 'serial'),
  channel: (c) => checkChardev(c, 'channel'),
  memballoon: () => {},
  watchdog: () => {},
  panic: () => {},
  iommu: () => {},
  vsock: () => {},
  hub: () => {},
  rng: (r) => {
    const model = attr(r.backend, 'model');
    if (model === 'builtin') return;
    if (model !== 'random') throw invalid(`rng backend "${model}" is not supported`);
    const path = textOf(r.backend);
    if (path && !RNG_DEVICES.includes(path)) throw invalid(`rng backend device ${path} is not supported`);
  },
  tpm: (t) => {
    const backend = asList(t.backend)[0];
    if (attr(backend, 'type') !== 'emulator') throw invalid(`TPM backend "${attr(backend, 'type')}" is not supported (only the emulator)`);
    if (backend.source != null) throw invalid('TPM emulator with its own state path is not supported');
  },
  hostdev: (hd) => checkHostdev(hd),
};

/**
 * @param {object} dom - parsed `<domain>` (parseDomainRaw(xml).domain), paths already rewritten for the new VM
 * @param {{ vmDir: string, isExternalSourceAllowed?: (absPath: string) => boolean }} opts
 *   vmDir: the new VM's directory; isExternalSourceAllowed: whether a CD-ROM may name a path outside it
 * @throws BACKUP_INVALID naming the first rule the domain breaks
 */
export function assertRestorableDomain(dom, { vmDir, isExternalSourceAllowed }) {
  if (!dom || typeof dom !== 'object' || !dom.devices || typeof dom.devices !== 'object') {
    throw invalid('no <devices>');
  }
  for (const name of childNames(dom)) {
    if (name === 'metadata') continue;
    if (name.includes(':')) throw invalid(`hypervisor extension element <${name}>`);
    for (const child of asList(dom[name])) {
      if (child && typeof child === 'object') assertNoNamespacedElements(child, `<${name}>`);
    }
  }
  checkSeclabels(dom);
  checkOs(dom.os, vmDir);
  const ctx = { vmDir, isExternalSourceAllowed };
  for (const kind of childNames(dom.devices)) {
    const check = DEVICE_CHECKS[kind];
    // filesystem, redirdev, smartcard, shmem, memory, lease, parallel, … —
    // host directories, sockets, memory files or devices; not something a Wisp VM holds.
    if (!check) throw invalid(`device <${kind}> is not supported`);
    for (const dev of asList(dom.devices[kind])) check(dev, ctx);
  }
}
