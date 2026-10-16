/**
 * Domain and snapshot XML parsing and building.
 */
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

// Every text node and attribute stays the exact string libvirt wrote: domain
// XML is parsed, mutated and rebuilt for DomainDefineXML, so coercion would
// rewrite values on the round-trip (`<name>007</name>` → 7, a disk `<serial>`
// of 0x1f → 31, a 16-digit `<wwn>` losing its leading zero). Readers that need
// a number (memory, vcpu, topology, VNC port, creationTime) convert explicitly.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) =>
    ['disk', 'interface', 'controller', 'channel', 'input', 'sound',
     'video', 'hostdev', 'filesystem', 'serial', 'console', 'graphics',
     'rng', 'tpm', 'watchdog', 'redirdev', 'boot', 'feature'].includes(name),
});
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const WISP_NS_URI = 'https://wisp.local/app';
const WISP_PREFS_KEY = 'wisp:prefs';

/** Read string value from a wisp:prefs child element (plain text or a `{ '#text' }` object when it carries attributes). */
function wispPrefText(prefs, key) {
  const v = prefs[key];
  if (v == null) return '';
  const text = typeof v === 'object' ? v?.['#text'] : v;
  if (text == null) return '';
  return typeof text === 'string' ? text.trim() : String(text);
}

/** Extract Wisp prefs from domain metadata (wisp:prefs). */
function parseWispPrefs(dom) {
  const metadata = dom?.metadata;
  const none = { iconId: null, localDns: false, pendingRestart: false };
  if (!metadata || typeof metadata !== 'object') return none;
  const prefs = metadata[WISP_PREFS_KEY];
  if (!prefs || typeof prefs !== 'object') return none;
  const iconText = wispPrefText(prefs, 'wisp:icon');
  const localDns = wispPrefText(prefs, 'wisp:localDns').toLowerCase() === 'true';
  const pendingRestart = wispPrefText(prefs, 'wisp:pendingRestart').toLowerCase() === 'true';
  return { iconId: iconText || null, localDns, pendingRestart };
}

/**
 * The existing wisp:prefs element of a parsed domain, created (with its
 * namespace) when missing. Callers mutate the returned object in place so
 * prefs they don't own stay as libvirt returned them.
 */
function ensureWispPrefs(dom) {
  if (!dom.metadata || typeof dom.metadata !== 'object') dom.metadata = {};
  const existing = dom.metadata[WISP_PREFS_KEY];
  if (existing && typeof existing === 'object') return existing;
  const prefs = { '@_xmlns:wisp': WISP_NS_URI };
  dom.metadata[WISP_PREFS_KEY] = prefs;
  return prefs;
}

/** Drop wisp:prefs (and an emptied <metadata>) once no pref is left in it. */
function pruneWispPrefs(dom) {
  const prefs = dom.metadata?.[WISP_PREFS_KEY];
  if (prefs && typeof prefs === 'object' && Object.keys(prefs).some((k) => !k.startsWith('@_'))) return;
  if (dom.metadata) delete dom.metadata[WISP_PREFS_KEY];
  if (dom.metadata && Object.keys(dom.metadata).length === 0) delete dom.metadata;
}

/**
 * Set or clear the icon and local-DNS prefs on a parsed domain object (mutates dom).
 * iconId: string to store, or null/'' to clear
 * localDns: boolean to store (any other value clears it)
 * Other wisp:prefs children (pendingRestart) are left as they are.
 */
export function setWispMetadata(dom, { iconId, localDns }) {
  if (!dom) return;
  const prefs = ensureWispPrefs(dom);
  const nextIcon = iconId == null || iconId === '' ? null : String(iconId).trim();
  if (nextIcon) prefs['wisp:icon'] = nextIcon;
  else delete prefs['wisp:icon'];
  if (localDns === true || localDns === false) prefs['wisp:localDns'] = localDns ? 'true' : 'false';
  else delete prefs['wisp:localDns'];
  pruneWispPrefs(dom);
}

/** True when a parsed domain's wisp:prefs carry the restart-required flag. */
export function hasWispPendingRestart(dom) {
  return parseWispPrefs(dom).pendingRestart;
}

/**
 * Set or clear the restart-required pref on a parsed domain object (mutates dom).
 * Stored as `<wisp:pendingRestart>true</wisp:pendingRestart>`; absent means false.
 */
