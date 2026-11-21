import { useState } from 'react';
import { Cloud, AtSign, RefreshCw, Trash2, Loader2, Eye, EyeOff, KeyRound } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import { updateCloudInit, deleteCloudInit, fetchGithubKeys } from '../../api/vms.js';
import { awaitVmChange } from '../../store/vmStore.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useForm, useHeld } from '../../hooks/useForm.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import RecordGate from '../shared/RecordGate.jsx';
import RecordError from '../shared/RecordError.jsx';

/** API returns `{ enabled: false }` when no cloud-init.json exists. */
function isBareCloudInitPlaceholder(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && data.enabled === false
    && Object.keys(data).length === 1,
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-text-secondary mb-1.5">{label}</label>
      {children}
    </div>
  );
}

/** The form's values with nothing stored: what Configure starts from. The hostname is
 *  empty: the VM's name is its placeholder, and what Save stores when it stays empty. */
const CLOUD_INIT_DEFAULTS = {
  enabled: true,
  hostname: '',
  username: 'wisp',
  password: '',
  sshKey: '',
  sshKeySource: '',
  growPartition: true,
  packageUpgrade: false,
  installQemuGuestAgent: true,
  installAvahiDaemon: true,
};

/** The edit form from the stored cloud-init (none: the defaults). */
function storedForm(data) {
  const config = data && !isBareCloudInitPlaceholder(data) ? data : null;
  if (!config) return { ...CLOUD_INIT_DEFAULTS };
  return {
    enabled: config.enabled !== false,
    hostname: config.hostname || '',
    username: config.username || 'wisp',
    password: '',
    sshKey: config.sshKey || '',
    sshKeySource: config.sshKeySource || '',
    growPartition: config.growPartition ?? true,
    packageUpgrade: config.packageUpgrade ?? false,
    installQemuGuestAgent: config.installQemuGuestAgent ?? true,
    installAvahiDaemon: config.installAvahiDaemon ?? true,
  };
}

/**
 * What Save sends, against the stored cloud-init (`data`, read by the VM's name as it is
 * now, `vmName`): an empty hostname means that name, which the placeholder shows and
 * which is stored; a blank password keeps the one on file ("Leave blank to keep
 * unchanged": the API reads '' as no password, 'set' as keep).
 */
function cloudInitSent(form, data, vmName) {
  const stored = data && !isBareCloudInitPlaceholder(data) ? data : null;
  return {
    ...form,
    hostname: form.hostname || vmName,
    password: form.password || (stored?.password === 'set' ? 'set' : ''),
  };
}

/**
 * The cloud-init section. Editing a VM's, the form follows its cloud-init record.
 * Creating, the panel's draft (`draft`, written through `onDraft(update)`) is the only
 * state: the section reads it and writes it, and the panel converts it at submit.
 */
