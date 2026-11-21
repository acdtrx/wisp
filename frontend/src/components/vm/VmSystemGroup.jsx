import { useState } from 'react';
import { Code2, SlidersHorizontal } from 'lucide-react';

import { changedFields } from '../../hooks/formState.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useForm.js';
import FormModal from '../shared/FormModal.jsx';
import { FormCheckbox, FormField } from '../shared/FormModalChrome.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import GroupCard from '../shared/GroupCard.jsx';
import RadioPills from '../shared/RadioPills.jsx';
import XMLModal from './XMLModal.jsx';
import {
  BOOT_DEVICES, CONSOLE, CPU_MODELS, FIRMWARE, MACHINE_TYPES, OPERATING_SYSTEMS, VIDEO, expertForm, profileText, systemSummary,
  toggledBootDevice,
} from './vmForms.js';

/**
 * What the VM was made as (its profile) and, in one line, what its settings are.
 * Expert settings opens every technical setting, grouped, while the VM is shut off; View
 * XML shows its definition at any time.
 */
export default function VmSystemGroup({ config, busy, lockReason, update }) {
  const [open, setOpen] = useState(null);
  return (
    <GroupCard
      title="System"
      lockReason={lockReason ? 'Stop the VM to change its settings' : undefined}
      actions={(
        <>
          <GroupAction icon={Code2} label="View the XML" onClick={() => setOpen('xml')} />
          <GroupAction icon={SlidersHorizontal} label="Expert settings" reason={busy ?? lockReason} onClick={() => setOpen('expert')} />
        </>
      )}
    >
      <p className="py-1 text-sm text-text-primary">
        <span className="mr-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-text">{profileText(config.profile)}</span>
        {systemSummary(config)}
      </p>
      {open === 'expert' && <ExpertSettings config={config} update={update} onClose={() => setOpen(null)} />}
      <XMLModal open={open === 'xml'} vmName={config.name} onClose={() => setOpen(null)} />
    </GroupCard>
  );
}

function Section({ title, children }) {
  return (
    <fieldset className="space-y-3 border-t border-surface-border pt-3 first:border-t-0 first:pt-0">
      <legend className="mb-1 text-xs font-semibold text-text-primary">{title}</legend>
      {children}
    </fieldset>
  );
}

function ExpertSettings({ config, update, onClose }) {
  const { form, start, setField, setForm, dirty } = useEditor(() => expertForm(config));
  const save = useCommand();
  return (
    <FormModal
      title="Expert settings"
      subtitle={`${config.name}: ${profileText(config.profile)}`}
      save={save}
      blocked={dirty ? null : 'Nothing changed'}
      onClose={onClose}
      size="lg"
      onSubmit={() => save.run(() => update(changedFields(form, start))).then((ok) => { if (ok) onClose(); })}
    >
      <Section title="Boot">
        <FormField label="Boot order" hint="Tap to add or take out; the numbers are the order.">
          <div className="flex flex-wrap gap-1.5">
            {BOOT_DEVICES.map((d) => {
              const at = form.bootOrder.indexOf(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  aria-pressed={at >= 0}
                  onClick={() => setForm((f) => ({ ...f, bootOrder: toggledBootDevice(f.bootOrder, d.value) }))}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium ${at >= 0 ? 'border-accent bg-accent-soft text-accent-text' : 'border-surface-border text-text-muted'}`}
                >
                  {at >= 0 && <span className="mr-1">{at + 1}.</span>}{d.label}
                </button>
              );
            })}
          </div>
        </FormField>
        <FormCheckbox label="Boot menu" hint="Lets you pick a boot device at start." checked={form.bootMenu} onChange={(e) => setField('bootMenu', e.target.checked)} />
      </Section>
      <Section title="Firmware and machine">
        <FormField label="Firmware"><RadioPills options={FIRMWARE} value={form.firmware} onChange={(v) => setField('firmware', v)} /></FormField>
        <FormField label="Machine type"><RadioPills options={MACHINE_TYPES} value={form.machineType} onChange={(v) => setField('machineType', v)} /></FormField>
        <FormField label="CPU model"><RadioPills options={CPU_MODELS} value={form.cpuMode} onChange={(v) => setField('cpuMode', v)} /></FormField>
        <FormCheckbox label="Nested virtualisation" hint="Lets the guest run VMs of its own." checked={form.nestedVirt} onChange={(e) => setField('nestedVirt', e.target.checked)} />
      </Section>
      <Section title="Display">
        <FormField label="Video"><RadioPills options={VIDEO} value={form.videoDriver} onChange={(v) => setField('videoDriver', v)} /></FormField>
        <FormField label="Console protocol"><RadioPills options={CONSOLE} value={form.graphicsType} onChange={(v) => setField('graphicsType', v)} /></FormField>
      </Section>
      <Section title="Integration">
        <div className="grid gap-2 sm:grid-cols-2">
          <FormCheckbox label="Guest agent" checked={form.guestAgent} onChange={(e) => setField('guestAgent', e.target.checked)} />
          <FormCheckbox label="Memory balloon" checked={form.memBalloon} onChange={(e) => setField('memBalloon', e.target.checked)} />
          <FormCheckbox label="Random number device" checked={form.virtioRng} onChange={(e) => setField('virtioRng', e.target.checked)} />
          <FormCheckbox label="TPM 2.0" checked={form.vtpm} onChange={(e) => setField('vtpm', e.target.checked)} />
        </div>
      </Section>
      <Section title="Operating system">
        <FormField label="The Windows tuning follows it" hint="Windows turns on the Hyper-V tuning and the Windows clock; Linux turns them off.">
          <RadioPills options={OPERATING_SYSTEMS} value={form.osType} onChange={(v) => setField('osType', v)} />
        </FormField>
      </Section>
    </FormModal>
  );
}
