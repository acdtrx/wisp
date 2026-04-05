import { Fragment, useEffect, useState } from 'react';
import { CircuitBoard, Cpu, HardDrive, Loader2, MemoryStick, Network, Package } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import {
  DataTableScroll,
  DataTable,
  dataTableHeadRowClass,
  dataTableBodyRowClass,
  DataTableTh,
  DataTableTd,
  dataTableCellPadX,
} from '../shared/DataTableChrome.jsx';
import { useHostStore } from '../../store/hostStore.js';
import { useStatsStore } from '../../store/statsStore.js';
import { getHostInfo } from '../../api/host.js';
import { formatDecimal } from '../../utils/formatters.js';

function formatBytes(bytes) {
  if (bytes >= 1024 ** 4) return `${formatDecimal(bytes / 1024 ** 4)} TB`;
  if (bytes >= 1024 ** 3) return `${formatDecimal(bytes / 1024 ** 3)} GB`;
  if (bytes >= 1024 ** 2) return `${formatDecimal(bytes / 1024 ** 2)} MB`;
  return `${bytes} B`;
}

/** ACPI thermal zones (`acpitz`); often platform/motherboard, shown in Hardware summary. */
function isAcpiPlatformThermalZone(zone) {
  return String(zone?.type || '').toLowerCase().includes('acpitz');
}

function getNvmeSensorIndex(zone) {
  const combined = `${zone?.type || ''} ${zone?.label || ''}`.toLowerCase();
  const match = combined.match(/nvme\s*([0-9]+)/i);
  if (!match) return null;
  const idx = parseInt(match[1], 10);
  return Number.isInteger(idx) ? idx : null;
}

function mapNvmeTemps(disks, thermalZones) {
  const nvmeDisks = (disks || []).filter((d) => /^nvme\d+n\d+$/.test(String(d.name || '')));
  if (nvmeDisks.length === 0) return { byDisk: new Map(), usedZoneIndexes: new Set() };

  const byDisk = new Map();
  const usedZoneIndexes = new Set();

  thermalZones.forEach((zone, index) => {
    const combined = `${zone?.type || ''} ${zone?.label || ''}`.toLowerCase();
    if (!combined.includes('nvme')) return;
    if (zone?.tempC == null) return;

    const sensorIdx = getNvmeSensorIndex(zone);
    if (sensorIdx != null) {
      const matchedDisk = nvmeDisks.find((d) => d.name.startsWith(`nvme${sensorIdx}n`));
      if (matchedDisk && !byDisk.has(matchedDisk.name)) {
        byDisk.set(matchedDisk.name, zone);
        usedZoneIndexes.add(index);
      }
    }
  });

  const unassignedSensors = thermalZones
    .map((zone, index) => ({ zone, index }))
    .filter(({ zone, index }) => (
      !usedZoneIndexes.has(index)
      && `${zone?.type || ''} ${zone?.label || ''}`.toLowerCase().includes('nvme')
      && zone?.tempC != null
    ));

  if (nvmeDisks.length === 1 && unassignedSensors.length > 0) {
    const onlyDisk = nvmeDisks[0];
    if (!byDisk.has(onlyDisk.name)) {
      byDisk.set(onlyDisk.name, unassignedSensors[0].zone);
      usedZoneIndexes.add(unassignedSensors[0].index);
    }
  }

  return { byDisk, usedZoneIndexes };
}

function formatThresholdTooltip(thresholds) {
  if (!thresholds) return null;
  const parts = [];
  if (thresholds.maxC != null) parts.push(`Max: ${thresholds.maxC} °C`);
  if (thresholds.critC != null) parts.push(`Critical: ${thresholds.critC} °C`);
  return parts.length > 0 ? parts.join(' | ') : null;
}

/** PCI base class 0x06 = Bridge — hidden from inventory (chipset plumbing). */
function isPciBridgeClass(classCode) {
  return String(classCode || '').slice(0, 2) === '06';
}

/**
 * Canonical PCI BDF for map keys (matches sysfs `0000:dd:dd.d` style).
 * @param {string | null | undefined} addr
 */
