import { useState } from 'react';
import { Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';

import { deleteCloudInit, updateCloudInit } from '../../api/vms.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import FormModal from '../shared/FormModal.jsx';
import { FormCheckbox, FormField } from '../shared/FormModalChrome.jsx';
import IconButton from '../shared/IconButton.jsx';
import Card from '../shared/Card.jsx';
import RecordError from '../shared/RecordError.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import SshKeyPicker from './SshKeyPicker.jsx';
import { extrasText, setupForm, setupProblem, setupSent, storedSetup } from './firstBootSetup.js';
import { defaultKeys, keysProblem, keysText, sshKeyText, vmKeyLines } from './sshKeyChoice.js';

const REMOVE_ABOUT = "Couldn't remove the first boot setup";
const NO_KEYS = [];

/**
 * A Linux VM's first boot setup (cloud-init): its host name, user, password, SSH keys
 * (named by Wisp's list) and options. Edit saves it and rebuilds its setup disk (turning a stored, switched-off setup
 * back on); Remove deletes it, after asking. Both work while the VM runs: the guest
 * reads the setup at its next boot.
 */
export default function VmFirstBootGroup({ config, busy, act }) {
  const record = useRecord(RECORD.VM_CLOUD_INIT, config.name);
  const keyList = useRecord(RECORD.SETTINGS).data?.sshKeys ?? NO_KEYS;
  const stored = storedSetup(record.data);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const removing = act.isBusy('firstBoot');
  const reason = busy ?? (removing ? 'the setup is being removed' : undefined);
  /* Until the read answers (or when it fails), nothing offers to set it up: a failed
   * read is not "none", and a new setup would replace the real one. */
  const loaded = record.data != null;

  return (
    <Card
      title="First boot setup"
      actions={(
        <>
          <IconButton
            icon={Pencil}
            label={stored ? 'Edit the first boot setup' : 'Set up first boot'}
            reason={reason ?? (loaded ? undefined : 'the setup is loading')}
            onClick={() => setEditing(true)}
          />
          {stored && (
            <IconButton icon={Trash2} variant="danger" label="Remove the first boot setup" reason={reason} busy={removing} onClick={() => setConfirming(true)} />
          )}
        </>
      )}
    >
      {loaded && <RecordError record={record} what="first boot setup" className="mb-2" />}
      <RecordGate record={record} what="first boot setup">
        {() => (stored ? (
          <ValueRows
            rows={[
              { label: 'Setup', value: stored.enabled === false ? 'Off: no setup disk is attached' : null },
              { label: 'Host name', value: stored.hostname || `${config.name} (the VM’s name)` },
              { label: 'User', value: stored.username || '—' },
              { label: 'Password', value: stored.password === 'set' ? 'Set' : 'Not set' },
              { label: 'SSH keys', value: keysText(stored.sshKey, keyList) },
              { label: 'Package update', value: stored.packageUpgrade ? 'On' : 'Off' },
              { label: 'Also', value: extrasText(stored) },
            ]}
          />
        ) : <p className="py-1 text-sm text-text-muted">Not set up.</p>)}
      </RecordGate>

      {editing && <SetupEditor vmName={config.name} stored={stored} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={confirming}
        title="Remove the first boot setup?"
        confirmLabel="Remove"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          act.run(() => deleteCloudInit(config.name), { key: 'firstBoot', about: REMOVE_ABOUT });
        }}
      >
        <p>Its settings and stored password are deleted, and its setup disk is taken out of the VM.</p>
        <p className="mt-2 text-xs text-text-muted">The guest keeps what it already applied at its first boot.</p>
      </ConfirmDialog>
    </Card>
  );
}

function SetupEditor({ vmName, stored, onClose }) {
  const { form, setField } = useEditor(() => setupForm(stored));
  const save = useCommand();
  const keyList = useRecord(RECORD.SETTINGS).data?.sshKeys ?? NO_KEYS;
  /* The keys picked: the VM's own, or for a new setup the list's defaults until the
   * user picks (null: not touched, so defaults that load late still count). */
  const [own] = useState(() => vmKeyLines(stored?.sshKey));
  const [picked, setPicked] = useState(() => (stored ? own : null));
  const chosen = picked ?? defaultKeys(keyList);
  const [paste, setPaste] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const problem = setupProblem(form, vmName) ?? keysProblem(chosen, keyList, paste);

  return (
    <FormModal
      title="First boot setup"
      subtitle={vmName}
      save={save}
      blocked={problem}
      onClose={onClose}
      size="lg"
      onSubmit={() => save.run(() => updateCloudInit(vmName, setupSent(form, stored, vmName, sshKeyText(chosen, keyList)))).then((ok) => { if (ok) onClose(); })}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Host name" htmlFor="fb-hostname" hint={form.hostname ? null : 'Empty: the VM’s name.'}>
          <input id="fb-hostname" type="text" value={form.hostname} onChange={(e) => setField('hostname', e.target.value)} placeholder={vmName} autoComplete="off" spellCheck={false} className="input-field" />
        </FormField>
        <FormField label="User" htmlFor="fb-user">
          <input id="fb-user" type="text" value={form.username} onChange={(e) => setField('username', e.target.value)} autoComplete="off" spellCheck={false} className="input-field" />
        </FormField>
      </div>
      <FormField label="Password" htmlFor="fb-password" hint={stored?.password === 'set' ? 'Empty: keep the stored password.' : 'Empty: no password; sign in with an SSH key.'}>
        <div className="flex items-stretch gap-2">
          <input
            id="fb-password"
            type={showPassword ? 'text' : 'password'}
            value={form.password}
            onChange={(e) => setField('password', e.target.value)}
            placeholder={stored?.password === 'set' ? 'Unchanged' : ''}
            autoComplete="new-password"
            className="input-field min-w-0 flex-1"
          />
          <IconButton
            variant="field"
            icon={showPassword ? EyeOff : Eye}
            label={showPassword ? 'Hide the password' : 'Show the password'}
            onClick={() => setShowPassword((v) => !v)}
          />
        </div>
      </FormField>
      <SshKeyPicker
        idPrefix="fb"
        chosen={chosen}
        own={own}
        paste={paste}
        onPaste={setPaste}
        onChange={(update) => setPicked((p) => update(p ?? defaultKeys(keyList)))}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <FormCheckbox label="Update the packages" checked={form.packageUpgrade} onChange={(e) => setField('packageUpgrade', e.target.checked)} />
        <FormCheckbox label="Grow the disk to its size" checked={form.growPartition} onChange={(e) => setField('growPartition', e.target.checked)} />
        <FormCheckbox label="Install the guest agent" hint="Wisp then sees the guest’s address and host name." checked={form.installQemuGuestAgent} onChange={(e) => setField('installQemuGuestAgent', e.target.checked)} />
        <FormCheckbox label="Install avahi" hint="The guest then announces itself as <host name>.local." checked={form.installAvahiDaemon} onChange={(e) => setField('installAvahiDaemon', e.target.checked)} />
      </div>
      <p className="text-[11px] text-text-muted">A guest that has booted already applies a changed setup at its next boot.</p>
      {problem && <p className="text-[11px] text-status-stopped">{problem}</p>}
    </FormModal>
  );
}
