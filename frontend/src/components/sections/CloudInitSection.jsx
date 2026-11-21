import { useState } from 'react';
import { AtSign, Loader2, Eye, EyeOff, KeyRound } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import { fetchGithubKeys } from '../../api/vms.js';
import { useCommand } from '../../hooks/useCommand.js';

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-text-secondary mb-1.5">{label}</label>
      {children}
    </div>
  );
}

/**
 * The Create VM panel's cloud-init: the panel's draft (`draft`, written through
 * `onDraft(update)`) is the only state; the panel converts it at submit.
 */
export default function CloudInitSection({ vmConfig, draft, onDraft }) {
  const vmName = vmConfig.name;
  const form = draft;
  const setFields = (fields) => onDraft((d) => ({ ...d, ...fields }));
  const updateField = (key, value) => setFields({ [key]: value });
  /* The GitHub key lookup is the section's one command. */
  const keyLookup = useCommand();
  const [ghUsername, setGhUsername] = useState('');
  const [ghKeys, setGhKeys] = useState([]);
  const [showPassword, setShowPassword] = useState(null);
  const toggleShowPassword = () => setShowPassword((on) => (on ? null : true));

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

  return (
    <SectionCard title="Cloud-Init" commands={[keyLookup]} errorPrefix={() => 'GitHub keys'}>
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
        fetchingKeys={keyLookup.busy}
        onFetchGithubKeys={handleFetchGithubKeys}
        onSelectKey={(key) => pickKey(key, ghUsername.trim())}
      />
    </SectionCard>
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