function normalizePciBdf(addr) {
  const s = String(addr || '').trim().toLowerCase();
  const m = s.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-9a-f])$/);
  if (!m) return s;
  const domain = Number.parseInt(m[1], 16);
  const bus = Number.parseInt(m[2], 16);
  const dev = Number.parseInt(m[3], 16);
  if (![domain, bus, dev].every((n) => Number.isFinite(n))) return s;
  return `${domain.toString(16).padStart(4, '0')}:${bus.toString(16).padStart(2, '0')}:${dev.toString(16).padStart(2, '0')}.${m[4]}`;
}

/**
 * Plan order within bands: network → graphics → storage → HD audio → USB → communication → other.
 * @param {string} classCode sysfs-normalized 6 hex chars (lowercase)
 * @returns {number[]}
 */
function pciInventorySortTuple(classCode) {
  const c = String(classCode || '').toLowerCase();
  const b = c.slice(0, 2);
  const b4 = c.slice(0, 4);
  if (b === '02') return [1, 0];
  if (b === '03') return [1, 1];
  if (b === '01') return [1, 2];
  if (b4 === '0403') return [1, 3];
  if (b4 === '0c03') return [2, 0];
  if (b === '07') return [2, 1];
  return [3, 0];
}

function comparePciInventoryRows(a, b) {
  const ta = pciInventorySortTuple(a.classCode);
  const tb = pciInventorySortTuple(b.classCode);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i += 1) {
    const va = ta[i] ?? 0;
    const vb = tb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return a.address.localeCompare(b.address, 'en');
}

/**
 * Main vs I/O vs Others buckets for PCI rows (excluding bridges; excluding disks’ parent controllers).
 * @param {string} classCode
 * @returns {'main' | 'io' | 'other'}
 */
function pciHardwareBucket(classCode) {
  const c = String(classCode || '').toLowerCase();
  const b = c.slice(0, 2);
  const b4 = c.slice(0, 4);
  if (b === '01' || b === '02') return 'main';
  if (b === '03' || b === '04' || b4 === '0c03') return 'io';
  return 'other';
}

/** @param {{ name?: string, rotational?: boolean | null }} disk */
function blockDeviceStorageTypeLabel(disk) {
  const name = String(disk?.name || '');
  if (name.startsWith('nvme')) return 'Storage (NVMe)';
  const r = disk?.rotational;
  if (r === true) return 'Storage (HDD)';
  if (r === false) return 'Storage (SSD)';
  return 'Storage';
}

/** @param {{ formFactor?: string | null, slot?: string }} m */
function formatRamInventoryType(m) {
  const form = m.formFactor || 'DIMM';
  const slot = m.slot || '—';
  return `${form} - Slot ${slot}`;
}

/** @param {{ type?: string, sizeBytes?: number, speedMts?: number | null, voltage?: string | null }} m */
function formatRamInventoryDevice(m) {
  const parts = [
    m.type || null,
    m.sizeBytes != null ? formatBytes(m.sizeBytes) : null,
    m.speedMts != null ? `${m.speedMts} MT/s` : null,
    m.voltage || null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' - ') : '—';
}

function formatSmartHealthLabel(smart) {
  const overall = String(smart?.overall || 'unknown');
  if (!smart?.supported) return 'Unavailable';
  if (overall === 'healthy') return 'Healthy';
  if (overall === 'warning') return 'Warning';
  if (overall === 'failing') return 'Failing';
  return 'Unknown';
}

const POWER_ON_HOURS_PER_DAY = 24;
/** Approximate month for display only (30 × 24 h); not calendar months. */
const POWER_ON_HOURS_PER_MONTH = 30 * POWER_ON_HOURS_PER_DAY;

function formatPowerOnHoursLabel(hours) {
  if (!Number.isFinite(hours) || hours < 0) return null;
  const total = Math.round(hours);
  if (total === 0) return 'Power-on: 0H';
  const months = Math.floor(total / POWER_ON_HOURS_PER_MONTH);
  let rem = total % POWER_ON_HOURS_PER_MONTH;
  const days = Math.floor(rem / POWER_ON_HOURS_PER_DAY);
  rem %= POWER_ON_HOURS_PER_DAY;
  const hrs = rem;
  const parts = [];
  if (months > 0) parts.push(`${months}m`);
  if (days > 0) parts.push(`${days}d`);
  if (hrs > 0) parts.push(`${hrs}h`);
  return `Power-on: ${parts.join(' ')}`;
}

