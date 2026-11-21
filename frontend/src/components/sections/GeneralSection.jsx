import { useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import RadioPills from '../shared/RadioPills.jsx';
import { LinuxIcon, WindowsIcon } from '../shared/vmIcons.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { useForm } from '../../hooks/useForm.js';
import { changedFields } from '../../hooks/formState.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import { vmLocked } from '../../utils/workloadLocks.js';
import { generalProblems } from '../vm/vmDraft.js';

const OS_ICONS = { Linux: LinuxIcon, Windows: WindowsIcon };

const OS_TYPES = [
  { value: 'Linux', label: 'Linux' },
  { value: 'Windows', label: 'Windows' },
];

function detectOSType(config) {
  if (config.osCategory === 'windows') return 'Windows';
  return 'Linux';
}

/** The section's values from a VM's config. */
function generalForm(vm) {
  return {
    name: vm.name || '',
    osType: detectOSType(vm),
    vcpus: vm.vcpus || 1,
    memoryMiB: vm.memoryMiB || 1024,
    autostart: vm.autostart || false,
  };
}

/** The fields locked unless the VM is shut off. */
const OFFLINE_FIELDS = ['name', 'vcpus', 'memoryMiB'];
const unitFor = (memoryMiB) => ((memoryMiB ?? 1024) >= 1024 ? 'GB' : 'MB');

/** What Save sends for the values: the name trimmed. */
const generalSent = (f) => ({ ...f, name: (f.name ?? '').trim() });

/**
 * The VM's name, CPU, RAM, OS type and autostart. Editing a VM, the form follows its
 * config record; creating, the panel's draft (`draft`, written through
 * `onDraft(update)`) is the only state.
 */
export default function GeneralSection({ vmConfig, isCreating, draft, onDraft, onSave, onRenamed, busyReason }) {
  /* The name, CPU and RAM are editable only when the VM is shut off (workloadLocks.js).
   * Locked fields show the stored values and are neither sent nor a change. */
  const locked = !isCreating && vmLocked(vmConfig.state);
  const lockedFields = locked ? OFFLINE_FIELDS : [];

  const record = useRecord(isCreating ? null : RECORD.VM, vmConfig.name);
  const edit = useForm(record, generalForm, generalSent, { locked: lockedFields, problems: generalProblems });
  const form = isCreating ? draft : edit.form;
  const save = useCommand();
  /* How RAM is typed is the view's, not a value: the unit the user chose, kept while the
   * size is the one typed in it; a size set otherwise (a record's, an OS's default)
   * shows in the unit its size suggests. */
  const [unitChoice, setUnitChoice] = useState(null);
  const memoryUnit = unitChoice != null && unitChoice.mib === form?.memoryMiB ? unitChoice.unit : unitFor(form?.memoryMiB);

  const updateField = (key, value) => (isCreating
    ? onDraft((d) => ({ ...d, [key]: value }))
    : edit.setField(key, value));

  /* CPU and RAM as typed: a cleared field is '' and, like a number the server refuses,
   * shows its problem under it and blocks Save (creating, Create) with its reason;
   * editing, the form hook keeps only those of values the user changed. */
  const problems = isCreating ? generalProblems(form) : edit.problems;
  const blocked = isCreating ? null : edit.blocked;

  const memoryDisplay = form.memoryMiB === ''
    ? ''
    : memoryUnit === 'GB' ? Math.round(form.memoryMiB / 1024 * 10) / 10 : form.memoryMiB;

  const setMemoryDisplay = (val) => {
    const n = Number(val);
    const memoryMiB = val === '' || !Number.isFinite(n) ? '' : Math.round(memoryUnit === 'GB' ? n * 1024 : n);
    updateField('memoryMiB', memoryMiB);
    setUnitChoice({ unit: memoryUnit, mib: memoryMiB });
  };

  const toggleUnit = () => setUnitChoice({ unit: memoryUnit === 'GB' ? 'MB' : 'GB', mib: form.memoryMiB });

  /* A save that renames the VM ends at its ack and the page follows to the new name,
   * whose page reads its record like any page: this form goes with the old one. */
  const handleSave = () => {
    if (blocked) return;
    const changes = changedFields(generalSent(edit.form), generalSent(edit.saved));
    if (changes.name != null && changes.name !== vmConfig.name) {
      save.run(() => onSave(changes)).then((ok) => { if (ok) onRenamed?.(changes.name); });
      return;
    }
    edit.save((values, saved) => save.run(() => onSave(changedFields(values, saved))));
  };

  return (
    <SectionCard
      title="General"
      isDirty={isCreating ? false : edit.dirty}
      onSave={isCreating ? undefined : handleSave}
      saveDisabledReason={isCreating ? undefined : blocked ?? busyReason}
      saving={edit.saving || save.busy}
      requiresRestart={!!vmConfig.pendingRestart}
      commands={[save]}
    >
      <div className="space-y-0">
        <div className="flex items-end gap-4 flex-wrap">
          {/* Phones: Name grows to fill line one; its floor keeps CPU from joining the line. */}
          <Field label="Name" className="w-[180px] max-sm:flex-1 max-sm:min-w-[140px]">
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              disabled={locked}
              title={locked ? 'Stop the VM to rename it' : undefined}
              className="input-field"
            />
          </Field>

          <Field label="Auto Start">
            <div className="flex h-[34px] items-center">
              <Toggle checked={form.autostart} onChange={(v) => updateField('autostart', v)} />
            </div>
          </Field>

          <div className="mx-0.5 mb-[5px] h-6 w-px bg-surface-border max-sm:hidden" />

          {/* Phones: CPU and RAM pair as equal halves of their own line. */}
          <Field label="CPU" icon={Cpu} problem={problems.vcpus} className="w-16 max-sm:basis-[calc(50%-0.5rem)] max-sm:min-w-0">
            <input
              type="number"
              min={1}
              max={128}
              value={form.vcpus}
              onChange={(e) => updateField('vcpus', e.target.value === '' ? '' : Number(e.target.value))}
              disabled={locked}
              className="input-field input-field-no-spinner w-full text-right text-sm"
            />
          </Field>

          <Field label="RAM" icon={MemoryStick} problem={problems.memoryMiB} className="w-32 max-sm:basis-[calc(50%-0.5rem)] max-sm:min-w-0">
            <div className="flex gap-0.5">
              <input
                type="number"
                min={memoryUnit === 'GB' ? 0.5 : 128}
                step={memoryUnit === 'GB' ? 0.5 : 128}
                value={memoryDisplay}
                onChange={(e) => setMemoryDisplay(e.target.value)}
                disabled={locked}
                className="input-field input-field-no-spinner flex-1 text-right text-sm min-w-0"
              />
              <button
                onClick={toggleUnit}
                className="rounded-md border border-surface-border px-1.5 py-1 text-[10px] font-medium text-text-secondary hover:bg-surface transition-colors duration-150 shrink-0"
              >
                {memoryUnit}
              </button>
            </div>
          </Field>

          <div className="mx-0.5 mb-[5px] h-6 w-px bg-surface-border max-sm:hidden" />

          {/* Full row below sm; content-sized on desktop. */}
          <Field label="OS Type" className="w-full sm:w-auto">
            <RadioPills
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


function Field({ label, icon: Icon, problem, className, children }) {
  return (
    <div className={className}>
      <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5">
        {Icon && <Icon size={12} />}
        {label}
      </label>
      {children}
      {problem && <p className="mt-1 text-[11px] text-status-stopped">{problem}</p>}
    </div>
  );
}
