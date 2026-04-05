/**
 * Hardware inventory from `system_profiler -json` (macOS). Static-ish data for Host Overview.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Data types that map to Host Overview sections (extend as needed). */
const PROFILER_DATA_TYPES = [
  'SPHardwareDataType',
  'SPMemoryDataType',
  'SPStorageDataType',
  'SPNVMeDataType',
  'SPPCIDataType',
  'SPNetworkDataType',
  'SPDisplaysDataType',
];

const PROFILER_TIMEOUT_MS = 45_000;

/**
 * Depth-first walk of profiler JSON trees.
 * @param {unknown} node
 * @param {(o: Record<string, unknown>) => boolean} pred
 * @param {Record<string, unknown>[]} acc
 */
function walkProfilerObjects(node, pred, acc) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const x of node) walkProfilerObjects(x, pred, acc);
    return;
  }
  if (typeof node !== 'object') return;
  const o = /** @type {Record<string, unknown>} */ (node);
  if (pred(o)) acc.push(o);
  for (const v of Object.values(o)) walkProfilerObjects(v, pred, acc);
}

/**
 * @param {string | undefined} raw
 * @returns {number | null}
 */
function parseSizeBytes(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim().replace(/,/g, '');
  const m = s.match(/^([\d.]+)\s*(B|KB|MB|GB|TB|PB)\s*$/i);
  if (!m) {
    const num = parseFloat(s);
    return Number.isFinite(num) ? num : null;
  }
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = m[2].toUpperCase();
  const mult = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
    PB: 1024 ** 5,
  }[u];
  return mult != null ? Math.round(n * mult) : null;
}

/**
 * @param {string | undefined} raw e.g. "16 GB"
 */
function parseMemorySizeBytes(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  return parseSizeBytes(raw.trim());
}

/**
 * Apple Silicon `number_processors` e.g. "proc 12:8:4:0" → perf 8, eff 4, total 12.
 * @param {string | undefined} raw
 * @returns {{ total: number, perf: number, eff: number } | null}
 */
function parseNumberProcessors(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^proc\s+(\d+):(\d+):(\d+):(\d+)\s*$/i);
  if (!m) return null;
  const total = parseInt(m[1], 10);
  const perf = parseInt(m[2], 10);
  const eff = parseInt(m[3], 10);
  if (![total, perf, eff].every((x) => Number.isInteger(x))) return null;
  if (total <= 0) return null;
  return { total, perf, eff };
}

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runSystemProfilerJson() {
  const { stdout, stderr } = await execFileAsync(
    '/usr/sbin/system_profiler',
    ['-json', ...PROFILER_DATA_TYPES],
    {
      timeout: PROFILER_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'utf8',
    },
  );
  if (stderr && /error|fail/i.test(stderr) && !stdout.trim()) {
    throw new Error(stderr.trim().slice(0, 200));
  }
  const parsed = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('system_profiler returned non-object JSON');
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * @param {Record<string, unknown>} root
 * @returns {Record<string, unknown> | null}
 */
function getHardwareOverview(root) {
  const arr = root.SPHardwareDataType;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0];
  return first && typeof first === 'object' ? /** @type {Record<string, unknown>} */ (first) : null;
}

/**
 * Map sppci / IOKit style device type hints to Linux-like PCI class code (hex string).
 * @param {string | undefined} deviceType
 * @param {string | undefined} name
 */
