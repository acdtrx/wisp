import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAppError } from '../../routeErrors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const SMARTCTL_INSTALLED = '/usr/local/bin/wisp-smartctl';
const SMARTCTL_BUNDLED = resolve(__dirname, '../../../../scripts/wisp-smartctl');

async function resolveSmartctlScriptPath() {
  const fromEnv = process.env.WISP_SMARTCTL_SCRIPT;
  if (fromEnv) {
    try {
      await access(fromEnv);
      return fromEnv;
    } catch {
      return null;
    }
  }

  for (const p of [SMARTCTL_INSTALLED, SMARTCTL_BUNDLED]) {
    try {
      await access(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeTemperatureC(raw) {
  const explicit = parseNumber(raw?.temperature?.current);
  if (explicit != null) return explicit;

  const nvmeTemp = parseNumber(raw?.nvme_smart_health_information_log?.temperature);
  if (nvmeTemp == null) return null;
  // NVMe may report Kelvin in some payloads.
  if (nvmeTemp > 200) return Math.round((nvmeTemp - 273.15) * 10) / 10;
  return nvmeTemp;
}

function normalizePowerOnHours(raw) {
  const bySmartctl = parseNumber(raw?.power_on_time?.hours);
  if (bySmartctl != null) return bySmartctl;
  return parseNumber(raw?.power_on_hours);
}

function ataAttributeTable(raw) {
  const t = raw?.ata_smart_attributes?.table;
  return Array.isArray(t) ? t : [];
}

function ataRowById(table, id) {
  return table.find((row) => row?.id === id) ?? null;
}

/** Prefer numeric raw.value; else parse leading integer from raw.string (handles "12345" and "0x…" hex). */
function ataAttributeRawCount(row) {
  if (!row?.raw) return null;
  const direct = parseNumber(row.raw.value);
  if (direct != null) return direct;
  const s = String(row.raw.string ?? '').trim();
  if (!s) return null;
  const hexMatch = /^0x[0-9a-f]+$/i.exec(s.split(/\s+/)[0] ?? '');
  if (hexMatch) {
    const n = Number.parseInt(hexMatch[0].slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  const decMatch = /^(\d+)/.exec(s.replace(/_/g, ''));
  if (!decMatch) return null;
  const n = Number.parseInt(decMatch[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Vendor-dependent SSD "life remaining" style value from ATA SMART (0–100).
 * Uses first present attribute among 231, 202, 233 with value in 0–100.
 */
function normalizeAtaSsdLifePercentRemaining(table) {
  for (const id of [231, 202, 233]) {
    const row = ataRowById(table, id);
    const v = parseNumber(row?.value);
    if (v != null && v >= 0 && v <= 100) return Math.round(v);
  }
  return null;
}

function normalizeAtaSectorHealth(raw) {
  const table = ataAttributeTable(raw);
  return {
    reallocatedSectors: ataAttributeRawCount(ataRowById(table, 5)),
    pendingSectors: ataAttributeRawCount(ataRowById(table, 197)),
    offlineUncorrectableSectors: ataAttributeRawCount(ataRowById(table, 198)),
    ssdLifePercentRemaining: normalizeAtaSsdLifePercentRemaining(table),
  };
}

/** NVMe Percentage Used: 0–255 per spec; may exceed 100 on some devices. */
function normalizeNvmeHealthLogFields(raw) {
  const log = raw?.nvme_smart_health_information_log;
  if (!log || typeof log !== 'object') {
    return {
      percentageUsed: null,
      availableSpare: null,
      availableSpareThreshold: null,
    };
  }
  return {
    percentageUsed: parseNumber(log.percentage_used),
    availableSpare: parseNumber(log.available_spare),
    availableSpareThreshold: parseNumber(log.available_spare_threshold),
  };
}

function normalizeCriticalWarning(raw) {
  const nvmeWarn = parseNumber(raw?.nvme_smart_health_information_log?.critical_warning);
  if (nvmeWarn != null) {
    return nvmeWarn === 0 ? null : `NVMe critical warning (0x${nvmeWarn.toString(16)})`;
  }

  if (raw?.smart_status?.passed === false) return 'SMART overall status failed';
  return null;
}

function normalizeOverall(raw, criticalWarning) {
  if (raw?.smart_status?.passed === true) return 'healthy';
  if (raw?.smart_status?.passed === false) return 'failing';
  if (criticalWarning) return 'warning';
  return 'unknown';
}

function hasSmartPayload(raw) {
  return Boolean(
    raw
      && typeof raw === 'object'
      && (
        raw.smart_status != null
        || raw.ata_smart_data != null
        || raw.ata_smart_attributes != null
        || raw.nvme_smart_health_information_log != null
        || raw.temperature != null
        || raw.power_on_time != null
      )
  );
}

function unsupportedSummary(error) {
  return {
    supported: false,
    overall: 'unknown',
    temperatureC: null,
    powerOnHours: null,
    criticalWarning: null,
    percentageUsed: null,
    availableSpare: null,
    availableSpareThreshold: null,
    reallocatedSectors: null,
    pendingSectors: null,
    offlineUncorrectableSectors: null,
    ssdLifePercentRemaining: null,
    lastUpdated: new Date().toISOString(),
    error,
  };
}

function normalizeSmartSummary(raw) {
  const criticalWarning = normalizeCriticalWarning(raw);
  const nvme = normalizeNvmeHealthLogFields(raw);
  const ata = normalizeAtaSectorHealth(raw);
  return {
    supported: true,
    overall: normalizeOverall(raw, criticalWarning),
    temperatureC: normalizeTemperatureC(raw),
    powerOnHours: normalizePowerOnHours(raw),
    criticalWarning,
    percentageUsed: nvme.percentageUsed,
    availableSpare: nvme.availableSpare,
    availableSpareThreshold: nvme.availableSpareThreshold,
    reallocatedSectors: ata.reallocatedSectors,
    pendingSectors: ata.pendingSectors,
    offlineUncorrectableSectors: ata.offlineUncorrectableSectors,
    ssdLifePercentRemaining: ata.ssdLifePercentRemaining,
    lastUpdated: new Date().toISOString(),
    error: null,
  };
}

async function readDiskSmartRaw(deviceName) {
  if (!/^[a-zA-Z0-9._-]+$/.test(String(deviceName || ''))) {
    throw createAppError('SMART_INVALID_DISK_NAME', 'invalid-disk-name');
  }

  const scriptPath = await resolveSmartctlScriptPath();
  if (!scriptPath) throw createAppError('SMART_HELPER_UNAVAILABLE', 'smartctl-helper-unavailable');

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const args = isRoot
    ? ['bash', [scriptPath, deviceName]]
    : ['sudo', ['-n', scriptPath, deviceName]];
  const { stdout } = await execFileAsync(args[0], args[1], { timeout: 10000 });
  if (!stdout || !stdout.trim()) throw createAppError('SMART_EMPTY_OUTPUT', 'empty-smartctl-output');

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw createAppError('SMART_INVALID_JSON', 'invalid-smartctl-json');
  }

  if (parsed?.error === 'device-not-found') throw createAppError('SMART_DEVICE_NOT_FOUND', 'device-not-found');
  if (parsed?.error === 'smartctl-not-found') throw createAppError('SMART_NOT_INSTALLED', 'smartctl-not-installed');
  if (parsed?.error === 'invalid-device-name') throw createAppError('SMART_INVALID_DISK_NAME', 'invalid-disk-name');
  return parsed;
}

export async function readDiskSmartSummary(deviceName) {
  try {
    const raw = await readDiskSmartRaw(deviceName);
    if (!hasSmartPayload(raw)) return unsupportedSummary('SMART data unavailable for disk');
    return normalizeSmartSummary(raw);
  } catch (err) {
    return unsupportedSummary(err?.message || 'SMART read failed');
  }
}

export async function readAllDiskSmartSummaries(disks) {
  const items = Array.isArray(disks) ? disks : [];
  const summaries = await Promise.all(
    items.map(async (disk) => {
      const summary = await readDiskSmartSummary(disk.name);
      return {
        ...disk,
        smart: summary,
      };
    }),
  );
  return summaries;
}
