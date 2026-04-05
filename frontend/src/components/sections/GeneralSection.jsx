import { useState, useEffect, useCallback } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import { LinuxIcon, WindowsIcon } from '../shared/vmIcons.jsx';

const OS_ICONS = { Linux: LinuxIcon, Windows: WindowsIcon };

const OS_TYPES = [
  { value: 'Linux', label: 'Linux' },
  { value: 'Windows', label: 'Windows' },
];

function detectOSType(config) {
  if (config.osCategory === 'windows') return 'Windows';
  return 'Linux';
}

export default function GeneralSection({ vmConfig, isCreating, onSave, onFormChange }) {
  const isRunning = vmConfig.state === 'running' || vmConfig.state === 'blocked';

  const defaults = {
    name: vmConfig.name || '', osType: detectOSType(vmConfig),
    vcpus: vmConfig.vcpus || 1, memoryMiB: vmConfig.memoryMiB || 1024,
    memoryUnit: (vmConfig.memoryMiB || 1024) >= 1024 ? 'GB' : 'MB',
  };
  const [form, setForm] = useState(defaults);
  const [original, setOriginal] = useState(defaults);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);

  const init = useCallback(() => {
    const data = {
      name: vmConfig.name || '',
      osType: detectOSType(vmConfig),
      vcpus: vmConfig.vcpus || 1,
      memoryMiB: vmConfig.memoryMiB || 1024,
      memoryUnit: (vmConfig.memoryMiB || 1024) >= 1024 ? 'GB' : 'MB',
    };
    setForm(data);
    setOriginal(data);
    setRequiresRestart(false);
    setError(null);
  }, [vmConfig?.name, vmConfig?.vcpus, vmConfig?.memoryMiB, vmConfig?.osCategory]);

  // Overview: full reset when VM / server data changes. Create: avoid re-init on every
  // keystroke or CPU/RAM edit — that reset form+original and made Save flicker.
  useEffect(() => {
    if (isCreating) return;
    init();
  }, [init, isCreating]);

  // Create flow: only pull OS preset fields from parent (e.g. Linux ↔ Windows CPU/RAM).
  useEffect(() => {
    if (!isCreating) return;
    const nextOs = detectOSType(vmConfig);
    const vcpus = vmConfig.vcpus || 1;
    const memoryMiB = vmConfig.memoryMiB || 1024;
    setForm((prev) => {
      if (prev.osType === nextOs && prev.vcpus === vcpus && prev.memoryMiB === memoryMiB) return prev;
      return {
        ...prev,
        osType: nextOs,
        vcpus,
        memoryMiB,
        memoryUnit: memoryMiB >= 1024 ? 'GB' : 'MB',
      };
    });
  }, [isCreating, vmConfig?.vcpus, vmConfig?.memoryMiB, vmConfig?.osCategory]);

  const isDirty = JSON.stringify(form) !== JSON.stringify(original);

  const updateField = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
    if (isCreating && onFormChange) onFormChange({ [key]: value });
  };

  const memoryDisplay = form.memoryUnit === 'GB'
    ? Math.round(form.memoryMiB / 1024 * 10) / 10
    : form.memoryMiB;

  const setMemoryDisplay = (val) => {
    const n = parseFloat(val) || 0;
    const memoryMiB = form.memoryUnit === 'GB' ? Math.round(n * 1024) : Math.round(n);
    updateField('memoryMiB', memoryMiB);
  };

  const toggleUnit = () => {
    const nextUnit = form.memoryUnit === 'GB' ? 'MB' : 'GB';
    setForm(prev => ({ ...prev, memoryUnit: nextUnit }));
    if (isCreating && onFormChange) onFormChange({ memoryUnit: nextUnit });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const changes = {};
      if (form.name !== original.name) changes.name = form.name;
      if (form.osType !== original.osType) changes.osType = form.osType;
      if (form.vcpus !== original.vcpus) changes.vcpus = form.vcpus;
      if (form.memoryMiB !== original.memoryMiB) changes.memoryMiB = form.memoryMiB;

      const result = await onSave(changes);
      if (result?.requiresRestart) setRequiresRestart(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="General"
      isDirty={isCreating ? false : isDirty}
      onSave={isCreating ? undefined : handleSave}
      saving={saving}
      requiresRestart={requiresRestart}
      error={error}
    >
      <div className="space-y-0">
        <div className="flex items-end gap-4 flex-wrap">
          <Field label="Name" className="w-[180px]">
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              disabled={isRunning && !isCreating}
              title={isRunning && !isCreating ? 'Stop the VM to rename it' : undefined}
              className="input-field"
            />
          </Field>

          <div className="mx-0.5 h-6 w-px bg-surface-border" />

          <Field label="CPU" icon={Cpu} className="w-16">
            <input
              type="number"
              min={1}
              max={128}
              value={form.vcpus}
              onChange={(e) => updateField('vcpus', parseInt(e.target.value, 10) || 1)}
              disabled={isRunning && !isCreating}
              className="input-field input-field-no-spinner w-full text-right text-sm"
            />
          </Field>

          <Field label="RAM" icon={MemoryStick} className="w-32">
            <div className="flex gap-0.5">
              <input
                type="number"
                min={form.memoryUnit === 'GB' ? 0.5 : 128}
                step={form.memoryUnit === 'GB' ? 0.5 : 128}
                value={memoryDisplay}
                onChange={(e) => setMemoryDisplay(e.target.value)}
                disabled={isRunning && !isCreating}
                className="input-field input-field-no-spinner flex-1 text-right text-sm min-w-0"
              />
              <button
                onClick={toggleUnit}
                className="rounded-md border border-surface-border px-1.5 py-1 text-[10px] font-medium text-text-secondary hover:bg-surface transition-colors duration-150 shrink-0"
              >
                {form.memoryUnit}
              </button>
            </div>
          </Field>

          <div className="mx-0.5 h-6 w-px bg-surface-border" />

          <Field label="OS Type" className="flex-1 min-w-0">
            <SegmentedControl
              options={OS_TYPES}
              value={form.osType}
              onChange={(v) => updateField('osType', v)}
              icons={OS_ICONS}
            />
          </Field>
        </div>
      </div>
    </SectionCard>
  );
}

function SegmentedControl({ options, value, onChange, disabled, icons }) {
  return (
    <div className="flex rounded-lg border border-surface-border bg-surface p-0.5">
      {options.map(opt => {
        const Icon = icons?.[opt.value];
        return (
          <button
            key={opt.value}
            onClick={() => !disabled && onChange(opt.value)}
            disabled={disabled}
            className={`flex items-center justify-center gap-1.5 flex-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
              value === opt.value
                ? 'bg-surface-card text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            {Icon && <Icon size={11} />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, icon: Icon, className, children }) {
  return (
    <div className={className}>
      <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5">
        {Icon && <Icon size={12} />}
        {label}
      </label>
      {children}
    </div>
  );
}
