import { useState } from 'react';
import { Eye, EyeOff, KeyRound, Loader2, Pencil, Trash2 } from 'lucide-react';

import { deleteCloudInit, fetchGithubKeys, updateCloudInit } from '../../api/vms.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useForm.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import FormModal from '../shared/FormModal.jsx';
import { FormCheckbox, FormField } from '../shared/FormModalChrome.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import GroupCard from '../shared/GroupCard.jsx';
import RecordError from '../shared/RecordError.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import { extrasText, keyText, setupForm, setupProblem, setupSent, storedSetup } from './firstBootSetup.js';

const REMOVE_ABOUT = "Couldn't remove the first boot setup";

/**
 * A Linux VM's first boot setup (cloud-init): its host name, user, password, SSH key and
 * options. Edit saves it and rebuilds its setup disk (turning a stored, switched-off setup
 * back on); Remove deletes it, after asking. Both work while the VM runs: the guest
 * reads the setup at its next boot.
 */
export default function VmFirstBootGroup({ config, busy, act }) {
  const record = useRecord(RECORD.VM_CLOUD_INIT, config.name);
  const stored = storedSetup(record.data);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const removing = act.isBusy('firstBoot');
  const reason = busy ?? (removing ? 'the setup is being removed' : undefined);
  /* Until the read answers (or when it fails), nothing offers to set it up: a failed
   * read is not "none", and a new setup would replace the real one. */
  const loaded = record.data != null;

  return (
    <GroupCard
      title="First boot setup"
      actions={(
        <>
          <GroupAction
            icon={Pencil}
            label={stored ? 'Edit the first boot setup' : 'Set up first boot'}
            reason={reason ?? (loaded ? undefined : 'the setup is loading')}
            onClick={() => setEditing(true)}
          />
          {stored && (
            <GroupAction icon={Trash2} variant="danger" label="Remove the first boot setup" reason={reason} busy={removing} onClick={() => setConfirming(true)} />
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
              { label: 'SSH key', value: keyText(stored) },
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
    </GroupCard>
  );
}

function SetupEditor({ vmName, stored, onClose }) {
  const { form, setField, setForm } = useEditor(() => setupForm(stored));
  const save = useCommand();
  const lookup = useCommand();
  const [showPassword, setShowPassword] = useState(false);
  const [github, setGithub] = useState({ user: '', keys: [] });
  const problem = setupProblem(form, vmName);

  const pickKey = (key, user) => setForm((f) => ({ ...f, sshKey: key, sshKeySource: `github:${user}` }));
  const fetchKeys = () => {
    const user = github.user.trim();
    if (!user) return;
    lookup.run(() => fetchGithubKeys(user), {
      onDone: (data) => {
        const keys = data.keys || [];
        setGithub((g) => ({ ...g, keys }));
        if (keys.length > 0) pickKey(keys[0], user);
      },
    });
  };

  return (
    <FormModal
      title="First boot setup"
      subtitle={vmName}
      save={save}
      blocked={problem}
      onClose={onClose}
      size="lg"
      onSubmit={() => save.run(() => updateCloudInit(vmName, setupSent(form, stored, vmName))).then((ok) => { if (ok) onClose(); })}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Host name" htmlFor="fb-hostname" hint={form.hostname ? null : 'Empty: the VM’s name.'}>
          <input id="fb-hostname" type="text" value={form.hostname} onChange={(e) => setField('hostname', e.target.value)} placeholder={vmName} autoComplete="off" spellCheck={false} className="input-field" />
        </FormField>
        <FormField label="User" htmlFor="fb-user">
          <input id="fb-user" type="text" value={form.username} onChange={(e) => setField('username', e.target.value)} autoComplete="off" spellCheck={false} className="input-field" />
        </FormField>
      </div>
      <FormField label="Password" htmlFor="fb-password" hint={stored?.password === 'set' ? 'Empty: keep the stored password.' : 'Empty: no password; sign in with the SSH key.'}>
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
      <FormField label="SSH public key" htmlFor="fb-key">
        <input
          id="fb-key"
          type="text"
          value={form.sshKey}
          onChange={(e) => setForm((f) => ({ ...f, sshKey: e.target.value, sshKeySource: 'manual' }))}
          placeholder="ssh-ed25519 AAAA… name"
          autoComplete="off"
          spellCheck={false}
          className="input-field font-mono"
        />
      </FormField>
      <FormField label="Or take it from GitHub" htmlFor="fb-github">
        <div className="flex items-stretch gap-2">
          <input
            id="fb-github"
            type="text"
            value={github.user}
            onChange={(e) => setGithub({ user: e.target.value, keys: [] })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); fetchKeys(); } }}
            placeholder="GitHub user"
            autoComplete="off"
            spellCheck={false}
            className="input-field min-w-0 flex-1"
          />
          <button
            type="button"
            onClick={fetchKeys}
            disabled={lookup.busy || !github.user.trim()}
            className="inline-flex shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary disabled:opacity-40"
            title="Fetch the user’s keys from GitHub"
            aria-label="Fetch the user’s keys from GitHub"
          >
            {lookup.busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <KeyRound size={15} aria-hidden />}
          </button>
        </div>
        {github.keys.length > 1 && (
          <div className="mt-2 space-y-1">
            <p className="text-[11px] text-text-muted">{github.keys.length} keys found; pick one:</p>
            {github.keys.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => pickKey(key, github.user.trim())}
                className={`block w-full truncate rounded-md border px-2.5 py-1 text-left font-mono text-[11px] ${form.sshKey === key ? 'border-accent bg-accent-soft text-accent-text' : 'border-surface-border text-text-secondary'}`}
              >
                {key}
              </button>
            ))}
          </div>
        )}
        <ErrorBanner className="mt-2" error={lookup.error} prefix="GitHub keys" onDismiss={lookup.dismiss} />
      </FormField>
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
