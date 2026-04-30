import { useState, useEffect, useCallback } from 'react';
import { Cpu, MemoryStick, RefreshCw, Images } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import HelpIcon from '../shared/HelpIcon.jsx';
import ImageLibraryModal from '../shared/ImageLibraryModal.jsx';

/** Same control pattern as AdvancedSection (machine type, CPU model). */
const RESTART_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: 'on-failure', label: 'On failure' },
  { value: 'unless-stopped', label: 'Unless stopped' },
  { value: 'always', label: 'Always' },
];

function RestartPolicySegmentedControl({ value, onChange }) {
  return (
    <div className="flex h-[2.25rem] max-w-full overflow-x-auto rounded-lg border border-surface-border bg-surface p-0.5">
      {RESTART_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-colors duration-150 ${
            value === opt.value
              ? 'bg-surface-card text-text-primary shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function buildGeneralFormDefaults(config) {
  return {
    name: config.name || '',
    image: config.image || '',
    command: config.command ? config.command.join(' ') : '',
    cpuLimit: config.cpuLimit ?? '',
    memoryLimitMiB: config.memoryLimitMiB ?? '',
    restartPolicy: config.restartPolicy || 'unless-stopped',
    autostart: config.autostart ?? false,
    runAsRoot: config.runAsRoot ?? false,
  };
}

export default function ContainerGeneralSection({ config, isCreating, onSave, onFormChange, headerAction }) {
  const [form, setForm] = useState(() => buildGeneralFormDefaults(config));
  const [original, setOriginal] = useState(() => buildGeneralFormDefaults(config));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const init = useCallback(() => {
    const d = buildGeneralFormDefaults(config);
    setForm(d);
    setOriginal(d);
    setRequiresRestart(false);
    setError(null);
    /* command joined to a stable string so re-renders with same-contents arrays don't trigger re-init */
  }, [
    config?.name,
    config?.image,
    Array.isArray(config?.command) ? config.command.join(' ') : '',
    config?.cpuLimit,
    config?.memoryLimitMiB,
    config?.restartPolicy,
    config?.autostart,
    config?.runAsRoot,
  ]);

  useEffect(() => {
    if (!isCreating) init();
  }, [init, isCreating]);

  // In create mode, sync image from parent when it changes externally (e.g. app selector prefill)
  useEffect(() => {
    if (isCreating && config?.image !== undefined && config.image !== form.image) {
      setForm((prev) => ({ ...prev, image: config.image }));
    }
  }, [isCreating, config?.image]);

  const isDirty = JSON.stringify(form) !== JSON.stringify(original);

  const updateField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (isCreating && onFormChange) onFormChange({ [key]: value });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const changes = {};
      if (form.image !== original.image) changes.image = form.image;
      if (form.command !== original.command) {
        changes.command = form.command.trim() ? form.command.trim().split(/\s+/) : null;
      }
      if (String(form.cpuLimit) !== String(original.cpuLimit)) {
        changes.cpuLimit = form.cpuLimit ? parseFloat(form.cpuLimit) : null;
      }
      if (String(form.memoryLimitMiB) !== String(original.memoryLimitMiB)) {
        changes.memoryLimitMiB = form.memoryLimitMiB ? parseInt(form.memoryLimitMiB, 10) : null;
      }
      if (form.restartPolicy !== original.restartPolicy) changes.restartPolicy = form.restartPolicy;
      if (form.autostart !== original.autostart) changes.autostart = form.autostart;
      if (form.runAsRoot !== original.runAsRoot) changes.runAsRoot = form.runAsRoot;

      const result = await onSave(changes);
      if (result?.requiresRestart) setRequiresRestart(true);
      /* Snap form + original to the values we actually sent. Without this, cosmetic-only
       * diffs (trailing whitespace in command, "2" vs "2.0" in cpuLimit, etc.) keep
       * isDirty=true when the server stores the normalized value and the parent's
       * config prop doesn't change (so the init useEffect doesn't re-fire). */
      const canonical = { ...form };
      if ('command' in changes) {
        canonical.command = Array.isArray(changes.command) ? changes.command.join(' ') : '';
      }
      setForm(canonical);
      setOriginal(canonical);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard title="General" isDirty={!isCreating && isDirty} onSave={isCreating ? undefined : handleSave} saving={saving} requiresRestart={requiresRestart} error={error} headerAction={headerAction}>
      <div className="space-y-3">
        <div className="flex items-end gap-4 flex-wrap">
          <Field label="Name" className="w-[180px]">
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              disabled={!isCreating}
              className="input-field"
            />
          </Field>
          <Field label="Image" className="flex-1 min-w-[200px]">
            <div className="flex items-stretch gap-2">
              <input
                type="text"
                value={form.image}
                onChange={(e) => updateField('image', e.target.value)}
                placeholder="e.g. nginx:latest"
                className="input-field flex-1"
              />
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center justify-center rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary hover:bg-surface-sidebar hover:text-text-primary transition-colors duration-150"
                title="Browse image library"
                aria-label="Browse image library"
              >
                <Images size={14} aria-hidden />
              </button>
            </div>
          </Field>
        </div>

        <ImageLibraryModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={(selection) => {
            if (selection?.kind === 'oci' && selection.name) {
              updateField('image', selection.name);
            }
          }}
          pickerKind="container"
          defaultFilter="container"
        />

        {!isCreating && (
        <>
        <Field
          label="Command Override"
          helpText="Space-separated argv — no shell parsing. For shell syntax, prefix with sh -c."
          className="w-full"
        >
          <input
            type="text"
            value={form.command}
            onChange={(e) => updateField('command', e.target.value)}
            placeholder="Leave empty for image default"
            className="input-field"
          />
        </Field>

        <div className="flex items-end gap-4 flex-wrap">
          <Field label="CPU Cores" icon={Cpu} className="w-24">
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={form.cpuLimit}
              onChange={(e) => updateField('cpuLimit', e.target.value)}
              placeholder="∞"
              className="input-field input-field-no-spinner w-full text-right text-sm"
            />
          </Field>

          <Field label="Memory (MiB)" icon={MemoryStick} className="w-32">
            <input
              type="number"
              min={32}
              step={64}
              value={form.memoryLimitMiB}
              onChange={(e) => updateField('memoryLimitMiB', e.target.value)}
              placeholder="∞"
              className="input-field input-field-no-spinner w-full text-right text-sm"
            />
          </Field>

          <div className="mx-0.5 h-6 w-px bg-surface-border" />

          <Field label="Restart Policy" icon={RefreshCw}>
            <RestartPolicySegmentedControl
              value={form.restartPolicy}
              onChange={(v) => updateField('restartPolicy', v)}
            />
          </Field>

          <Field label="Auto Start">
            <div className="flex h-[2.25rem] items-center">
              <Toggle checked={form.autostart} onChange={(v) => updateField('autostart', v)} />
            </div>
          </Field>

          <Field label="Run as Root">
            <div className="flex h-[2.25rem] items-center">
              <Toggle checked={form.runAsRoot} onChange={(v) => updateField('runAsRoot', v)} />
            </div>
          </Field>
        </div>
        </>
        )}
      </div>
    </SectionCard>
  );
}


function Field({ label, icon: Icon, helpText, className, children }) {
  return (
    <div className={className}>
      <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5">
        {Icon && <Icon size={12} />}
        {label}
        {helpText && <HelpIcon text={helpText} size={12} />}
      </label>
      {children}
    </div>
  );
}
