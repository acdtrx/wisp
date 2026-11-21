import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, Loader2 } from 'lucide-react';

import { createVM } from '../../api/vms.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useJobProgress } from '../../hooks/useJobProgress.js';
import { useRecord } from '../../hooks/useRecord.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import { formatSize } from '../../utils/formatters.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { FormField, formModalNeutralBtn, formModalPrimaryBtn } from '../shared/FormModalChrome.jsx';
import RecordError from '../shared/RecordError.jsx';
import SshKeyPicker from './SshKeyPicker.jsx';
import { defaultKeys, keysProblem, sshKeyText } from './sshKeyChoice.js';
import { CUSTOM_SIZE, SIZE_PRESETS, coresText, memoryText, withPreset } from './vmForms.js';
import {
  RUNS, createVmBody, defaultVmDraft, driverIso, hostnameFromName, imagesFor, vmDraftProblems, withRuns,
} from './vmDraft.js';

const NO_FILES = [];
const NO_KEYS = [];

const STEP_LABELS = {
  validating: 'Checking…',
  copying: 'Copying the image',
  resizing: 'Growing the disk…',
  'creating-disk': 'Creating the disk…',
  cloudinit: 'Writing the first boot setup…',
  defining: 'Defining the VM…',
};

const SIZE_CHOICES = [
  ...SIZE_PRESETS.map((p) => ({ value: p.value, label: p.label, detail: `${coresText(p.vcpus)}, ${memoryText(p.memoryMiB)}` })),
  { value: CUSTOM_SIZE, label: 'Custom', detail: 'Your own' },
];

