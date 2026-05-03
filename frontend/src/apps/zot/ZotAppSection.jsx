/**
 * Zot OCI Registry app configuration — users table with htpasswd auth.
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Container, Eye, EyeOff, UserPlus } from 'lucide-react';
import SectionCard from '../../components/shared/SectionCard.jsx';
import {
  DataTableScroll,
  DataTable,
  dataTableHeadRowClass,
  dataTableBodyRowClass,
  dataTableInteractiveRowClass,
  DataTableRowActions,
  DataTableTh,
  DataTableTd,
  dataTableEmptyCellClass,
} from '../../components/shared/DataTableChrome.jsx';
import { randomId } from '../../utils/randomId.js';

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

function parseAppConfig(config) {
  const ac = config?.metadata?.appConfig || {};
  return {
    users: (ac.users || []).map((u) => ({
      id: randomId(),
      username: u.username ?? '',
      password: '',
      hasPassword: u.hasPassword ?? false,
      passwordDirty: false,
    })),
  };
}

export default function ZotAppSection({ config, onSave }) {
  const [form, setForm] = useState(() => parseAppConfig(config));
  const [original, setOriginal] = useState(() => parseAppConfig(config));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [showPasswords, setShowPasswords] = useState({});

  useEffect(() => {
    const parsed = parseAppConfig(config);
    setForm(parsed);
    setOriginal(parsed);
    setRequiresRestart(false);
    setError(null);
    setShowPasswords({});
  }, [JSON.stringify(config?.metadata?.appConfig?.users)]);

  const isDirty = useCallback(() => {
    if (form.users.length !== original.users.length) return true;
    for (let i = 0; i < form.users.length; i++) {
      if (form.users[i].username !== original.users[i]?.username) return true;
      if (form.users[i].passwordDirty) return true;
    }
    return false;
  }, [form, original]);

  const updateUser = (id, field, value) => {
    setForm((prev) => ({
      ...prev,
      users: prev.users.map((u) => {
        if (u.id !== id) return u;
        if (field === 'password') return { ...u, password: value, passwordDirty: true };
        return { ...u, [field]: value };
      }),
    }));
  };

  const addUser = () => {
    setForm((prev) => ({
      ...prev,
      users: [...prev.users, { id: randomId(), username: '', password: '', hasPassword: false, passwordDirty: true }],
    }));
  };

  const removeUser = (id) => {
    setForm((prev) => ({
      ...prev,
      users: prev.users.filter((u) => u.id !== id),
    }));
  };

  const toggleShowPassword = (id) => {
    setShowPasswords((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const users = form.users.map((u) => {
        const entry = { username: u.username.trim() };
        if (u.passwordDirty && u.password) {
          entry.password = u.password;
        }
        return entry;
      });
      const result = await onSave({ users });
      if (result?.requiresRestart) setRequiresRestart(true);
    } catch (err) {
      setError(err?.detail || err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const dirty = isDirty();

  const addUserButton = (
    <button
      type="button"
      onClick={addUser}
      className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
      title="Add user"
      aria-label="Add user"
    >
      <Plus size={14} aria-hidden />
      <UserPlus size={14} aria-hidden />
    </button>
  );

  return (
    <SectionCard
      title="Zot Registry Configuration"
      titleIcon={<Container size={14} />}
      helpText="The registry listens on port 5000. With no users it allows anonymous push and pull — add users to require basic auth."
      onSave={handleSave}
      saving={saving}
      isDirty={dirty}
      requiresRestart={requiresRestart || config?.pendingRestart}
      error={error}
      headerAction={addUserButton}
    >
      <div className="space-y-3">
        <DataTableScroll>
          <DataTable minWidthRem={28}>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh dense className="w-1/3">Username</DataTableTh>
                <DataTableTh dense>Password</DataTableTh>
                <DataTableTh dense align="right" className="w-16">Actions</DataTableTh>
              </tr>
            </thead>
            <tbody>
              {form.users.length === 0 && (
                <tr className={dataTableBodyRowClass}>
                  <td colSpan={3} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                    No users — registry allows anonymous access. Use the + button above to add authentication.
                  </td>
                </tr>
              )}
              {form.users.map((user) => (
                <tr key={user.id} className={dataTableInteractiveRowClass}>
                  <DataTableTd dense className="w-1/3">
                    <input
                      type="text"
                      className="input-field w-full min-w-0 text-xs"
                      placeholder="username"
                      value={user.username}
                      onChange={(e) => updateUser(user.id, 'username', e.target.value)}
                    />
                  </DataTableTd>
                  <DataTableTd dense>
                    <div className="flex items-center gap-1">
                      <input
                        type={showPasswords[user.id] ? 'text' : 'password'}
                        className="input-field flex-1 min-w-0 text-xs"
                        placeholder={user.hasPassword && !user.passwordDirty ? 'Set (leave empty to keep)' : 'password'}
                        value={user.password}
                        onChange={(e) => updateUser(user.id, 'password', e.target.value)}
                      />
                      <button
                        type="button"
                        className={iconBtn}
                        onClick={() => toggleShowPassword(user.id)}
                        title={showPasswords[user.id] ? 'Hide' : 'Show'}
                        aria-label={showPasswords[user.id] ? 'Hide password' : 'Show password'}
                      >
                        {showPasswords[user.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    </div>
                  </DataTableTd>
                  <DataTableTd dense align="right">
                    <DataTableRowActions forceVisible>
                      <button
                        type="button"
                        className={iconBtn}
                        onClick={() => removeUser(user.id)}
                        title="Remove user"
                        aria-label="Remove user"
                      >
                        <Trash2 size={13} />
                      </button>
                    </DataTableRowActions>
                  </DataTableTd>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </DataTableScroll>
      </div>
    </SectionCard>
  );
}
