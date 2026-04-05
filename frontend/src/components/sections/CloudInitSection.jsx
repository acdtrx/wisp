import { useState, useEffect, useCallback, useRef } from 'react';
import { Cloud, Github, RefreshCw, Trash2, Loader2, Eye, EyeOff, KeyRound } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import { getCloudInit, updateCloudInit, deleteCloudInit, fetchGithubKeys } from '../../api/vms.js';

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

const DEFAULTS = {
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

export default function CloudInitSection({ vmConfig, isCreating, onRefresh, initialCloudInit, onCloudInitChange }) {
  const vmName = vmConfig.name;
  const osCategory = vmConfig.osCategory || 'linux';

  const [collapsed, setCollapsed] = useState(!isCreating);
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(() => {
    const hostname = (initialCloudInit?.hostname) || vmConfig.name || '';
    if (initialCloudInit && typeof initialCloudInit === 'object') {
      return {
        ...DEFAULTS,
        ...initialCloudInit,
        password: initialCloudInit.password || '',
        hostname,
        enabled: initialCloudInit.enabled !== false,
      };
    }
    return { ...DEFAULTS, hostname };
  });
  const [editing, setEditing] = useState(isCreating);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [fetchingKeys, setFetchingKeys] = useState(false);
  const [ghUsername, setGhUsername] = useState('');
  const [ghKeys, setGhKeys] = useState([]);
  const [showPassword, setShowPassword] = useState(false);
  const prevVmNameRef = useRef(vmName);

  const loadConfig = useCallback(async () => {
    if (isCreating) return;
    try {
      const data = await getCloudInit(vmName);
      setConfig(isBareCloudInitPlaceholder(data) ? null : data);
    } catch {
      setConfig(null);
    }
  }, [vmName, isCreating]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // In create mode, keep hostname prefilled with VM name when name changes (until user edits hostname)
  useEffect(() => {
    if (!isCreating || vmName === prevVmNameRef.current) return;
    const prevName = prevVmNameRef.current;
    prevVmNameRef.current = vmName;
    setForm(prev => {
      const wasSynced = prev.hostname === prevName || prev.hostname === '';
      return wasSynced ? { ...prev, hostname: vmName } : prev;
    });
  }, [isCreating, vmName]);

  const updateField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  useEffect(() => {
    if (!isCreating || !onCloudInitChange || !form) return;
    onCloudInitChange({
      enabled: form.enabled !== false,
      hostname: form.hostname,
      username: form.username,
      password: form.password,
      sshKey: form.sshKey,
      growPartition: form.growPartition,
      packageUpgrade: form.packageUpgrade,
      installQemuGuestAgent: form.installQemuGuestAgent,
      installAvahiDaemon: form.installAvahiDaemon,
    });
  }, [
    isCreating,
    onCloudInitChange,
    form.enabled,
    form.hostname,
    form.username,
    form.password,
    form.sshKey,
    form.growPartition,
    form.packageUpgrade,
    form.installQemuGuestAgent,
    form.installAvahiDaemon,
  ]);

  const startEditing = () => {
    if (config) {
      setForm({
        enabled: config.enabled !== false,
        hostname: config.hostname || vmName,
        username: config.username || 'wisp',
        password: '',
        sshKey: config.sshKey || '',
        sshKeySource: config.sshKeySource || '',
        growPartition: config.growPartition ?? true,
        packageUpgrade: config.packageUpgrade ?? false,
        installQemuGuestAgent: config.installQemuGuestAgent ?? true,
        installAvahiDaemon: config.installAvahiDaemon ?? true,
      });
    } else {
      setForm({ ...DEFAULTS, hostname: vmName });
    }
    setEditing(true);
    setCollapsed(false);
    setError(null);
  };

  const cancelEditing = () => {
    setEditing(false);
    setError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateCloudInit(vmName, form);
      setEditing(false);
      if (onRefresh) await onRefresh();
      await loadConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    setError(null);
    try {
      await deleteCloudInit(vmName);
      setConfig(null);
      setEditing(false);
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleFetchGithubKeys = async () => {
    if (!ghUsername.trim()) return;
    setFetchingKeys(true);
    setError(null);
    try {
      const data = await fetchGithubKeys(ghUsername.trim());
      const keys = data.keys || [];
      setGhKeys(keys);
      if (keys.length > 0) {
        updateField('sshKey', keys[0]);
        updateField('sshKeySource', `github:${ghUsername.trim()}`);
      }
    } catch (err) {
      setError(`GitHub keys: ${err.message}`);
    } finally {
      setFetchingKeys(false);
    }
  };

  // For create mode, return inline form fields only
  if (isCreating) {
    return (
      <SectionCard title="Cloud-Init" error={error}>
        <EditForm
          form={form}
          updateField={updateField}
          cloudInitEnabled={form.enabled !== false}
          showPassword={showPassword}
          setShowPassword={setShowPassword}
          ghUsername={ghUsername}
          setGhUsername={setGhUsername}
          ghKeys={ghKeys}
          fetchingKeys={fetchingKeys}
          onFetchGithubKeys={handleFetchGithubKeys}
          onSelectKey={(key) => { updateField('sshKey', key); updateField('sshKeySource', `github:${ghUsername}`); }}
        />
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
      error={error}
    >
      {!editing ? (
        <div className="space-y-3">
          {hasConfig ? (
            <>
              <div className="grid grid-cols-2 gap-x-8 gap-y-2">
                <SummaryRow
                  label="Cloud Init"
                  value={config.enabled === false ? 'Off' : 'On'}
                />
                <SummaryRow label="Hostname" value={config.hostname || '—'} />
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
              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={startEditing}
                  className="flex items-center gap-1.5 rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface transition-colors duration-150"
                >
                  <RefreshCw size={12} /> Regenerate
                </button>
                <button
                  onClick={handleDelete}
                  disabled={saving}
                  className="flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-status-stopped hover:bg-red-50 disabled:opacity-50 transition-colors duration-150"
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
              <button
                onClick={startEditing}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150"
              >
                <Cloud size={12} /> Configure Cloud-Init
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <EditForm
            form={form}
            updateField={updateField}
            cloudInitEnabled={form.enabled !== false}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            ghUsername={ghUsername}
            setGhUsername={setGhUsername}
            ghKeys={ghKeys}
            fetchingKeys={fetchingKeys}
            onFetchGithubKeys={handleFetchGithubKeys}
            onSelectKey={(key) => { updateField('sshKey', key); updateField('sshKeySource', `github:${ghUsername}`); }}
          />
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
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
  form, updateField, cloudInitEnabled,
  showPassword, setShowPassword,
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
            placeholder="my-vm"
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
              onClick={() => setShowPassword(!showPassword)}
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
          <Field label={<span className="flex items-center gap-1"><Github size={11} /> GitHub Username</span>}>
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
                  ? 'border-accent bg-blue-50 text-accent'
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