export function setWispPendingRestart(dom, value) {
  if (!dom) return;
  const prefs = ensureWispPrefs(dom);
  if (value === true) prefs['wisp:pendingRestart'] = 'true';
  else delete prefs['wisp:pendingRestart'];
  pruneWispPrefs(dom);
}

/**
 * Serialized domain definition without `<metadata>`: two definitions with the
 * same signature run the same QEMU, so a changed signature on a running VM is
 * a change that only applies on its next start. Wisp's own prefs live in
 * `<metadata>` and never count.
 */
export function domainDefinitionSignature(parsed) {
  const { metadata: _metadata, ...rest } = parsed.domain || {};
  return xmlBuilder.build({ ...parsed, domain: rest });
}

/** Parse raw XML string; returns full parsed object (e.g. for parsed.domain.os.nvram). */
export function parseDomainRaw(xmlString) {
  return xmlParser.parse(xmlString);
}

/** String leaf from domain XML (name, uuid) — fast-xml-parser may use `{ '#text': 'x' }`. */
function xmlLeafText(v) {
  if (v == null) return '';
  if (typeof v === 'object' && v['#text'] != null) return String(v['#text']).trim();
  return String(v).trim();
}

export function parseVMFromXML(xmlString) {
  const parsed = xmlParser.parse(xmlString);
  const dom = parsed.domain;
  if (!dom) return null;

  const memObj = dom.memory;
  const memUnit = typeof memObj === 'object' ? (memObj['@_unit'] || 'KiB') : 'KiB';
  const memVal = Number(typeof memObj === 'object' ? memObj['#text'] : memObj) || 0;
  const memoryKiB = memUnit === 'GiB' ? memVal * 1048576
    : memUnit === 'MiB' ? memVal * 1024
    : memVal;

  const vcpuRaw = typeof dom.vcpu === 'object' ? dom.vcpu['#text'] : dom.vcpu;

  let cpuTopology = null;
  if (dom.cpu?.topology) {
    const t = dom.cpu.topology;
    cpuTopology = {
      sockets: parseInt(t['@_sockets'] || '1', 10),
      dies: parseInt(t['@_dies'] || '1', 10),
      cores: parseInt(t['@_cores'] || '1', 10),
      threads: parseInt(t['@_threads'] || '1', 10),
    };
  }

  const osTypeNode = dom.os?.type;
  const osTypeStr = typeof osTypeNode === 'object' ? osTypeNode['#text'] : osTypeNode;
  const arch = typeof osTypeNode === 'object' ? osTypeNode['@_arch'] : null;
  const machine = typeof osTypeNode === 'object' ? osTypeNode['@_machine'] : null;

  let firmware = 'bios';
  if (dom.os?.['@_firmware'] === 'efi') {
    firmware = 'uefi';
  }
  const loader = dom.os?.loader;
  if (loader) {
    const loaderStr = (typeof loader === 'object' ? (loader['#text'] || '') : String(loader || '')).toLowerCase();
    const secure = typeof loader === 'object' && loader['@_secure'] === 'yes';
    if (loaderStr.includes('ovmf') || loaderStr.includes('edk2')) {
      firmware = secure ? 'uefi-secure' : 'uefi';
    }
  }

  const bootDevs = [];
  const boots = dom.os?.boot;
  if (boots) {
    for (const b of (Array.isArray(boots) ? boots : [boots])) {
      if (b?.['@_dev']) bootDevs.push(b['@_dev']);
    }
  }

  const disks = [];
  for (const d of (dom.devices?.disk || [])) {
    const target = d.target || {};
    const source = d.source || {};
    const driver = d.driver || {};
    disks.push({
      slot: target['@_dev'] || null,
      device: d['@_device'] || 'disk',
      bus: target['@_bus'] || null,
      source: source['@_file'] || source['@_dev'] || source['@_volume'] || null,
      driverType: driver['@_type'] || null,
      readonly: d.readonly !== undefined,
    });
  }

  const nics = [];
  for (const i of (dom.devices?.interface || [])) {
    nics.push({
      type: i['@_type'] || null,
      mac: i.mac?.['@_address'] || null,
      source: i.source?.['@_bridge'] || i.source?.['@_network'] || null,
      model: i.model?.['@_type'] || null,
      target: i.target?.['@_dev'] || null,
    });
  }

  let graphics = null;
  const gfxArr = dom.devices?.graphics;
  if (gfxArr && gfxArr.length > 0) {
    const g = gfxArr[0];
    graphics = {
      type: g['@_type'] || null,
      port: g['@_port'] ? parseInt(g['@_port'], 10) : null,
      listen: g['@_listen'] || null,
      autoport: g['@_autoport'] || null,
    };
  }

  const features = { hyperv: !!dom.features?.hyperv };

  const videoArr = dom.devices?.video;
  const videoModel = videoArr?.length > 0 ? (videoArr[0].model?.['@_type'] || null) : null;

  const bootMenu = dom.os?.bootmenu?.['@_enable'] === 'yes';

  const memballoonNode = dom.devices?.memballoon;
  const memBalloon = !memballoonNode || memballoonNode['@_model'] !== 'none';

  let guestAgent = false;
  for (const ch of (dom.devices?.channel || [])) {
    if (ch?.target?.['@_type'] === 'virtio' && ch?.target?.['@_name']?.includes('guest_agent')) {
      guestAgent = true;
      break;
    }
  }

  const vtpm = (dom.devices?.tpm || []).length > 0;
  const virtioRng = (dom.devices?.rng || []).some(r => r['@_model'] === 'virtio');

  const cpuFeatures = [];
  if (dom.cpu?.feature) {
    const feats = Array.isArray(dom.cpu.feature) ? dom.cpu.feature : [dom.cpu.feature];
    for (const f of feats) {
      if (f?.['@_name']) cpuFeatures.push({ name: f['@_name'], policy: f['@_policy'] || 'require' });
    }
  }

  const nestedVirt = cpuFeatures.some(f => (f.name === 'vmx' || f.name === 'svm') && f.policy !== 'disable');

  const hostdevs = [];
  for (const hd of (dom.devices?.hostdev || [])) {
    if (hd['@_type'] === 'usb' && hd['@_mode'] === 'subsystem') {
      const vendor = hd.source?.vendor;
      const product = hd.source?.product;
      const vid = (vendor?.['@_id'] || '').replace(/^0x/i, '');
      const pid = (product?.['@_id'] || '').replace(/^0x/i, '');
      if (vid && pid) {
        hostdevs.push({ type: 'usb', vendorId: vid, productId: pid });
      }
    }
  }

  const prefs = parseWispPrefs(dom);

  return {
    name: xmlLeafText(dom.name),
    uuid: xmlLeafText(dom.uuid),
    vcpus: parseInt(vcpuRaw, 10) || 1,
    memoryMiB: Math.round(memoryKiB / 1024),
    osType: osTypeStr || 'hvm',
    arch,
    machineType: machine,
    firmware,
    cpuMode: dom.cpu?.['@_mode'] || null,
    cpuTopology,
    bootOrder: bootDevs,
    disks,
    nics,
    graphics,
    features,
    videoModel,
    bootMenu,
    memBalloon,
    guestAgent,
    vtpm,
    virtioRng,
    cpuFeatures,
    nestedVirt,
    _hostdevs: hostdevs,
    iconId: prefs.iconId,
    localDns: prefs.localDns,
    pendingRestart: prefs.pendingRestart,
  };
}

export function detectOSCategory(config) {
  if (config.features?.hyperv) return 'windows';
  const name = (config.name || '').toLowerCase();
  if (name.includes('win')) return 'windows';
  return 'linux';
}

export function parseSnapshotFromXML(xmlString) {
  const parsed = xmlParser.parse(xmlString);
  const snap = parsed.domainsnapshot;
  if (!snap) return null;
  const creationTime = parseInt(xmlLeafText(snap.creationTime), 10);
  return {
    name: xmlLeafText(snap.name),
    creationTime: Number.isFinite(creationTime) ? creationTime : null,
    state: xmlLeafText(snap.state),
  };
}

export function buildXml(obj) {
  return xmlBuilder.build(obj);
}

/** Build a single disk element XML (e.g. for UpdateDevice). */
export function buildDiskXml(diskObj) {
  return xmlBuilder.build({ disk: diskObj });
}
