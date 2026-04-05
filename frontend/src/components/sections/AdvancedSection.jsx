import { useState, useEffect, useCallback } from 'react';
import { Lock } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';

const FIRMWARE_OPTIONS = [
  { value: 'bios', label: 'BIOS' },
  { value: 'uefi', label: 'UEFI' },
  { value: 'uefi-secure', label: 'UEFI + SecureBoot' },
];

const MACHINE_OPTIONS = [
  { value: 'q35', label: 'Q35' },
  { value: 'pc-i440fx', label: 'i440fx' },
];

const CPU_MODELS = [
  { value: 'host-passthrough', label: 'host-passthrough' },
  { value: 'host-model', label: 'host-model' },
  { value: 'qemu64', label: 'qemu64' },
];

const VIDEO_DRIVERS = [
  { value: 'virtio', label: 'VirtIO' },
  { value: 'qxl', label: 'QXL' },
  { value: 'vga', label: 'VGA' },
];

const GRAPHICS_OPTIONS = [
  { value: 'vnc', label: 'VNC' },
  { value: 'spice', label: 'SPICE' },
];

const BOOT_DEVICES = [
  { value: 'hd', label: 'HDD' },
  { value: 'cdrom', label: 'CDROM' },
  { value: 'network', label: 'Network' },
];

function advancedFormFromVmConfig(vmConfig) {
  const machineRaw = vmConfig.machineType || '';
  const machineValue = machineRaw.includes('q35') ? 'q35' : machineRaw.includes('440') ? 'pc-i440fx' : machineRaw || 'q35';
  return {
    firmware: vmConfig.firmware || 'bios',
    machineType: machineValue,
    cpuMode: vmConfig.cpuMode || 'host-passthrough',
    videoDriver: vmConfig.videoModel || 'virtio',
    graphicsType: vmConfig.graphics?.type || 'vnc',
    bootOrder: vmConfig.bootOrder?.length ? [...vmConfig.bootOrder] : ['hd'],
    autostart: vmConfig.autostart || false,
    bootMenu: vmConfig.bootMenu || false,
    memBalloon: vmConfig.memBalloon ?? true,
    guestAgent: vmConfig.guestAgent ?? true,
    vtpm: vmConfig.vtpm || false,
    virtioRng: vmConfig.virtioRng ?? true,
    nestedVirt: vmConfig.nestedVirt || false,
    localDns: vmConfig.localDns === true,
  };
}

