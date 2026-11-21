import { useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import RadioPills from '../shared/RadioPills.jsx';
import { LinuxIcon, WindowsIcon } from '../shared/vmIcons.jsx';
import { generalProblems } from '../vm/vmDraft.js';

const OS_ICONS = { Linux: LinuxIcon, Windows: WindowsIcon };

const OS_TYPES = [
  { value: 'Linux', label: 'Linux' },
  { value: 'Windows', label: 'Windows' },
];

const unitFor = (memoryMiB) => ((memoryMiB ?? 1024) >= 1024 ? 'GB' : 'MB');

/**
 * The Create VM panel's name, CPU, RAM, OS type and autostart: the panel's draft
 * (`draft`, written through `onDraft(update)`) is the only state.
 */
export default function GeneralSection({ draft, onDraft }) {
  const form = draft;
  /* How RAM is typed is the view's, not a value: the unit the user chose, kept while the
   * size is the one typed in it; a size set otherwise (an OS's default) shows in the
   * unit its size suggests. */
  const [unitChoice, setUnitChoice] = useState(null);
  const memoryUnit = unitChoice != null && unitChoice.mib === form.memoryMiB ? unitChoice.unit : unitFor(form.memoryMiB);

  const updateField = (key, value) => onDraft((d) => ({ ...d, [key]: value }));

  /* CPU and RAM as typed: a cleared field is '' and, like a number the server refuses,
   * shows its problem under it and keeps Create off with its reason. */
  const problems = generalProblems(form);

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

  return (
    <SectionCard title="General">
      <div className="space-y-0">
        <div className="flex items-end gap-4 flex-wrap">
          {/* Phones: Name grows to fill line one; its floor keeps CPU from joining the line. */}
          <Field label="Name" className="w-[180px] max-sm:flex-1 max-sm:min-w-[140px]">
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
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
