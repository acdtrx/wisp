import { useState } from 'react';
import { Lock } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import RadioPills from '../shared/RadioPills.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { useForm } from '../../hooks/useForm.js';
import { changedFields } from '../../hooks/formState.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import { vmLocked } from '../../utils/workloadLocks.js';

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

/** The fields locked unless the VM is shut off (workloadLocks.js). */
const OFFLINE_ONLY = ['machineType', 'cpuMode', 'firmware', 'nestedVirt', 'vtpm'];

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
    bootMenu: vmConfig.bootMenu || false,
    memBalloon: vmConfig.memBalloon ?? true,
    guestAgent: vmConfig.guestAgent ?? true,
    vtpm: vmConfig.vtpm || false,
    virtioRng: vmConfig.virtioRng ?? true,
    nestedVirt: vmConfig.nestedVirt || false,
  };
}

/**
 * The VM's firmware, machine, CPU model, devices and boot order. Editing a VM, the
 * form follows its config record; creating, the panel's draft (`draft`, written
 * through `onDraft(update)`) is the only state.
 */
export default function AdvancedSection({ vmConfig, isCreating, draft, onDraft, onSave, busyReason }) {
  const offlineOnly = !isCreating && vmLocked(vmConfig.state);

  const [collapsed, setCollapsed] = useState(true);

  const record = useRecord(isCreating ? null : RECORD.VM, vmConfig.name);
  /* A locked field shows its stored value, and is neither sent nor a change. */
  const edit = useForm(record, advancedFormFromVmConfig, undefined, { locked: offlineOnly ? OFFLINE_ONLY : [] });
  const form = isCreating ? draft : edit.form;
  const save = useCommand();

  /* A field's write as a functional update of the value it replaces. */
  const updateWith = (key, update) => (isCreating
    ? onDraft((d) => ({ ...d, [key]: update(d[key]) }))
    : edit.setForm((f) => ({ ...f, [key]: update(f[key]) })));
  const updateField = (key, value) => updateWith(key, () => value);

  const hasHyperv = vmConfig.features?.hyperv;

  const toggleBootDev = (dev) => updateWith('bootOrder', (current) => {
    const order = [...current];
    const idx = order.indexOf(dev);
    if (idx >= 0) {
      if (order.length <= 1) return current;
      order.splice(idx, 1);
    } else {
      order.push(dev);
    }
    return order;
  });

  const handleSave = () => edit.save((values, saved) => save.run(() => onSave(changedFields(values, saved))));

  return (
    <SectionCard
      title="Advanced"
      isDirty={isCreating ? false : edit.dirty}
      onSave={isCreating ? undefined : handleSave}
      saveDisabledReason={isCreating ? undefined : busyReason}
      saving={edit.saving}
      requiresRestart={!!vmConfig.pendingRestart}
      collapsible
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed(!collapsed)}
      commands={[save]}
    >
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4 min-w-0 content-start">
            <FieldRow label="Machine Type" offlineOnly={offlineOnly}>
              <RadioPills
                options={MACHINE_OPTIONS}
                value={form.machineType}
                onChange={(v) => updateField('machineType', v)}
                disabled={offlineOnly}
              />
            </FieldRow>
            <FieldRow label="CPU Model" offlineOnly={offlineOnly}>
              <RadioPills
                options={CPU_MODELS}
                value={form.cpuMode}
                onChange={(v) => updateField('cpuMode', v)}
                disabled={offlineOnly}
              />
            </FieldRow>
            <FieldRow label="Firmware" offlineOnly={offlineOnly}>
              <RadioPills
                options={FIRMWARE_OPTIONS}
                value={form.firmware}
                onChange={(v) => updateField('firmware', v)}
                disabled={offlineOnly}
              />
            </FieldRow>
            <FieldRow label="Video Driver">
              <RadioPills
                options={VIDEO_DRIVERS}
                value={form.videoDriver}
                onChange={(v) => updateField('videoDriver', v)}
              />
            </FieldRow>
            <FieldRow label="Graphics">
              <RadioPills
                options={GRAPHICS_OPTIONS}
                value={form.graphicsType}
                onChange={(v) => updateField('graphicsType', v)}
              />
            </FieldRow>
          </div>

          <div className="space-y-4 min-w-0">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
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
                            ? 'border-accent bg-accent-soft text-accent-text'
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
            </div>
          </div>
        </div>

        {hasHyperv && (
          <FieldRow label="Windows Optimisations">
            <span className="inline-flex items-center rounded-full bg-status-running-soft px-2.5 py-0.5 text-[11px] font-medium text-status-running">
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