function SegmentedControl({ options, value, onChange, disabled }) {
  return (
    <div className="flex rounded-lg border border-surface-border bg-surface p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => !disabled && onChange(opt.value)}
          disabled={disabled}
          className={`flex-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
            value === opt.value
              ? 'bg-surface-card text-text-primary shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export default function AdvancedSection({ vmConfig, isCreating, onSave, onFormChange }) {
  const isRunning = vmConfig.state === 'running' || vmConfig.state === 'blocked';
  const offlineOnly = isRunning && !isCreating;

  const [collapsed, setCollapsed] = useState(true);

  const defaults = {
    firmware: 'bios', machineType: 'q35', cpuMode: 'host-passthrough',
    videoDriver: 'virtio', graphicsType: 'vnc', bootOrder: ['hd'],
    autostart: false, bootMenu: false, memBalloon: true, guestAgent: true,
    vtpm: false, virtioRng: true, nestedVirt: false, localDns: false,
  };
  const [form, setForm] = useState(defaults);
  const [original, setOriginal] = useState(defaults);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);

  const init = useCallback(() => {
    const data = advancedFormFromVmConfig(vmConfig);
    setForm(data);
    setOriginal(data);
    setError(null);
    setRequiresRestart(false);
  }, [
    vmConfig?.firmware, vmConfig?.machineType, vmConfig?.cpuMode, vmConfig?.videoModel,
    vmConfig?.graphics?.type, JSON.stringify(vmConfig?.bootOrder), vmConfig?.autostart, vmConfig?.bootMenu, vmConfig?.memBalloon,
    vmConfig?.guestAgent, vmConfig?.vtpm, vmConfig?.virtioRng, vmConfig?.nestedVirt, vmConfig?.localDns,
  ]);

  useEffect(() => {
    if (isCreating) return;
    init();
  }, [init, isCreating]);

  useEffect(() => {
    if (!isCreating) return;
    const data = advancedFormFromVmConfig(vmConfig);
    setForm((prev) => (JSON.stringify(prev) === JSON.stringify(data) ? prev : data));
  }, [
    isCreating,
    vmConfig?.firmware, vmConfig?.machineType, vmConfig?.cpuMode, vmConfig?.videoModel,
    vmConfig?.graphics?.type, JSON.stringify(vmConfig?.bootOrder), vmConfig?.autostart, vmConfig?.bootMenu, vmConfig?.memBalloon,
    vmConfig?.guestAgent, vmConfig?.vtpm, vmConfig?.virtioRng, vmConfig?.nestedVirt, vmConfig?.localDns,
  ]);

  const isDirty = JSON.stringify(form) !== JSON.stringify(original);
  const updateField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (isCreating && onFormChange) onFormChange({ [key]: value });
  };

  const hasHyperv = vmConfig.features?.hyperv;

  const toggleBootDev = (dev) => {
    setForm((prev) => {
      const order = [...prev.bootOrder];
      const idx = order.indexOf(dev);
      if (idx >= 0) {
        if (order.length <= 1) return prev;
        order.splice(idx, 1);
      } else {
        order.push(dev);
      }
      const next = { ...prev, bootOrder: order };
      if (isCreating && onFormChange) onFormChange({ bootOrder: order });
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const changes = {};
      for (const key of Object.keys(form)) {
        if (JSON.stringify(form[key]) !== JSON.stringify(original[key])) {
          changes[key] = form[key];
        }
      }
      const result = await onSave(changes);
      if (result?.requiresRestart) setRequiresRestart(true);
      if (Object.keys(changes).length > 0) setOriginal(form);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Advanced"
      isDirty={isCreating ? false : isDirty}
      onSave={isCreating ? undefined : handleSave}
      saving={saving}
      requiresRestart={requiresRestart}
      collapsible
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed(!collapsed)}
      error={error}
    >
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <div className="space-y-4 min-w-0">
            <FieldRow label="Machine Type" offlineOnly={offlineOnly}>
              <SegmentedControl
                options={MACHINE_OPTIONS}
                value={form.machineType}
                onChange={(v) => updateField('machineType', v)}
                disabled={offlineOnly}
              />
            </FieldRow>
            <FieldRow label="CPU Model" offlineOnly={offlineOnly}>
              <SegmentedControl
                options={CPU_MODELS}
                value={form.cpuMode}
                onChange={(v) => updateField('cpuMode', v)}
                disabled={offlineOnly}
              />
            </FieldRow>
            <FieldRow label="Firmware" offlineOnly={offlineOnly}>
              <SegmentedControl
                options={FIRMWARE_OPTIONS}
                value={form.firmware}
                onChange={(v) => updateField('firmware', v)}
                disabled={offlineOnly}
              />
            </FieldRow>
            <FieldRow label="Video Driver">
              <SegmentedControl
                options={VIDEO_DRIVERS}
                value={form.videoDriver}
                onChange={(v) => updateField('videoDriver', v)}
              />
            </FieldRow>
            <FieldRow label="Graphics">
              <SegmentedControl
                options={GRAPHICS_OPTIONS}
                value={form.graphicsType}
                onChange={(v) => updateField('graphicsType', v)}
              />
            </FieldRow>
          </div>

          <div className="space-y-4 min-w-0">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
              <FieldRow label="Auto Start">
                <Toggle checked={form.autostart} onChange={(v) => updateField('autostart', v)} />
              </FieldRow>
              <FieldRow label="Boot Menu">
                <Toggle checked={form.bootMenu} onChange={(v) => updateField('bootMenu', v)} />
              </FieldRow>
              <FieldRow label="Boot Order">
                <div className="flex flex-wrap gap-1.5">
                  {BOOT_DEVICES.map((dev) => {
                    const active = form.bootOrder.includes(dev.value);
                    const idx = form.bootOrder.indexOf(dev.value);
                    return (
                      <button
                        key={dev.value}
                        type="button"
                        onClick={() => toggleBootDev(dev.value)}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors duration-150 ${
                          active
                            ? 'border-accent bg-blue-50 text-accent'
                            : 'border-surface-border text-text-muted hover:text-text-secondary'
                        }`}
                      >
                        {active && <span className="mr-1 text-[10px]">{idx + 1}.</span>}
                        {dev.label}
                      </button>
                    );
                  })}
                </div>
              </FieldRow>
            </div>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
              <FieldRow label="Nested V" offlineOnly={offlineOnly}>
                <Toggle checked={form.nestedVirt} onChange={(v) => updateField('nestedVirt', v)} disabled={offlineOnly} />
              </FieldRow>
              <FieldRow label="Guest Agent">
                <Toggle checked={form.guestAgent} onChange={(v) => updateField('guestAgent', v)} />
              </FieldRow>
              <FieldRow label="Mem Balloon">
                <Toggle checked={form.memBalloon} onChange={(v) => updateField('memBalloon', v)} />
              </FieldRow>
              <FieldRow label="vTPM" offlineOnly={offlineOnly}>
                <Toggle checked={form.vtpm} onChange={(v) => updateField('vtpm', v)} disabled={offlineOnly} />
              </FieldRow>
              <FieldRow label="VirtIO RNG">
                <Toggle checked={form.virtioRng} onChange={(v) => updateField('virtioRng', v)} />
              </FieldRow>
              <FieldRow label="Local DNS">
                <Toggle checked={form.localDns} onChange={(v) => updateField('localDns', v)} />
              </FieldRow>
            </div>
          </div>
        </div>

        {hasHyperv && (
          <FieldRow label="Windows Optimisations">
            <span className="inline-flex items-center rounded-full bg-green-50 px-2.5 py-0.5 text-[11px] font-medium text-status-running">
              Applied
            </span>
          </FieldRow>
        )}
      </div>
    </SectionCard>
  );
}

function FieldRow({ label, offlineOnly, className = '', children }) {
  return (
    <div className={className}>
      <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5">
        {label}
        {offlineOnly && <Lock size={10} className="text-text-muted" />}
      </label>
      {children}
    </div>
  );
}
