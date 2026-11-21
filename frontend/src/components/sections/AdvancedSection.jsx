import { useState } from 'react';
import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import RadioPills from '../shared/RadioPills.jsx';

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

/**
 * The Create VM panel's firmware, machine, CPU model, devices and boot order: the
 * panel's draft (`draft`, written through `onDraft(update)`) is the only state.
 */
export default function AdvancedSection({ vmConfig, draft, onDraft }) {
  const [collapsed, setCollapsed] = useState(true);
  const form = draft;

  /* A field's write as a functional update of the value it replaces. */
  const updateWith = (key, update) => onDraft((d) => ({ ...d, [key]: update(d[key]) }));
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

  return (
    <SectionCard
      title="Advanced"
      collapsible
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed(!collapsed)}
    >
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4 min-w-0 content-start">
            <FieldRow label="Machine Type">
              <RadioPills
                options={MACHINE_OPTIONS}
                value={form.machineType}
                onChange={(v) => updateField('machineType', v)}
              />
            </FieldRow>
            <FieldRow label="CPU Model">
              <RadioPills
                options={CPU_MODELS}
                value={form.cpuMode}
                onChange={(v) => updateField('cpuMode', v)}
              />
            </FieldRow>
            <FieldRow label="Firmware">
              <RadioPills
                options={FIRMWARE_OPTIONS}
                value={form.firmware}
                onChange={(v) => updateField('firmware', v)}
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
              <FieldRow label="Nested V">
                <Toggle checked={form.nestedVirt} onChange={(v) => updateField('nestedVirt', v)} />
              </FieldRow>
              <FieldRow label="Guest Agent">
                <Toggle checked={form.guestAgent} onChange={(v) => updateField('guestAgent', v)} />
              </FieldRow>
              <FieldRow label="Mem Balloon">
                <Toggle checked={form.memBalloon} onChange={(v) => updateField('memBalloon', v)} />
              </FieldRow>
              <FieldRow label="vTPM">
                <Toggle checked={form.vtpm} onChange={(v) => updateField('vtpm', v)} />
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

function FieldRow({ label, className = '', children }) {
  return (
    <div className={className}>
      <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}