export default function CloudInitSection({ vmConfig, isCreating, draft, onDraft, busyReason }) {
  const vmName = vmConfig.name;

  const [collapsed, setCollapsed] = useState(!isCreating);
  const cloudInit = useRecord(RECORD.VM_CLOUD_INIT, isCreating ? null : vmName);
  const config = cloudInit.data && !isBareCloudInitPlaceholder(cloudInit.data) ? cloudInit.data : null;
  /* Until the first read lands, and when it fails, nothing may offer to configure
   * cloud-init: a failed read is not "no configuration", and Configure would overwrite
   * the real one. */
  const edit = useForm(cloudInit, storedForm, cloudInitSent);
  const form = isCreating ? draft : edit.form;
  const setFields = (fields) => (isCreating ? onDraft((d) => ({ ...d, ...fields })) : edit.setForm((f) => ({ ...f, ...fields })));
  const updateField = (key, value) => setFields({ [key]: value });
  const [editing, setEditing] = useState(isCreating);
  /* Save and remove write the VM's cloud-init (one at a time: both are disabled while
   * either runs); the GitHub key lookup is a command of its own. */
  const op = useCommand();
  const keyLookup = useCommand();
  const fetchingKeys = keyLookup.busy;
  const saving = edit.saving || op.busy;
  const [ghUsername, setGhUsername] = useState('');
  const [ghKeys, setGhKeys] = useState([]);
  /* The password revealed: held on the form as it is, a reset hides it again (the create
   * draft is never reset). */
  const [showPassword, setShowPassword] = useHeld(edit.generation);
  const toggleShowPassword = () => setShowPassword((on) => (on ? null : true));

  const startEditing = () => {
    edit.reset();
    setEditing(true);
    setCollapsed(false);
  };

  const cancelEditing = () => {
    edit.reset();
    setEditing(false);
  };

  const handleSave = () => edit.save((values) => op.run(() => updateCloudInit(vmName, values), { key: 'save' }))
    .then((ok) => { if (ok) setEditing(false); });

  const handleDelete = () => op.run(() => awaitVmChange(vmName, () => deleteCloudInit(vmName)), {
    key: 'delete', onDone: () => setEditing(false),
  });

  /* One write for the key and its source, so neither is lost to the other. */
  const pickKey = (key, user) => setFields({ sshKey: key, sshKeySource: `github:${user}` });

  const handleFetchGithubKeys = () => {
    const user = ghUsername.trim();
    if (!user) return;
    keyLookup.run(() => fetchGithubKeys(user), {
      onDone: (data) => {
        const keys = data.keys || [];
        setGhKeys(keys);
        if (keys.length > 0) pickKey(keys[0], user);
      },
    });
  };

  const editForm = form && (
    <EditForm
      form={form}
      hostnamePlaceholder={vmName || 'my-vm'}
      updateField={updateField}
      cloudInitEnabled={form.enabled !== false}
      showPassword={showPassword}
      toggleShowPassword={toggleShowPassword}
      ghUsername={ghUsername}
      setGhUsername={setGhUsername}
      ghKeys={ghKeys}
      fetchingKeys={fetchingKeys}
      onFetchGithubKeys={handleFetchGithubKeys}
      onSelectKey={(key) => pickKey(key, ghUsername.trim())}
    />
  );

  if (isCreating) {
    return (
      <SectionCard title="Cloud-Init" commands={[keyLookup]}
      errorPrefix={() => 'GitHub keys'}>
        {editForm}
      </SectionCard>
    );
  }

  const hasConfig = !!config;

  return (
    <SectionCard
      title="Cloud-Init"
      collapsible
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed(!collapsed)}
      commands={[op, keyLookup]}
      errorPrefix={(key, command) => (command === keyLookup ? 'GitHub keys' : undefined)}
    >
      {!editing || !form ? (
        <div className="space-y-3">
          {cloudInit.data != null && <RecordError record={cloudInit} what="cloud-init configuration" />}
          {cloudInit.data == null ? (
            <RecordGate
              record={cloudInit}
              what="cloud-init configuration"
              loading={(
                <div className="flex items-center gap-2 py-4 text-xs text-text-muted">
                  <Loader2 size={14} className="animate-spin" /> Loading cloud-init…
                </div>
              )}
            >
              {() => null}
            </RecordGate>
          ) : hasConfig ? (
            <>
              <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                <SummaryRow
                  label="Cloud Init"
                  value={config.enabled === false ? 'Off' : 'On'}
                />
                <SummaryRow label="Hostname" value={config.hostname || `${vmName} (VM name)`} />
                <SummaryRow label="Username" value={config.username || '—'} />
                <SummaryRow
                  label="Password"
                  value={config.password === 'set' ? '••••••••' : 'Not set'}
                />
                <SummaryRow
                  label="SSH Key"
                  value={
                    config.sshKey
                      ? config.sshKeySource || 'Configured'
                      : 'Not set'
                  }
                />
                <SummaryRow label="Grow Partition" value={config.growPartition ? 'Yes' : 'No'} />
                <SummaryRow label="Package Upgrade" value={config.packageUpgrade ? 'Yes' : 'No'} />
                <SummaryRow label="QEMU Guest Agent" value={config.installQemuGuestAgent !== false ? 'Yes' : 'No'} />
                <SummaryRow label="Avahi daemon" value={config.installAvahiDaemon !== false ? 'Yes' : 'No'} />
              </div>
              {/* Editing cloud-init isn't a phone task — read-only below sm */}
              <div className="hidden items-center gap-2 pt-2 sm:flex">
                <button
                  onClick={startEditing}
                  disabled={!!busyReason}
                  title={busyReason}
                  className="flex items-center gap-1.5 rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface disabled:opacity-50 transition-colors duration-150"
                >
                  <RefreshCw size={12} /> Regenerate
                </button>
                <button
                  onClick={handleDelete}
                  disabled={saving || !!busyReason}
                  title={busyReason}
                  className="flex items-center gap-1.5 rounded-md border border-status-stopped/30 px-3 py-1.5 text-xs font-medium text-status-stopped hover:bg-status-stopped-soft disabled:opacity-50 transition-colors duration-150"
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Remove
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-4">
              <Cloud size={28} className="text-text-muted" />
              <p className="text-xs text-text-muted">No cloud-init configuration</p>
              {/* Configuring cloud-init isn't a phone task — hidden below sm */}
              <button
                onClick={startEditing}
                disabled={!!busyReason}
                title={busyReason}
                className="hidden items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors duration-150 sm:flex"
              >
                <Cloud size={12} /> Configure Cloud-Init
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {editForm}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving || !!busyReason}
              title={busyReason}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors duration-150"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Cloud size={12} />}
              {form.enabled === false
                ? 'Save'
                : hasConfig
                  ? 'Regenerate ISO'
                  : 'Generate ISO'}
            </button>
            <button
              onClick={cancelEditing}
              disabled={saving}
              className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface disabled:opacity-50 transition-colors duration-150"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function SummaryRow({ label, value }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs font-medium text-text-secondary w-28 shrink-0">{label}</span>
      <span className="text-xs text-text-primary truncate">{value}</span>
    </div>
  );
}

function EditForm({
  form, hostnamePlaceholder, updateField, cloudInitEnabled,
  showPassword, toggleShowPassword,
  ghUsername, setGhUsername, ghKeys, fetchingKeys,
  onFetchGithubKeys, onSelectKey,
}) {
  const subDisabled = !cloudInitEnabled;
  return (
    <div className="space-y-4">
      {/* Row 1: Hostname, Username, Password */}
      <div className="grid grid-cols-3 gap-4">
        <Field label="Hostname">
          <input
            type="text"
            value={form.hostname}
            onChange={(e) => updateField('hostname', e.target.value)}
            placeholder={hostnamePlaceholder}
            disabled={subDisabled}
            className="input-field disabled:opacity-50"
          />
        </Field>

        <Field label="Username">
          <input
            type="text"
            value={form.username}
            onChange={(e) => updateField('username', e.target.value)}
            disabled={subDisabled}
            className="input-field disabled:opacity-50"
          />
        </Field>

        <Field label="Password">
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(e) => updateField('password', e.target.value)}
              placeholder="Leave blank to keep unchanged"
              disabled={subDisabled}
              className="input-field pr-8 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={toggleShowPassword}
              disabled={subDisabled}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary disabled:opacity-40"
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>
      </div>

      {/* Row 2: SSH Key, GitHub username, Fetch */}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="SSH Public Key">
            <input
              type="text"
              value={form.sshKey}
              onChange={(e) => updateField('sshKey', e.target.value)}
              placeholder="ssh-ed25519 AAAA..."
              disabled={subDisabled}
              className="input-field font-mono text-[11px] disabled:opacity-50"
            />
          </Field>
        </div>
        <div className="w-44 shrink-0">
          <Field label={<span className="flex items-center gap-1"><AtSign size={11} /> GitHub Username</span>}>
            <input
              type="text"
              value={ghUsername}
              onChange={(e) => setGhUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onFetchGithubKeys(); }}
              placeholder="username"
              disabled={subDisabled}
              className="input-field disabled:opacity-50"
            />
          </Field>
        </div>
        <button
          type="button"
          onClick={onFetchGithubKeys}
          disabled={subDisabled || fetchingKeys || !ghUsername.trim()}
          className="flex items-center gap-1.5 rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface disabled:opacity-50 transition-colors duration-150 shrink-0"
        >
          {fetchingKeys ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
          Fetch
        </button>
      </div>
      {ghKeys.length > 1 && !subDisabled && (
        <div className="space-y-1">
          <span className="text-[10px] text-text-muted">{ghKeys.length} keys found — select one:</span>
          {ghKeys.map((key, i) => (
            <button
              key={`gh-key-${i}`}
              type="button"
              onClick={() => onSelectKey(key)}
              className={`block w-full truncate rounded-md border px-2.5 py-1 text-left font-mono text-[10px] transition-colors duration-150 ${
                form.sshKey === key
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-surface-border text-text-secondary hover:bg-surface'
              }`}
            >
              {key.substring(0, 80)}…
            </button>
          ))}
        </div>
      )}

      {/* Row 3: Master + option toggles */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <Field label="Cloud Init">
          <Toggle checked={form.enabled !== false} onChange={(v) => updateField('enabled', v)} />
        </Field>

        <Field label="Grow Partition">
          <Toggle checked={form.growPartition} onChange={(v) => updateField('growPartition', v)} disabled={subDisabled} />
        </Field>

        <Field label="Package Upgrade">
          <Toggle checked={form.packageUpgrade} onChange={(v) => updateField('packageUpgrade', v)} disabled={subDisabled} />
        </Field>

        <Field label="QEMU Guest Agent">
          <Toggle checked={form.installQemuGuestAgent} onChange={(v) => updateField('installQemuGuestAgent', v)} disabled={subDisabled} />
        </Field>

        <Field label="Avahi Daemon">
          <Toggle checked={form.installAvahiDaemon} onChange={(v) => updateField('installAvahiDaemon', v)} disabled={subDisabled} />
        </Field>
      </div>
    </div>
  );
}