/** NVMe Percentage Used (0–255 per spec); over 100 shown as N%+ . */
function formatNvmeWearPercent(percentageUsed) {
  if (!Number.isFinite(percentageUsed) || percentageUsed < 0) return null;
  const n = Math.round(percentageUsed);
  if (n <= 100) return `Wear: ${n}%`;
  return `Wear: ${n}%+`;
}

function formatNvmeSpareLine(smart) {
  const s = smart?.availableSpare;
  if (!Number.isFinite(s)) return null;
  const thr = smart?.availableSpareThreshold;
  if (Number.isFinite(thr)) {
    return `Spare: ${Math.round(s)}% (min ${Math.round(thr)}%)`;
  }
  return `Spare: ${Math.round(s)}%`;
}

function formatAtaSectorLine(smart) {
  const parts = [];
  const r = smart?.reallocatedSectors;
  if (Number.isFinite(r) && r > 0) parts.push(`Realloc: ${r}`);
  const p = smart?.pendingSectors;
  if (Number.isFinite(p) && p > 0) parts.push(`Pending: ${p}`);
  const o = smart?.offlineUncorrectableSectors;
  if (Number.isFinite(o) && o > 0) parts.push(`Uncorr: ${o}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

function formatSsdLifeRemainingLine(pct) {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return `Life: ${Math.round(pct)}%`;
}

function HardwareInventoryTableHead() {
  return (
    <thead>
      <tr className={dataTableHeadRowClass}>
        <DataTableTh dense>Type</DataTableTh>
        <DataTableTh dense>Device</DataTableTh>
        <DataTableTh dense>Vendor</DataTableTh>
        <DataTableTh dense>Driver</DataTableTh>
        <DataTableTh dense>Address</DataTableTh>
        <DataTableTh dense>Temp</DataTableTh>
      </tr>
    </thead>
  );
}

/** Max temp per PCI BDF from hwmon zones that expose pciAddress */
function buildPciTempByAddress(thermalZones) {
  const m = new Map();
  for (const z of thermalZones || []) {
    if (!z.pciAddress || z.tempC == null) continue;
    const addr = normalizePciBdf(z.pciAddress);
    if (!addr) continue;
    const prev = m.get(addr);
    if (prev == null || z.tempC > prev) m.set(addr, z.tempC);
  }
  return m;
}

function CoreUsageGrid({ title, cores }) {
  if (!Array.isArray(cores) || cores.length === 0) return null;

  return (
    <div className="space-y-1">
      {title && (
        <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider">{title}</p>
      )}
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(cores.length, 8)}, 1fr)` }}>
        {cores.map(({ index, percent }) => (
          <div key={index} className="min-w-0">
            <div className="flex justify-between text-[10px] text-text-muted mb-0.5">
              <span>Core {index}</span>
              <span>{formatDecimal(percent)}%</span>
            </div>
            <div className="h-2 rounded bg-surface overflow-hidden">
              <div
                className="h-full bg-accent rounded transition-all duration-300"
                style={{ width: `${Math.min(100, percent)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HostOverview() {
  const { hardware, hardwareError, fetchHardware } = useHostStore();
  const stats = useStatsStore((s) => s.stats);

  useEffect(() => {
    /* hardwareError in store handles display; swallow to avoid unhandled rejection */
    fetchHardware().catch(() => {});
  }, [fetchHardware]);

  if (!stats) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-text-muted" />
      </div>
    );
  }

  const cpu = stats.cpu || {};
  const memory = stats.memory || {};
  const perCore = cpu.perCore || [];
  const thermalZones = Array.isArray(stats.thermalZones) ? stats.thermalZones : [];
  const disks = hardware?.disks || [];
  const coreTypes = hardware?.cpu?.coreTypes || null;
  const loadAvg = stats.loadAvg;
  const cpuTempTooltip = formatThresholdTooltip(stats.cpuTempThresholds);
  const { byDisk: nvmeTempByDisk } = mapNvmeTemps(disks, thermalZones);
  const motherboardAcpiZone = thermalZones.find((z) => isAcpiPlatformThermalZone(z) && z.tempC != null) ?? null;
  const perfCores = (coreTypes?.performance || [])
    .map((index) => ({ index, percent: perCore[index] }))
    .filter((entry) => Number.isFinite(entry.percent));
  const effCores = (coreTypes?.efficiency || [])
    .map((index) => ({ index, percent: perCore[index] }))
    .filter((entry) => Number.isFinite(entry.percent));
  const hasHybridSplit = perfCores.length > 0 && effCores.length > 0;
  const allCores = perCore.map((percent, index) => ({ index, percent }));

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
      {/* CPU */}
      <SectionCard title="CPU" titleIcon={<Cpu size={14} strokeWidth={2} />}>
        {hardwareError && <p className="text-sm text-status-stopped mb-2">{hardwareError}</p>}
        <p className="text-sm text-text-secondary mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          {hardware?.cpu && (
            <>
              <span className="font-medium text-text-primary">{hardware.cpu.model}</span>
              <span>{hardware.cpu.cores} cores, {hardware.cpu.threads} threads</span>
              {hardware.cpu.mhz != null && <span>{formatDecimal(hardware.cpu.mhz)} MHz</span>}
              {hardware.cpu.cacheKb != null && (
                <span>
                  <span className="text-text-muted">Cache:</span> {hardware.cpu.cacheKb} KB
                </span>
              )}
            </>
          )}
          {loadAvg != null && (
            <span title="1, 5, 15 min">
              <span className="text-text-muted">Load:</span> {loadAvg[0].toFixed(2)} / {loadAvg[1].toFixed(2)} / {loadAvg[2].toFixed(2)}
            </span>
          )}
          {stats.cpuTemp != null && (
            <span title={cpuTempTooltip || undefined}>
              <span className="text-text-muted">Temp:</span> {stats.cpuTemp} °C
            </span>
          )}
          {stats.cpuPowerWatts != null && (
            <span><span className="text-text-muted">Power:</span> {stats.cpuPowerWatts} W</span>
          )}
        </p>
        {perCore.length > 0 && (
          <div className="space-y-1.5">
            {hasHybridSplit ? (
              <div className="space-y-2">
                <CoreUsageGrid title="Performance cores" cores={perfCores} />
                <CoreUsageGrid title="Efficiency cores" cores={effCores} />
              </div>
            ) : (
              <CoreUsageGrid cores={allCores} />
            )}
          </div>
        )}
      </SectionCard>

      {/* Memory */}
      <SectionCard title="Memory" titleIcon={<MemoryStick size={14} strokeWidth={2} />}>
        <div className="text-sm space-y-2">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Usage</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span><span className="text-text-muted">Total:</span> {formatBytes(memory.totalGB * 1024 ** 3)}</span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent shrink-0" aria-hidden />
              <span className="text-text-muted">Used:</span> {formatBytes(memory.usedBytes ?? 0)} ({formatDecimal(memory.usagePercent ?? 0)}%)
            </span>
            {(memory.cachedBytes ?? 0) > 0 && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-200 shrink-0" aria-hidden />
                <span className="text-text-muted">Cached:</span> {formatBytes(memory.cachedBytes)}
              </span>
            )}
            {(memory.buffersBytes ?? 0) > 0 && (
              <span><span className="text-text-muted">Buffers:</span> {formatBytes(memory.buffersBytes)}</span>
            )}
          </div>
          {memory.totalGB > 0 && (
            <div className="h-2 rounded bg-surface overflow-hidden flex">
              <div
                className="bg-accent"
                style={{ width: `${Math.min(100, memory.usagePercent ?? 0)}%` }}
              />
              {(memory.cachedBytes ?? 0) > 0 && (
                <div
                  className="bg-amber-200"
                  style={{ width: `${Math.min(100, (memory.cachedBytes / (memory.totalGB * 1024 ** 3)) * 100)}%` }}
                />
              )}
            </div>
          )}
          {(memory.swapTotalBytes ?? 0) > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5">
                <span><span className="text-text-muted">Swap total:</span> {formatBytes(memory.swapTotalBytes)}</span>
                <span><span className="text-text-muted">Swap used:</span> {formatBytes(memory.swapUsedBytes ?? 0)}</span>
              </div>
              <div className="h-2 rounded bg-surface overflow-hidden flex">
                <div
                  className="bg-accent"
                  style={{ width: `${Math.min(100, (memory.swapTotalBytes > 0 ? ((memory.swapUsedBytes ?? 0) / memory.swapTotalBytes) * 100 : 0))}%` }}
                />
              </div>
            </>
          )}
        </div>
      </SectionCard>

      {/* Storage */}
      <SectionCard title="Storage" titleIcon={<HardDrive size={14} strokeWidth={2} />}>
        {hardware?.filesystems?.length > 0 && (
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Filesystems</p>
            <div className="space-y-2">
              {hardware.filesystems.map((fs) => {
                const total = fs.totalBytes || 1;
                const used = fs.usedBytes ?? 0;
                const pct = (used / total) * 100;
                return (
                  <div key={fs.mount} className="text-sm">
                    <div className="flex justify-between mb-0.5">
                      <span className="font-mono text-text-primary">{fs.mount}</span>
                      <span className="text-text-muted">{formatBytes(used)} / {formatBytes(total)} ({formatDecimal(pct)}%)</span>
                    </div>
                    <div className="h-2 rounded bg-surface overflow-hidden">
                      <div className="h-full bg-accent rounded" style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {!hardware && !hardwareError && (
          <p className="text-sm text-text-muted">Loading storage info…</p>
        )}
        {hardware && !hardware.filesystems?.length && !hardwareError && (
          <p className="text-sm text-text-muted">No local filesystem mounts listed.</p>
        )}
      </SectionCard>

      {/* Network */}
      <SectionCard title="Network" titleIcon={<Network size={14} strokeWidth={2} />}>
        {hardwareError && <p className="text-sm text-status-stopped mb-2">{hardwareError}</p>}
        {hardware?.network?.length > 0 ? (
          <DataTableScroll>
            <DataTable minWidthRem={28}>
              <thead>
                <tr className={dataTableHeadRowClass}>
                  <DataTableTh dense>Interface</DataTableTh>
                  <DataTableTh dense>MAC</DataTableTh>
                  <DataTableTh dense>Speed</DataTableTh>
                  <DataTableTh dense>State</DataTableTh>
                </tr>
              </thead>
              <tbody>
                {hardware.network.map((nic) => (
                  <tr key={nic.name} className={dataTableBodyRowClass}>
                    <DataTableTd dense className="font-medium text-text-primary">{nic.name}</DataTableTd>
                    <DataTableTd dense className="font-mono text-text-secondary">{nic.mac || '—'}</DataTableTd>
                    <DataTableTd dense>{nic.speedMbps != null ? `${nic.speedMbps} Mbps` : '—'}</DataTableTd>
                    <DataTableTd dense className="text-text-muted">{nic.state ?? '—'}</DataTableTd>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </DataTableScroll>
        ) : hardware && !hardwareError ? (
          <p className="text-sm text-text-muted">No network interfaces listed.</p>
        ) : !hardwareError ? (
          <p className="text-sm text-text-muted">Loading network info…</p>
        ) : null}
      </SectionCard>

      {/* Software (host info) */}
      <SectionCard title="Software" titleIcon={<Package size={14} strokeWidth={2} />}>
        <HostSoftwareBlock />
      </SectionCard>

      {/* Hardware inventory (PCI + DMI) */}
      <HostHardwareInventorySection
        hardwareError={hardwareError}
        pciDevices={hardware?.pciDevices}
        system={hardware?.system}
        pciTempByAddress={buildPciTempByAddress(thermalZones)}
        motherboardAcpiZone={motherboardAcpiZone}
        memory={hardware?.memory}
        disks={disks}
        nvmeTempByDisk={nvmeTempByDisk}
      />
    </div>
  );
}

function HostHardwareInventorySection({
  hardwareError,
  pciDevices,
  system,
  pciTempByAddress,
  motherboardAcpiZone,
  memory,
  disks,
  nvmeTempByDisk,
}) {
  const memoryList = memory || [];
  const diskList = disks || [];

  const pciList = (pciDevices || [])
    .filter((d) => !isPciBridgeClass(d.classCode))
    .sort(comparePciInventoryRows);

  const pciByAddr = new Map();
  for (const p of pciList) {
    pciByAddr.set(normalizePciBdf(p.address), p);
  }

  const claimedPciKeys = new Set();
  for (const d of diskList) {
    if (!d.pciAddress) continue;
    const k = normalizePciBdf(d.pciAddress);
    if (pciByAddr.has(k)) claimedPciKeys.add(k);
  }

  const groupsMap = new Map();
  for (const d of diskList) {
    if (!d.pciAddress) continue;
    const k = normalizePciBdf(d.pciAddress);
    if (!claimedPciKeys.has(k)) continue;
    if (!groupsMap.has(k)) {
      groupsMap.set(k, { disks: [], controller: pciByAddr.get(k) });
    }
    groupsMap.get(k).disks.push(d);
  }
  for (const g of groupsMap.values()) {
    g.disks.sort((a, b) => a.name.localeCompare(b.name));
  }

  const groupKeysSorted = [...groupsMap.keys()].sort((a, b) => {
    const na = groupsMap.get(a).disks[0]?.name || '';
    const nb = groupsMap.get(b).disks[0]?.name || '';
    return na.localeCompare(nb);
  });

  const ungroupedDisks = diskList
    .filter((d) => {
      if (!d.pciAddress) return true;
      const k = normalizePciBdf(d.pciAddress);
      return !claimedPciKeys.has(k);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const standalonePci = pciList.filter((p) => !claimedPciKeys.has(normalizePciBdf(p.address)));

  const mainNetworkPci = standalonePci
    .filter((p) => p.classCode.slice(0, 2) === '02')
    .sort(comparePciInventoryRows);
  const mainStoragePci = standalonePci
    .filter((p) => p.classCode.slice(0, 2) === '01')
    .sort(comparePciInventoryRows);

  const ioPci = standalonePci
    .filter((p) => pciHardwareBucket(p.classCode) === 'io')
    .sort(comparePciInventoryRows);
  const otherPci = standalonePci
    .filter((p) => pciHardwareBucket(p.classCode) === 'other')
    .sort(comparePciInventoryRows);

  const ramSorted = [...memoryList].sort((a, b) => {
    const sa = parseInt(String(a.slot), 10);
    const sb = parseInt(String(b.slot), 10);
    if (Number.isFinite(sa) && Number.isFinite(sb)) return sa - sb;
    return String(a.slot || '').localeCompare(String(b.slot || ''));
  });

  const hasMain = ramSorted.length > 0 || mainNetworkPci.length > 0 || groupKeysSorted.length > 0
    || ungroupedDisks.length > 0 || mainStoragePci.length > 0;
  const hasIo = ioPci.length > 0;
  const hasOthers = otherPci.length > 0;

  const hasDmiSummary = system && (
    system.boardVendor || system.boardName || system.systemVendor || system.systemProduct
    || system.biosVendor || system.biosVersion || system.biosDate
  );
  const motherboardTooltip = 'ACPI thermal zone (typically platform or motherboard; not the CPU package temperature).';
  const motherboardTitle = [formatThresholdTooltip(motherboardAcpiZone), motherboardTooltip].filter(Boolean).join(' — ') || motherboardTooltip;
  const showSummaryLine = hasDmiSummary || motherboardAcpiZone != null;

  const renderPciRow = (d, { nested }) => {
    const addrKey = normalizePciBdf(d.address);
    const tempC = pciTempByAddress.get(addrKey);
    const typeCell = nested ? `└ ${d.className}` : d.className;
    return (
      <tr
        key={nested ? `pci-nested-${d.address}` : `pci-${d.address}`}
        className={`${dataTableBodyRowClass} ${nested ? 'bg-surface/30' : ''}`}
      >
        <DataTableTd
          dense
          valign="top"
          className={`whitespace-nowrap ${nested ? '!pl-9 text-text-muted' : ''}`}
        >
          {typeCell}
        </DataTableTd>
        <DataTableTd dense valign="top" className={nested ? 'text-text-muted' : 'text-text-primary'}>{d.device}</DataTableTd>
        <DataTableTd dense valign="top" className={nested ? 'text-text-muted' : 'text-text-primary'}>{d.vendor}</DataTableTd>
        <DataTableTd dense valign="top" className="font-mono text-text-secondary">{d.driver ?? '—'}</DataTableTd>
        <DataTableTd dense valign="top" className="font-mono text-text-secondary">{d.address}</DataTableTd>
        <DataTableTd dense valign="top" className="whitespace-nowrap tabular-nums text-text-muted">
          {tempC != null ? `${formatDecimal(tempC)} °C` : '—'}
        </DataTableTd>
      </tr>
    );
  };

  const renderDiskRow = (d, { nested } = {}) => {
    const smart = d.smart || null;
    const nvmeZone = nvmeTempByDisk.get(d.name);
    const tempC = smart?.temperatureC ?? nvmeZone?.tempC ?? null;
    const healthLabel = formatSmartHealthLabel(smart);
    const smartLine = [
      healthLabel,
      formatPowerOnHoursLabel(smart?.powerOnHours),
      Number.isFinite(smart?.percentageUsed) ? formatNvmeWearPercent(smart.percentageUsed) : null,
      formatNvmeSpareLine(smart),
      formatSsdLifeRemainingLine(smart?.ssdLifePercentRemaining),
      formatAtaSectorLine(smart),
    ].filter(Boolean).join(' - ');
    const warningText = smart?.criticalWarning || smart?.error || null;
    const typeLabel = nested ? `└ ${blockDeviceStorageTypeLabel(d)}` : blockDeviceStorageTypeLabel(d);
    return (
      <tr
        key={nested ? `disk-nested-${d.name}` : `disk-${d.name}`}
        className={`${dataTableBodyRowClass} ${nested ? 'bg-surface/30' : ''}`}
      >
        <DataTableTd
          dense
          valign="top"
          className={`whitespace-nowrap text-text-primary ${nested ? '!pl-9' : ''}`}
        >
          {typeLabel}
        </DataTableTd>
        <DataTableTd dense valign="top" className="text-text-primary">
          <div>{[d.model, formatBytes(d.sizeBytes)].filter(Boolean).join(' - ')}</div>
          <div className="text-xs text-text-secondary mt-0.5">{smartLine}</div>
          {warningText ? (
            <div className="text-xs text-status-paused mt-0.5">{warningText}</div>
          ) : null}
        </DataTableTd>
        <DataTableTd dense valign="top" className="text-text-primary">—</DataTableTd>
        <DataTableTd dense valign="top" className="font-mono text-text-secondary">{d.name}</DataTableTd>
        <DataTableTd dense valign="top" className="font-mono text-text-secondary">—</DataTableTd>
        <DataTableTd dense valign="top" className="whitespace-nowrap tabular-nums text-text-muted">
          {tempC != null ? (
            <span title={formatThresholdTooltip(nvmeZone) || undefined}>
              {`${formatDecimal(tempC)} °C`}
            </span>
          ) : (
            '—'
          )}
        </DataTableTd>
      </tr>
    );
  };

  return (
    <SectionCard title="Hardware" titleIcon={<CircuitBoard size={14} strokeWidth={2} />}>
      {hardwareError && <p className="text-sm text-status-stopped mb-2">{hardwareError}</p>}
      {showSummaryLine && (
        <p className="text-sm text-text-secondary mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          {hasDmiSummary && [system.boardVendor, system.boardName].filter(Boolean).length > 0 && (
            <span>
              <span className="text-text-muted">Board:</span>{' '}
              <span className="font-medium text-text-primary">{[system.boardVendor, system.boardName].filter(Boolean).join(' ')}</span>
            </span>
          )}
          {hasDmiSummary && [system.systemVendor, system.systemProduct].filter(Boolean).length > 0 && (
            <span>
              <span className="text-text-muted">System:</span>{' '}
              <span className="font-medium text-text-primary">{[system.systemVendor, system.systemProduct].filter(Boolean).join(' ')}</span>
            </span>
          )}
          {hasDmiSummary && (system.biosVendor || system.biosVersion || system.biosDate) && (
            <span>
              <span className="text-text-muted">BIOS:</span>{' '}
              <span className="font-medium text-text-primary">
                {[system.biosVendor, system.biosVersion].filter(Boolean).join(' ')}
                {system.biosDate ? ` (${system.biosDate})` : ''}
              </span>
            </span>
          )}
          {motherboardAcpiZone != null && (
            <span title={motherboardTitle}>
              <span className="text-text-muted">Motherboard:</span>{' '}
              <span className="font-medium text-text-primary tabular-nums">
                {formatDecimal(motherboardAcpiZone.tempC)} °C
              </span>
            </span>
          )}
        </p>
      )}
      {(hasMain || hasIo || hasOthers) ? (
        <DataTableScroll>
          <DataTable minWidthRem={36}>
            <HardwareInventoryTableHead />
            <tbody>
              {hasMain && (
                <>
                  <tr>
                    <td
                      className={`${dataTableCellPadX} pt-2 pb-1 text-[11px] font-medium text-text-muted uppercase tracking-wider`}
                      colSpan={6}
                    >
                      Main
                    </td>
                  </tr>
                  {ramSorted.map((m, i) => (
                    <tr key={`ram-${i}-${m.slot}`} className={dataTableBodyRowClass}>
                      <DataTableTd dense valign="top" className="whitespace-nowrap">{formatRamInventoryType(m)}</DataTableTd>
                      <DataTableTd dense valign="top" className="text-text-primary">{formatRamInventoryDevice(m)}</DataTableTd>
                      <DataTableTd dense valign="top" className="text-text-primary">{m.manufacturer || '—'}</DataTableTd>
                      <DataTableTd dense valign="top" className="font-mono text-text-secondary">—</DataTableTd>
                      <DataTableTd dense valign="top" className="font-mono text-text-secondary">—</DataTableTd>
                      <DataTableTd dense valign="top" className="whitespace-nowrap tabular-nums text-text-muted">—</DataTableTd>
                    </tr>
                  ))}
                  {mainNetworkPci.map((d) => renderPciRow(d, { nested: false }))}
                  {groupKeysSorted.map((k) => {
                    const { disks: groupDisks, controller } = groupsMap.get(k);
                    return (
                      <Fragment key={`group-${k}`}>
                        {controller && renderPciRow(controller, { nested: false })}
                        {groupDisks.map((d) => renderDiskRow(d, { nested: true }))}
                      </Fragment>
                    );
                  })}
                  {ungroupedDisks.map((d) => renderDiskRow(d))}
                  {mainStoragePci.map((d) => renderPciRow(d, { nested: false }))}
                </>
              )}
              {hasIo && (
                <>
                  <tr>
                    <td
                      className={`${dataTableCellPadX} pt-4 pb-1 text-[11px] font-medium text-text-muted uppercase tracking-wider`}
                      colSpan={6}
                    >
                      I/O
                    </td>
                  </tr>
                  {ioPci.map((d) => renderPciRow(d, { nested: false }))}
                </>
              )}
              {hasOthers && (
                <>
                  <tr>
                    <td
                      className={`${dataTableCellPadX} pt-4 pb-1 text-[11px] font-medium text-text-muted uppercase tracking-wider`}
                      colSpan={6}
                    >
                      Misc
                    </td>
                  </tr>
                  {otherPci.map((d) => renderPciRow(d, { nested: false }))}
                </>
              )}
            </tbody>
          </DataTable>
        </DataTableScroll>
      ) : (
        <p className="text-sm text-text-muted">
          {hardwareError ? 'Could not load hardware inventory.' : 'No hardware inventory listed (or still loading).'}
        </p>
      )}
    </SectionCard>
  );
}

function HostSoftwareBlock() {
  const [hostInfo, setHostInfo] = useState(null);
  useEffect(() => {
    /* Non-fatal: Software block stays empty/loading if GET /api/host fails */
    getHostInfo().then(setHostInfo).catch(() => {});
  }, []);

  if (!hostInfo) return <p className="text-sm text-text-muted">Loading…</p>;

  const osLabel = hostInfo.osRelease?.prettyName ?? (hostInfo.osRelease ? [hostInfo.osRelease.id, hostInfo.osRelease.versionId].filter(Boolean).join(' ') : null);
  const label = (name) => <span className="text-text-muted text-[11px] font-medium uppercase">{name}</span>;

  return (
    <div className="text-sm space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
        <span>{label('Host')} <span className="font-mono">{hostInfo.hostname ?? '—'}</span></span>
        <span>{osLabel != null ? <>{label('OS')} {osLabel}</> : <>{label('OS')} —</>}</span>
        <span>{label('Kernel')} <span className="font-mono">{hostInfo.kernel ?? '—'}</span></span>
        <span>{label('IP')} <span className="font-mono">{hostInfo.primaryAddress ?? '—'}</span></span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
        <span>{label('Wisp')} <span className="font-mono">{hostInfo.wispVersion ?? '—'}</span></span>
        <span>{label('Node')} <span className="font-mono">{hostInfo.nodeVersion ?? '—'}</span></span>
        <span>{label('libvirt')} <span className="font-mono">{hostInfo.libvirtVersion ?? '—'}</span></span>
        <span>{label('QEMU')} <span className="font-mono">{hostInfo.qemuVersion ?? '—'}</span></span>
      </div>
    </div>
  );
}