function inferPciClassCode(deviceType, name) {
  const dt = String(deviceType || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (dt.includes('gpu') || dt.includes('display') || n.includes('display')) return '030000';
  if (dt.includes('ethernet') || dt.includes('network') || n.includes('ethernet')) return '020000';
  if (dt.includes('nvme') || dt.includes('storage') || n.includes('nvme')) return '010802';
  if (dt.includes('audio') || n.includes('audio')) return '040300';
  if (dt.includes('usb')) return '0c0330';
  if (dt.includes('bridge')) return '060400';
  return '000000';
}

/**
 * @param {Record<string, unknown>} o
 * @param {number} index
 */
function mapProfilerRowToPci(o, index) {
  const model = String(o.sppci_model || o._name || 'Unknown').trim();
  const vendor = String(o.sppci_vendor || o.spdisplays_vendor || 'Unknown')
    .replace(/^sppci_vendor_/i, '')
    .replace(/^spdisplays_vendor_/i, '')
    .replace(/_/g, ' ')
    .trim() || 'Unknown';
  const deviceType = o.sppci_device_type != null ? String(o.sppci_device_type) : '';
  const classCode = inferPciClassCode(deviceType, model);
  const classId = classCode.slice(0, 4);
  const addr = `0000:fe:${String(index).padStart(4, '0')}.0`;
  const className = deviceType
    ? deviceType.replace(/^sppci_/i, '').replace(/_/g, ' ')
    : 'Device';

  return {
    address: addr,
    classId,
    classCode,
    className: className || 'Device',
    vendor,
    vendorId: '0000',
    device: model,
    deviceId: '0000',
    driver: null,
  };
}

/**
 * @param {Record<string, unknown>} root
 */
function buildPciDevices(root) {
  const out = /** @type {ReturnType<typeof mapProfilerRowToPci>[]} */ ([]);
  const seen = new Set();

  const pushUnique = (row) => {
    const key = `${row.vendor}|${row.device}|${row.classCode}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };

  let idx = 0;
  const pciRaw = /** @type {Record<string, unknown>[]} */ ([]);
  walkProfilerObjects(root.SPPCIDataType, (o) => !!(o.sppci_model || o.sppci_device_type), pciRaw);
  for (const o of pciRaw) pushUnique(mapProfilerRowToPci(o, idx++));

  const displays = root.SPDisplaysDataType;
  if (Array.isArray(displays)) {
    for (const d of displays) {
      if (!d || typeof d !== 'object') continue;
      const o = /** @type {Record<string, unknown>} */ (d);
      if (!o._name && !o.sppci_model) continue;
      pushUnique(mapProfilerRowToPci(
        {
          ...o,
          sppci_device_type: o.sppci_device_type || 'spdisplays_gpu',
          sppci_model: o.sppci_model || o._name,
          sppci_vendor: o.spdisplays_vendor || 'sppci_vendor_Apple',
        },
        idx++,
      ));
    }
  }

  return out.sort((a, b) => a.address.localeCompare(b.address, 'en'));
}

/**
 * @param {Record<string, unknown>} root
 */
function buildMemoryModules(root) {
  const raw = /** @type {Record<string, unknown>[]} */ ([]);
  walkProfilerObjects(root.SPMemoryDataType, (o) => {
    if (o.dimm_type != null || o.dimm_manufacturer != null) return true;
    if (typeof o.SPMemoryDataType === 'string') return true;
    return false;
  }, raw);

  const out = [];
  let slot = 1;
  for (const o of raw) {
    const sizeStr = typeof o.SPMemoryDataType === 'string' ? o.SPMemoryDataType : undefined;
    const sizeBytes = parseMemorySizeBytes(sizeStr) ?? null;
    const type = o.dimm_type != null ? String(o.dimm_type) : sizeBytes != null ? 'Memory' : 'Memory';
    const manufacturer = o.dimm_manufacturer != null ? String(o.dimm_manufacturer) : null;
    let speedMts = null;
    if (o.dimm_speed != null) {
      const sp = parseInt(String(o.dimm_speed).replace(/\D/g, ''), 10);
      if (Number.isInteger(sp)) speedMts = sp;
    }
    const formFactor = o.dimm_form_factor != null ? String(o.dimm_form_factor) : null;

    out.push({
      type,
      sizeBytes: sizeBytes ?? 0,
      speedMts,
      slot: String(slot),
      formFactor: formFactor || (sizeStr ? 'Module' : 'DIMM'),
      manufacturer,
      voltage: o.dimm_voltage != null ? String(o.dimm_voltage) : null,
    });
    slot += 1;
  }

  return out;
}

/**
 * @param {Record<string, unknown>} root
 */
function buildDisks(root) {
  const candidates = /** @type {Record<string, unknown>[]} */ ([]);
  walkProfilerObjects(root.SPStorageDataType, (o) => {
    if (o.bsd_name != null) return true;
    if (o.device_name != null && (o.medium_type != null || o.size != null)) return true;
    return false;
  }, candidates);

  /** @type {Map<string, { name: string, model: string, sizeBytes: number, rotational: boolean | null, pciAddress: null }>} */
  const byName = new Map();

  for (const o of candidates) {
    const name = o.bsd_name != null ? String(o.bsd_name) : null;
    /* Whole disks are disk0, disk1, … — skip APFS/container slices (disk0s1, …). */
    if (name && /disk\d+s\d+/i.test(name)) continue;
    const model = String(o.device_name || o._name || 'Unknown').trim();
    if (!name && !model) continue;
    const key = name || `disk_${byName.size}`;
    const sizeBytes = parseSizeBytes(typeof o.size === 'string' ? o.size : undefined) ?? 0;
    let rotational = null;
    if (o.medium_type != null) {
      const mt = String(o.medium_type).toLowerCase();
      if (mt.includes('ssd') || mt === 'flash') rotational = false;
      else if (mt.includes('rotational') || mt === 'hdd' || mt === 'disk') rotational = true;
    }
    const prev = byName.get(key);
    if (!prev || (sizeBytes > prev.sizeBytes && sizeBytes > 0)) {
      byName.set(key, {
        name: key,
        model,
        sizeBytes,
        rotational,
        pciAddress: null,
      });
    }
  }

  const nvmeRaw = /** @type {Record<string, unknown>[]} */ ([]);
  walkProfilerObjects(
    root.SPNVMeDataType,
    (o) => o.device_model != null || (o._name != null && o.device_serial != null),
    nvmeRaw,
  );

  let nvmeIdx = 0;
  for (const o of nvmeRaw) {
    const model = String(o.device_model || o._name || 'NVMe').trim();
    const serial = o.device_serial != null ? String(o.device_serial) : `n${nvmeIdx}`;
    const name = `nvme_${serial.slice(0, 12)}`;
    nvmeIdx += 1;
    if ([...byName.values()].some((d) => d.model === model && d.name.startsWith('disk'))) continue;
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        model,
        sizeBytes: 0,
        rotational: false,
        pciAddress: null,
      });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/**
 * @param {string | undefined} mediaSubtype
 * @returns {number | null}
 */
function mediaSubtypeToMbps(mediaSubtype) {
  if (mediaSubtype == null || typeof mediaSubtype !== 'string') return null;
  const s = mediaSubtype.toLowerCase();
  const m = s.match(/(\d+)\s*base-t/);
  if (m) return parseInt(m[1], 10);
  if (s.includes('10gbase-t') || s.includes('10g')) return 10000;
  if (s.includes('5gbase-t') || s.includes('5g')) return 5000;
  if (s.includes('2.5gbase-t') || s.includes('2500')) return 2500;
  if (s.includes('1000base') || s.includes('1g')) return 1000;
  if (s.includes('100base')) return 100;
  if (s.includes('10base')) return 10;
  return null;
}

/**
 * @param {Record<string, unknown>} root
 * @returns {Map<string, { mac: string | null, speedMbps: number | null, state: string }>}
 */
function buildNetworkEnrichMap(root) {
  const map = new Map();
  const services = root.SPNetworkDataType;
  if (!Array.isArray(services)) return map;

  for (const svc of services) {
    if (!svc || typeof svc !== 'object') continue;
    const o = /** @type {Record<string, unknown>} */ (svc);
    const iface = o.interface != null ? String(o.interface) : null;
    if (!iface) continue;
    const eth = o.Ethernet;
    let mac = null;
    let speedMbps = null;
    if (eth && typeof eth === 'object') {
      const e = /** @type {Record<string, unknown>} */ (eth);
      if (e['MAC Address'] != null) mac = String(e['MAC Address']);
      if (e.MediaSubType != null) speedMbps = mediaSubtypeToMbps(String(e.MediaSubType));
    }
    map.set(iface, { mac, speedMbps, state: 'unknown' });
  }
  return map;
}

/**
 * @param {Record<string, unknown>} hw
 * @param {{ logicalCpus: number, model: string }} osFallback
 * @returns {{ model: string, cores: number, threads: number, mhz: number | null, cacheKb: number | null, coreTypes: { performance: number[], efficiency: number[] } | null }}
 */
function buildCpuFromHardware(hw, osFallback) {
  const chipType = String(hw.chip_type || hw.cpu_type || '').trim();
  const model = chipType || osFallback.model || 'CPU';
  const proc = parseNumberProcessors(hw.number_processors != null ? String(hw.number_processors) : undefined);
  let cores = osFallback.logicalCpus;
  let threads = osFallback.logicalCpus;
  /** @type {{ performance: number[], efficiency: number[] } | null} */
  let coreTypes = null;

  if (proc) {
    threads = proc.total;
    cores = proc.perf + proc.eff > 0 ? proc.perf + proc.eff : proc.total;
    if (proc.perf > 0 && proc.eff > 0) {
      const perf = Array.from({ length: proc.perf }, (_, i) => i);
      const eff = Array.from({ length: proc.eff }, (_, i) => i + proc.perf);
      coreTypes = { performance: perf, efficiency: eff };
    }
  }

  return {
    model,
    cores,
    threads,
    mhz: null,
    cacheKb: null,
    coreTypes,
  };
}

/**
 * @param {Record<string, unknown>} hw
 */
function buildSystemFromHardware(hw) {
  const chip = hw.chip_type != null ? String(hw.chip_type) : null;
  const isApple = !!chip || String(hw.machine_name || '').includes('Mac');

  return {
    boardVendor: isApple ? 'Apple Inc.' : null,
    boardName: hw.machine_model != null ? String(hw.machine_model) : null,
    boardVersion: hw.model_number != null ? String(hw.model_number) : null,
    systemVendor: isApple ? 'Apple Inc.' : null,
    systemProduct: [hw.machine_name, hw.model_number].filter(Boolean).map(String).join(' ').trim() || null,
    systemVersion: null,
    biosVendor: isApple ? 'Apple' : null,
    biosVersion: hw.boot_rom_version != null ? String(hw.boot_rom_version) : null,
    biosDate: null,
  };
}

/**
 * Parse `system_profiler -json` root into Host Overview–oriented structures.
 * @param {Record<string, unknown>} root
 * @param {{ logicalCpus: number, model: string }} osFallback
 */
export function mapProfilerToHardwareParts(root, osFallback) {
  const hw = getHardwareOverview(root);
  const cpu = hw ? buildCpuFromHardware(hw, osFallback) : null;
  const system = hw ? buildSystemFromHardware(hw) : null;

  return {
    cpu,
    system,
    memory: buildMemoryModules(root),
    pciDevices: buildPciDevices(root),
    disks: buildDisks(root),
    networkEnrich: buildNetworkEnrichMap(root),
  };
}