/** A row of choices, each with a line under its name (Runs, Size). */
function Choices({ label, choices, value, onChange, disabled }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label={label}>
      {choices.map((c) => {
        const on = value === c.value;
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(c.value)}
            className={`rounded-md border px-2.5 py-2 text-left transition-colors duration-150 disabled:opacity-60 ${on ? 'border-accent bg-accent-soft text-accent-text' : 'border-surface-border text-text-secondary hoverable:hover:bg-surface'}`}
          >
            <span className="block text-sm font-medium">{c.label}</span>
            <span className="block text-[11px] text-text-muted">{c.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * New VM (docs/specs/UI-VM.md, New VM): a name, what it runs (its profile), the image,
 * a size, a disk, and for a Linux image its user, password and SSH keys (the list's
 * defaults preselected). The server sets the rest
 * from the profile. The VM is created shut off; its page opens if the user is still here.
 */
export default function CreateVMPanel() {
  const navigate = useNavigate();
  const libraryRecord = useRecord(RECORD.LIBRARY);
  const library = libraryRecord.data ?? NO_FILES;
  const keyList = useRecord(RECORD.SETTINGS).data?.sshKeys ?? NO_KEYS;
  const [draft, setDraft] = useState(() => defaultVmDraft(null));
  const [showPassword, setShowPassword] = useState(false);
  const set = (field, value) => setDraft((d) => ({ ...d, [field]: value }));

  /* The driver ISO is preselected, also when the library answers after Windows 11 was
   * picked, until the user picks the field. */
  const [driversPicked, setDriversPicked] = useState(false);
  const effective = draft.runs === 'windows-11' && !driversPicked && !draft.drivers
    ? { ...draft, drivers: driverIso(library)?.name ?? '' }
    : draft;
  /* The keys picked; until the user picks, the list's defaults, also when it loads late. */
  const chosenKeys = draft.sshKeys ?? defaultKeys(keyList);
  const [keyPaste, setKeyPaste] = useState('');

  const create = useCommand();
  const creating = create.busy;
  const [jobId, setJobId] = useState(null);
  const progress = useJobProgress(jobId);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const problems = vmDraftProblems(effective, library);
  const blocked = Object.values(problems)[0]
    ?? (effective.runs === 'linux-image' ? keysProblem(chosenKeys, keyList, keyPaste) : null);
  const images = imagesFor(effective.runs, library);
  const isos = library.filter((f) => f.type === 'iso');
  const linuxImage = effective.runs === 'linux-image';
  const picked = images.find((f) => f.name === effective.image);

  const submit = (e) => {
    e.preventDefault();
    if (blocked || creating) return;
    const body = createVmBody(effective, library, sshKeyText(chosenKeys, keyList));
    create.run(() => createVM(body), {
      job: true,
      onAck: (ack) => setJobId(ack.jobId),
      onDone: () => {
        if (mountedRef.current) navigate(`/vm/${encodeURIComponent(body.name)}/overview`);
      },
    }).then(() => setJobId(null));
  };

  const step = progress?.step ?? (creating ? 'validating' : null);
  const shown = (field) => (problems[field] && effective[field] !== '' ? problems[field] : null);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-surface-border bg-surface-card px-4">
        <button
          type="button"
          onClick={() => navigate('/host/overview')}
          className="rounded-md p-2 text-text-muted transition-colors duration-150 hoverable:hover:bg-surface hoverable:hover:text-text-primary lg:p-1"
          title="Back"
          aria-label="Back"
        >
          <ArrowLeft size={18} aria-hidden />
        </button>
        <h1 className="text-sm font-semibold text-text-primary">New VM</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5">
        <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4 rounded-card border border-surface-border bg-surface-card p-4 shadow-card">
          <FormField label="Name" htmlFor="new-vm-name">
            <input
              id="new-vm-name"
              ref={autoFocusField}
              type="text"
              value={effective.name}
              onChange={(e) => set('name', e.target.value)}
              disabled={creating}
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              placeholder="media"
              className="input-field"
            />
          </FormField>

          <FormField label="Runs">
            <Choices
              label="Runs"
              choices={RUNS}
              value={effective.runs}
              disabled={creating}
              onChange={(runs) => { setDriversPicked(false); setDraft((d) => withRuns(d, runs, library)); }}
            />
          </FormField>

          <RecordError record={libraryRecord} what="image library" />
          <FormField
            label="Image"
            htmlFor="new-vm-image"
            hint={images.length === 0 && libraryRecord.data != null
              ? (linuxImage ? 'The library has no disk image: add a cloud image in Host, Software.' : 'The library has no ISO: add one in Host, Software.')
              : (picked?.type === 'disk' ? 'Copied as the VM’s disk; the library’s file stays as it is.' : null)}
          >
            <select id="new-vm-image" value={effective.image} onChange={(e) => set('image', e.target.value)} disabled={creating} className="input-field">
              <option value="">{libraryRecord.data == null ? 'Loading the library…' : 'Pick an image'}</option>
              {images.map((f) => <option key={f.name} value={f.name}>{f.name}{f.size ? ` · ${formatSize(f.size)}` : ''}</option>)}
            </select>
          </FormField>

          {effective.runs === 'windows-11' && (
            <FormField label="Drivers" htmlFor="new-vm-drivers" hint="The VirtIO drivers Windows setup needs for the disk and network, in the second CD.">
              <select
                id="new-vm-drivers"
                value={effective.drivers}
                onChange={(e) => { setDriversPicked(true); set('drivers', e.target.value); }}
                disabled={creating}
                className="input-field"
              >
                <option value="">None</option>
                {isos.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
              </select>
            </FormField>
          )}

          <FormField label="Size">
            <Choices label="Size" choices={SIZE_CHOICES} value={effective.preset} disabled={creating} onChange={(p) => setDraft((d) => ({ ...d, ...withPreset(d, p) }))} />
          </FormField>
          {effective.preset === CUSTOM_SIZE && (
            <div className="grid grid-cols-2 gap-3">
              <FormField label="CPU cores" htmlFor="new-vm-cores" hint={shown('vcpus')}>
                <input id="new-vm-cores" type="text" inputMode="numeric" value={effective.vcpus} onChange={(e) => set('vcpus', e.target.value)} className="input-field" />
              </FormField>
              <FormField label="Memory (GB)" htmlFor="new-vm-memory" hint={shown('memoryGB')}>
                <input id="new-vm-memory" type="text" inputMode="decimal" value={effective.memoryGB} onChange={(e) => set('memoryGB', e.target.value)} className="input-field" />
              </FormField>
            </div>
          )}

          <FormField label="Disk (GB)" htmlFor="new-vm-disk" hint={shown('diskGB') ?? (picked?.type === 'disk' ? 'The copied image grows to this size; a larger image keeps its own.' : null)}>
            <input id="new-vm-disk" type="text" inputMode="numeric" value={effective.diskGB} onChange={(e) => set('diskGB', e.target.value)} disabled={creating} className="input-field w-32" />
          </FormField>

          {linuxImage && (
            <fieldset className="space-y-3 border-t border-surface-border pt-3">
              <legend className="mb-1 text-xs font-semibold text-text-primary">First boot setup</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="User" htmlFor="new-vm-user" hint={problems.username ?? `Host name: ${hostnameFromName(effective.name || 'vm')}`}>
                  <input id="new-vm-user" type="text" value={effective.username} onChange={(e) => set('username', e.target.value)} disabled={creating} autoComplete="off" spellCheck={false} className="input-field" />
                </FormField>
                <FormField label="Password" htmlFor="new-vm-password" hint="Optional with an SSH key.">
                  <div className="flex items-stretch gap-2">
                    <input
                      id="new-vm-password"
                      type={showPassword ? 'text' : 'password'}
                      value={effective.password}
                      onChange={(e) => set('password', e.target.value)}
                      disabled={creating}
                      autoComplete="new-password"
                      className="input-field min-w-0 flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="inline-flex shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary"
                      title={showPassword ? 'Hide the password' : 'Show the password'}
                      aria-label={showPassword ? 'Hide the password' : 'Show the password'}
                    >
                      {showPassword ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
                    </button>
                  </div>
                </FormField>
              </div>
              <SshKeyPicker
                idPrefix="new-vm"
                chosen={chosenKeys}
                paste={keyPaste}
                onPaste={setKeyPaste}
                disabled={creating}
                onChange={(update) => setDraft((d) => ({ ...d, sshKeys: update(d.sshKeys ?? defaultKeys(keyList)) }))}
              />
            </fieldset>
          )}

          <ErrorBanner error={create.error} onDismiss={create.dismiss} />

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-surface-border pt-3">
            {creating && step && (
              <span className="mr-auto flex min-w-0 items-center gap-2 text-xs text-text-muted" role="status">
                <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden />
                <span className="truncate">{STEP_LABELS[step] ?? step}{progress?.percent != null ? ` ${Math.round(progress.percent)}%` : ''}</span>
              </span>
            )}
            <button type="button" onClick={() => navigate('/host/overview')} className={formModalNeutralBtn}>Cancel</button>
            <button type="submit" disabled={!!blocked || creating} title={blocked ?? undefined} className={formModalPrimaryBtn}>
              {creating && <Loader2 size={14} className="animate-spin" aria-hidden />}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
