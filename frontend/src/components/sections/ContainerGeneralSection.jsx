import { useState } from 'react';
import RadioPills from '../shared/RadioPills.jsx';
import { Cpu, MemoryStick, RefreshCw, Images } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import HelpIcon from '../shared/HelpIcon.jsx';
import ImageLibraryModal from '../shared/ImageLibraryModal.jsx';
import { containerGeneralForm, containerGeneralProblems, containerGeneralSent } from './containerGeneralForm.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useForm } from '../../hooks/useForm.js';
import { changedFields } from '../../hooks/formState.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import { containerLocked } from '../../utils/workloadLocks.js';

/** Same control pattern as AdvancedSection (machine type, CPU model). */
const RESTART_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: 'on-failure', label: 'On failure' },
  { value: 'unless-stopped', label: 'Unless stopped' },
  { value: 'always', label: 'Always' },
];

function RestartPolicyPills({ value, onChange }) {
  return <RadioPills options={RESTART_OPTIONS} value={value} onChange={onChange} />;
}

/**
 * The container's name, image, command, limits and run options. Editing a container,
 * the form follows its config record; creating, the panel's draft (`draft`: the name
 * and image, written through `onDraft(update)`) is the only state.
 */
export default function ContainerGeneralSection({ config, isCreating, draft, onDraft, onSave, onRenamed, headerAction }) {
  /* The restart badge follows the container's `pendingRestart`. */
  const requiresRestart = !isCreating && !!config?.pendingRestart;
  const [pickerOpen, setPickerOpen] = useState(false);

  /* Name is editable in create mode and when the container is stopped (workloadLocks.js). */
  const nameEditable = isCreating || !containerLocked(config?.state);

  const record = useRecord(isCreating ? null : RECORD.CONTAINER, config.name);
  /* A locked name shows the stored one, and a name left in the field is neither sent
   * nor a change. */
  const edit = useForm(record, containerGeneralForm, containerGeneralSent, {
    locked: nameEditable ? [] : ['name'],
    problems: containerGeneralProblems,
  });
  const form = isCreating ? draft : edit.form;
  const save = useCommand();

  /* What keeps the values from being saved, shown beside its field: Save is blocked
   * with the first (the form hook keeps those of values the user changed). */
  const problems = isCreating ? {} : edit.problems;
  const nameError = problems.name ?? null;
  const blocked = isCreating ? null : edit.blocked;

  const updateField = (key, value) => (isCreating
    ? onDraft((d) => ({ ...d, [key]: value }))
    : edit.setField(key, value));

  const handleSave = () => {
    if (blocked) return;
    /* A save that renames the container ends at its ack and the page follows to the new
     * name, whose page reads its record like any page: this form goes with the old one. */
    const changes = changedFields(containerGeneralSent(edit.form), containerGeneralSent(edit.saved));
    if (changes.name) {
      save.run(() => onSave(changes)).then((ok) => { if (ok) onRenamed?.(changes.name); });
      return;
    }
    edit.save((values, saved) => save.run(() => onSave(changedFields(values, saved))));
  };

  return (
    <SectionCard title="General" isDirty={!isCreating && edit.dirty} onSave={isCreating ? undefined : handleSave} saving={edit.saving || save.busy} saveDisabledReason={blocked ?? undefined} requiresRestart={requiresRestart} commands={[save]} headerAction={headerAction}>
      <div className="space-y-3">
        <div className="flex items-end gap-4 flex-wrap">
          <Field
            label={nameError
              ? <>Name <span className="font-normal text-status-stopped" role="alert">— required</span></>
              : 'Name'}
            className="w-[180px]"
          >
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              disabled={!nameEditable}
              maxLength={63}
              autoComplete="off"
              spellCheck={false}
              title={nameEditable ? undefined : 'Stop the container to rename it'}
              aria-invalid={nameError ? true : undefined}
              className="input-field"
            />
          </Field>

          {!isCreating && (
            <>
              <Field label="DNS" helpText="Local DNS — advertise this container on the LAN as <name>.local via mDNS">
                <div className="flex h-[34px] items-center">
                  <Toggle checked={form.localDns} onChange={(v) => updateField('localDns', v)} />
                </div>
              </Field>

              <div className="mx-0.5 mb-[5px] h-6 w-px bg-surface-border max-sm:hidden" />

              <Field label="CPU" icon={Cpu} problem={problems.cpuLimit} className="w-16">
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

              <Field label="RAM (MiB)" icon={MemoryStick} problem={problems.memoryLimitMiB} className="w-24">
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

              <div className="mx-0.5 mb-[5px] h-6 w-px bg-surface-border max-sm:hidden" />
            </>
          )}

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
        <div className="flex items-end gap-4 flex-wrap">
          <Field
            label="Command Override"
            problem={problems.command}
            helpText={'Arguments separated by spaces, quoted like a shell: \'a b\' or "a b" is one argument. No shell runs — for pipes, && or $VARS use sh -c \'…\'. Empty = image default.'}
            className="flex-1 min-w-[240px]"
          >
            <input
              type="text"
              value={form.command}
              onChange={(e) => updateField('command', e.target.value)}
              placeholder="Leave empty for image default"
              className="input-field"
            />
          </Field>

          <Field label="Run as Root">
            <div className="flex h-[34px] items-center">
              <Toggle checked={form.runAsRoot} onChange={(v) => updateField('runAsRoot', v)} />
            </div>
          </Field>

          <Field label="Restart Policy" icon={RefreshCw} className="max-sm:basis-full">
            <RestartPolicyPills
              value={form.restartPolicy}
              onChange={(v) => updateField('restartPolicy', v)}
            />
          </Field>

          <div className="mx-0.5 mb-[5px] h-6 w-px bg-surface-border max-sm:hidden" />

          <Field label="Auto Start">
            <div className="flex h-[34px] items-center">
              <Toggle checked={form.autostart} onChange={(v) => updateField('autostart', v)} />
            </div>
          </Field>

          <Field
            label="Auto Backup"
            helpText="Included in the daily scheduled backup (Host Mgmt → Backup Scheduler). A running container is briefly paused while it's archived."
          >
            <div className="flex h-[34px] items-center">
              <Toggle checked={form.autoBackup} onChange={(v) => updateField('autoBackup', v)} />
            </div>
          </Field>
        </div>
        )}
      </div>
    </SectionCard>
  );
}


function Field({ label, icon: Icon, helpText, problem, className, children }) {
  return (
    <div className={className}>
      <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5">
        {Icon && <Icon size={12} />}
        {label}
        {helpText && <HelpIcon text={helpText} size={12} />}
      </label>
      {children}
      {problem && <p className="mt-1 text-[11px] text-status-stopped">{problem}</p>}
    </div>
  );
}
