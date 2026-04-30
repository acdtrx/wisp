import { useState, useEffect, useCallback } from 'react';
import { Cpu, Check, X, Loader2, AlertTriangle } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import { getHostGpus } from '../../api/host.js';

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

function vendorLabel(gpu) {
  const parts = [gpu.vendorName || gpu.vendor];
  if (gpu.model) parts.push(gpu.model);
  return parts.filter(Boolean).join(' — ');
}

function gpuSecondary(gpu) {
  return [gpu.device, gpu.pciSlot].filter(Boolean).join(' · ');
}

export default function ContainerDevicesSection({ config, onSave }) {
  const devices = Array.isArray(config?.devices) ? config.devices : [];
  const currentGpu = devices.find((d) => d?.type === 'gpu') || null;

  const [hostGpus, setHostGpus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [picking, setPicking] = useState(false);
  const [pickValue, setPickValue] = useState('');

  const loadGpus = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await getHostGpus();
      setHostGpus(Array.isArray(res?.gpus) ? res.gpus : []);
    } catch (err) {
      setLoadError(err?.message || 'Failed to query host GPUs');
      setHostGpus([]);
    }
  }, []);

  useEffect(() => { loadGpus(); }, [loadGpus]);

  const matchedHostGpu = currentGpu && Array.isArray(hostGpus)
    ? hostGpus.find((g) => g.device === currentGpu.device) || null
    : null;
  const hostGpuMissing = !!currentGpu && Array.isArray(hostGpus) && !matchedHostGpu;

  const handleAdd = async () => {
    if (!pickValue) return;
    setError(null);
    setSaving(true);
    try {
      await onSave({ devices: [{ type: 'gpu', device: pickValue }] });
      setPicking(false);
      setPickValue('');
    } catch (err) {
      setError(err?.detail || err?.message || 'Failed to add device');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setError(null);
    setSaving(true);
    try {
      await onSave({ devices: [] });
    } catch (err) {
      setError(err?.detail || err?.message || 'Failed to remove device');
    } finally {
      setSaving(false);
    }
  };

  const startPick = () => {
    setError(null);
    setPicking(true);
    setPickValue(hostGpus?.[0]?.device || '');
  };
  const cancelPick = () => {
    setPicking(false);
    setPickValue('');
    setError(null);
  };

  const addDisabled = !Array.isArray(hostGpus) || hostGpus.length === 0 || saving;
  const addTitle = hostGpus && hostGpus.length === 0
    ? 'No supported GPUs detected on the host (Intel/AMD only in v1)'
    : 'Add GPU passthrough';

  const headerAction = !currentGpu && !picking ? (
    <button
      type="button"
      onClick={startPick}
      disabled={addDisabled}
      title={addTitle}
      aria-label={addTitle}
      className={iconBtn}
    >
      <Cpu size={14} aria-hidden />
    </button>
  ) : null;

  return (
    <SectionCard
      title="Devices"
      titleIcon={<Cpu size={12} />}
      helpText="Share a host GPU (Intel/AMD render node) with the container for hardware acceleration like media transcoding. Restart the container to apply changes."
      requiresRestart={!!config.pendingRestart}
      error={error || loadError}
      headerAction={headerAction}
    >
      {!currentGpu && !picking && (
        <div className="rounded-md border border-dashed border-surface-border px-3 py-3 text-xs text-text-muted">
          {Array.isArray(hostGpus) && hostGpus.length === 0
            ? 'No supported GPUs detected on the host. Intel and AMD render nodes (/dev/dri/renderD*) are supported in v1.'
            : 'No devices configured.'}
        </div>
      )}

      {picking && (
        <div className="flex items-center gap-2 rounded-md border border-surface-border bg-surface-card px-3 py-2">
          <select
            id="device-gpu-picker"
            aria-label="GPU"
            value={pickValue}
            onChange={(e) => setPickValue(e.target.value)}
            disabled={saving || !hostGpus?.length}
            className="flex-1 min-w-0 rounded-md border border-surface-border bg-white px-2 py-1.5 text-xs"
          >
            {hostGpus?.map((g) => (
              <option key={g.device} value={g.device}>
                {vendorLabel(g)}{gpuSecondary(g) ? ` · ${gpuSecondary(g)}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleAdd}
            disabled={saving || !pickValue}
            title="Confirm"
            aria-label="Confirm"
            className={iconBtn}
          >
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />}
          </button>
          <button
            type="button"
            onClick={cancelPick}
            disabled={saving}
            title="Cancel"
            aria-label="Cancel"
            className={iconBtn}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      )}

      {currentGpu && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-surface-border bg-white px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-text">
              <Cpu size={12} className="text-text-muted" />
              {matchedHostGpu ? vendorLabel(matchedHostGpu) : 'GPU'}
              {hostGpuMissing && (
                <span className="flex items-center gap-1 text-[10px] text-status-warning">
                  <AlertTriangle size={11} />
                  device not present on host
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-text-muted">
              {matchedHostGpu ? gpuSecondary(matchedHostGpu) : currentGpu.device}
            </div>
          </div>
          <button
            type="button"
            onClick={handleRemove}
            disabled={saving}
            title="Remove GPU passthrough"
            aria-label="Remove GPU passthrough"
            className="rounded-md p-1 text-text-muted hover:bg-surface-card hover:text-status-stopped disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
          </button>
        </div>
      )}
    </SectionCard>
  );
}
