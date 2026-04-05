/**
 * Domain and snapshot XML parsing and building.
 */
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    ['disk', 'interface', 'controller', 'channel', 'input', 'sound',
     'video', 'hostdev', 'filesystem', 'serial', 'console', 'graphics',
     'rng', 'tpm', 'watchdog', 'redirdev', 'boot', 'feature'].includes(name),
});
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const WISP_NS_URI = 'https://wisp.local/app';
const WISP_PREFS_KEY = 'wisp:prefs';

/** Read string value from a wisp:prefs child element (handles #text object and boolean coercion from fast-xml-parser). */
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
  if (!metadata || typeof metadata !== 'object') return { iconId: null, localDns: false };
  const prefs = metadata[WISP_PREFS_KEY];
  if (!prefs || typeof prefs !== 'object') return { iconId: null, localDns: false };
  const iconText = wispPrefText(prefs, 'wisp:icon');
  const localDns = wispPrefText(prefs, 'wisp:localDns').toLowerCase() === 'true';
  return { iconId: iconText || null, localDns };
}

/**
 * Set or clear Wisp app metadata on a parsed domain object (mutates dom).
 * iconId: string to store (optional)
 * localDns: boolean to store (optional)
 */
export function setWispMetadata(dom, { iconId, localDns }) {
  if (!dom) return;
  if (!dom.metadata) dom.metadata = {};
  const nextIcon = iconId == null || iconId === '' ? null : String(iconId).trim();
  const hasLocalDns = localDns === true || localDns === false;
  if (!nextIcon && !hasLocalDns) {
    delete dom.metadata[WISP_PREFS_KEY];
    if (Object.keys(dom.metadata).length === 0) delete dom.metadata;
    return;
  }
  const prefs = {
    '@_xmlns:wisp': WISP_NS_URI,
  };
  if (nextIcon) prefs['wisp:icon'] = nextIcon;
  if (hasLocalDns) prefs['wisp:localDns'] = localDns ? 'true' : 'false';
  dom.metadata[WISP_PREFS_KEY] = prefs;
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
    const vlanNode = i.vlan?.tag;
    const vlanId = Array.isArray(vlanNode) ? vlanNode[0]?.['@_id'] : vlanNode?.['@_id'];
    nics.push({
      type: i['@_type'] || null,
      mac: i.mac?.['@_address'] || null,
      source: i.source?.['@_bridge'] || i.source?.['@_network'] || null,
      model: i.model?.['@_type'] || null,
      target: i.target?.['@_dev'] || null,
      vlan: vlanId != null ? parseInt(vlanId, 10) : null,
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
  const name = typeof snap.name === 'object' ? snap.name['#text'] : snap.name;
  const creationTime = typeof snap.creationTime === 'object' ? snap.creationTime['#text'] : snap.creationTime;
  const state = typeof snap.state === 'object' ? snap.state['#text'] : snap.state;
  return {
    name: name || '',
    creationTime: creationTime != null ? parseInt(creationTime, 10) : null,
    state: state || '',
  };
}

export function buildXml(obj) {
  return xmlBuilder.build(obj);
}

/** Build a single disk element XML (e.g. for UpdateDevice). */
export function buildDiskXml(diskObj) {
  return xmlBuilder.build({ disk: diskObj });
}
