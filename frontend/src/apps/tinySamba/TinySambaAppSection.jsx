/**
 * Tiny Samba app configuration — Server / Users / Shares form. Per-share host source can be
 * Local (container files dir) or any wisp storage mount.
 *
 * Password handling follows the secret-field pattern:
 *   - API masks each user's password as `{ isSet: bool }` on read.
 *   - We send a fresh password string only when the row's password input was edited;
 *     unchanged rows omit the field, and the backend merges the prior password forward.
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus,
  Trash2,
  Server as ServerIcon,
  Eye,
  EyeOff,
  Folder,
  UserPlus,
  Network,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import SectionCard from '../../components/shared/SectionCard.jsx';
import Toggle from '../../components/shared/Toggle.jsx';
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
import { useSettingsStore } from '../../store/settingsStore.js';

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

const PROTOCOLS = ['SMB1', 'SMB2', 'SMB3'];
const ICON_MODEL_DEFAULT = 'TimeCapsule6,106';
const ICON_MODEL_DISABLED = '-';

function parseAppConfig(config) {
  const ac = config?.metadata?.appConfig || {};
  const server = ac.server || {};
  return {
    server: {
      workgroup: server.workgroup ?? 'WORKGROUP',
      netbiosName: server.netbiosName ?? 'tiny-samba',
      dataUid: Number.isInteger(server.dataUid) ? server.dataUid : 1000,
      minProtocol: PROTOCOLS.includes(server.minProtocol) ? server.minProtocol : 'SMB3',
      iconModel: typeof server.iconModel === 'string' && server.iconModel ? server.iconModel : ICON_MODEL_DEFAULT,
    },
    users: (ac.users || []).map((u) => ({
      id: randomId(),
      name: u.name ?? '',
      password: '',
      hasPassword: !!u.password?.isSet,
      passwordDirty: false,
    })),
    shares: (ac.shares || []).map((s) => ({
      id: randomId(),
      name: s.name ?? '',
      guest: !!s.guest,
      sourceId: s.source?.sourceId ?? '',
      subPath: s.source?.subPath ?? '',
      access: (s.access || []).map((a) => ({ user: a.user, level: a.level })),
      expanded: false,
    })),
  };
}

function isValidUid(value) {
  if (value === '' || value === null || value === undefined) return false;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(n) && n >= 0 && n <= 65535;
}

export default function TinySambaAppSection({ config, onSave }) {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const storageMounts = useMemo(() => settings?.mounts || [], [settings]);

  const [form, setForm] = useState(() => parseAppConfig(config));
  const [original, setOriginal] = useState(() => parseAppConfig(config));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showPasswords, setShowPasswords] = useState({});
  const [serverOpen, setServerOpen] = useState(true);
  const [usersOpen, setUsersOpen] = useState(true);
  const [sharesOpen, setSharesOpen] = useState(true);

  useEffect(() => {
    if (!settings) loadSettings().catch(() => {});
  }, [settings, loadSettings]);

  // Reset on appConfig identity change. We hash users / shares at the field level rather than
  // trusting object identity because the parent containerStore replaces the full config object
  // on every SSE tick.
  const appConfigKey = useMemo(() => JSON.stringify(config?.metadata?.appConfig || {}), [config?.metadata?.appConfig]);
  useEffect(() => {
    const parsed = parseAppConfig(config);
    setForm(parsed);
    setOriginal(parsed);
    setError(null);
    setShowPasswords({});
  }, [appConfigKey]);

  const isDirty = useCallback(() => {
    const o = original;
    const f = form;
    if (
      f.server.workgroup !== o.server.workgroup
      || f.server.netbiosName !== o.server.netbiosName
      || Number(f.server.dataUid) !== Number(o.server.dataUid)
      || f.server.minProtocol !== o.server.minProtocol
      || f.server.iconModel !== o.server.iconModel
    ) return true;
    if (f.users.length !== o.users.length) return true;
    for (let i = 0; i < f.users.length; i++) {
      if (f.users[i].name !== o.users[i]?.name) return true;
      if (f.users[i].passwordDirty) return true;
    }
    if (f.shares.length !== o.shares.length) return true;
    for (let i = 0; i < f.shares.length; i++) {
      const fs = f.shares[i];
      const os = o.shares[i];
      if (!os) return true;
      if (
        fs.name !== os.name
        || fs.guest !== os.guest
        || (fs.sourceId || '') !== (os.sourceId || '')
        || (fs.subPath || '') !== (os.subPath || '')
      ) return true;
      if (fs.access.length !== os.access.length) return true;
      for (let j = 0; j < fs.access.length; j++) {
        if (fs.access[j].user !== os.access[j]?.user) return true;
        if (fs.access[j].level !== os.access[j]?.level) return true;
      }
    }
    return false;
  }, [form, original]);

  const updateServer = (field, value) => {
    setForm((prev) => ({ ...prev, server: { ...prev.server, [field]: value } }));
  };

  const addUser = () => {
    setForm((prev) => ({
      ...prev,
      users: [...prev.users, {
        id: randomId(), name: '', password: '', hasPassword: false, passwordDirty: true,
      }],
    }));
  };
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
  const removeUser = (id) => {
    setForm((prev) => {
      const removed = prev.users.find((u) => u.id === id);
      const removedName = removed?.name?.trim();
      // Cascade: drop the user from any share's access list so we don't leave dangling refs.
      const shares = prev.shares.map((s) => ({
        ...s,
        access: s.access.filter((a) => a.user !== removedName),
      }));
      return { ...prev, users: prev.users.filter((u) => u.id !== id), shares };
    });
  };
  const toggleShowPassword = (id) => {
    setShowPasswords((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const addShare = () => {
    setForm((prev) => ({
      ...prev,
      shares: [...prev.shares, {
        id: randomId(),
        name: '',
        guest: false,
        sourceId: '',
        subPath: '',
        access: [],
        expanded: true,
      }],
    }));
  };
  const updateShare = (id, field, value) => {
    setForm((prev) => ({
      ...prev,
      shares: prev.shares.map((s) => {
        if (s.id !== id) return s;
        if (field === 'guest' && value) {
          // Switching to guest drops the per-user access list (tiny-samba ignores it for guest).
          return { ...s, guest: true, access: [] };
        }
        if (field === 'sourceId') {
          // Clearing the source clears subPath too; selecting one keeps prior subPath.
          if (!value) return { ...s, sourceId: '', subPath: '' };
          return { ...s, sourceId: value };
        }
        return { ...s, [field]: value };
      }),
    }));
  };
  const removeShare = (id) => {
    setForm((prev) => ({ ...prev, shares: prev.shares.filter((s) => s.id !== id) }));
  };
  const toggleShareExpanded = (id) => {
    setForm((prev) => ({
      ...prev,
      shares: prev.shares.map((s) => (s.id === id ? { ...s, expanded: !s.expanded } : s)),
    }));
  };
  const setShareAccess = (shareId, userName, level) => {
    setForm((prev) => ({
      ...prev,
      shares: prev.shares.map((s) => {
        if (s.id !== shareId) return s;
        const without = s.access.filter((a) => a.user !== userName);
        if (level === 'none') return { ...s, access: without };
        return { ...s, access: [...without, { user: userName, level }] };
      }),
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const declaredUsers = form.users
        .map((u) => u.name.trim())
        .filter((n) => n.length > 0);

      // Pre-flight guards mirror tiny-samba's validation so users see issues here instead of
      // a "reload failed" error from smbd.
      for (const s of form.shares) {
        if (!s.guest) {
          const liveAccess = s.access.filter((a) => declaredUsers.includes(a.user));
          if (liveAccess.length === 0) {
            const label = s.name.trim() || '(unnamed)';
            throw new Error(`Share "${label}" needs at least one user with access (or set Guest on).`);
          }
        }
      }

      const appConfig = {
        server: {
          workgroup: form.server.workgroup.trim(),
          netbiosName: form.server.netbiosName.trim(),
          dataUid: Number(form.server.dataUid),
          minProtocol: form.server.minProtocol,
          iconModel: form.server.iconModel,
        },
        users: form.users.map((u) => {
          const entry = { name: u.name.trim() };
          if (u.passwordDirty && u.password) {
            entry.password = u.password;
          }
          return entry;
        }),
        shares: form.shares.map((s) => {
          const out = {
            name: s.name.trim(),
            guest: !!s.guest,
            access: s.guest
              ? []
              : s.access.filter((a) => declaredUsers.includes(a.user)),
          };
          if (s.sourceId) {
            out.source = { sourceId: s.sourceId, subPath: (s.subPath || '').trim() };
          }
          return out;
        }),
      };
      await onSave(appConfig);
    } catch (err) {
      setError(err?.detail || err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const dirty = isDirty();
  const declaredUserNames = form.users.map((u) => u.name.trim()).filter(Boolean);

  // ── shared classes ────────────────────────────────────────────────
  const subHeader =
    'flex items-center justify-between border-t border-surface-border pt-3 cursor-pointer select-none';
  const subHeaderTitle =
    'text-[11px] font-semibold uppercase tracking-wider text-text-muted inline-flex items-center gap-1.5';

  return (
    <SectionCard
      title="Tiny Samba Configuration"
      titleIcon={<Network size={14} />}
      onSave={handleSave}
      saving={saving}
      isDirty={dirty}
      requiresRestart={!!config?.pendingRestart}
      error={error}
    >
      <div className="space-y-4">
        {/* ── Server ─────────────────────────────────────────────── */}
        <div className={subHeader} onClick={() => setServerOpen((v) => !v)}>
          <span className={subHeaderTitle}>
            {serverOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <ServerIcon size={12} />
            Server
          </span>
        </div>
        {serverOpen && (
          <div className="flex items-end gap-4 flex-wrap">
            <div className="min-w-[120px] flex-1">
              <label className="text-xs font-medium text-text-secondary mb-1.5 block">Workgroup</label>
              <input
                type="text"
                className="input-field"
                placeholder="WORKGROUP"
                maxLength={15}
                value={form.server.workgroup}
                onChange={(e) => updateServer('workgroup', e.target.value)}
              />
            </div>
            <div className="min-w-[120px] flex-1">
              <label className="text-xs font-medium text-text-secondary mb-1.5 block">NetBIOS name</label>
              <input
                type="text"
                className="input-field"
                placeholder="tiny-samba"
                maxLength={15}
                value={form.server.netbiosName}
                onChange={(e) => updateServer('netbiosName', e.target.value)}
              />
            </div>
            <div className="w-32">
              <label className="text-xs font-medium text-text-secondary mb-1.5 block" title="UID inside the container that owns share data on disk">
                Data UID
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={5}
                className={`input-field text-right ${isValidUid(form.server.dataUid) ? '' : 'border-status-stopped'}`}
                value={form.server.dataUid}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9]/g, '');
                  updateServer('dataUid', v === '' ? '' : Number(v));
                }}
              />
            </div>
            <div className="w-32">
              <label className="text-xs font-medium text-text-secondary mb-1.5 block">Min protocol</label>
              <select
                className="input-field"
                value={form.server.minProtocol}
                onChange={(e) => updateServer('minProtocol', e.target.value)}
              >
                {PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="min-w-[180px]">
              <label
                className="text-xs font-medium text-text-secondary mb-1.5 block"
                title="Apple SMB extensions: nicer macOS Finder icon and faster browse, but rely on streams_xattr which can fail on some filesystems"
              >
                Apple extensions
              </label>
              <select
                className="input-field"
                value={form.server.iconModel === ICON_MODEL_DISABLED ? ICON_MODEL_DISABLED : ICON_MODEL_DEFAULT}
                onChange={(e) => updateServer('iconModel', e.target.value)}
              >
                <option value={ICON_MODEL_DEFAULT}>On (Time Capsule icon)</option>
                <option value={ICON_MODEL_DISABLED}>Off (disable AAPL/streams_xattr)</option>
              </select>
            </div>
          </div>
        )}

        {/* ── Users ──────────────────────────────────────────────── */}
        <div className={subHeader} onClick={() => setUsersOpen((v) => !v)}>
          <span className={subHeaderTitle}>
            {usersOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <UserPlus size={12} />
            Users
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); addUser(); }}
            className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
            title="Add user"
            aria-label="Add user"
          >
            <Plus size={14} aria-hidden />
            <UserPlus size={14} aria-hidden />
          </button>
        </div>
        {usersOpen && (
          <DataTableScroll>
            <DataTable minWidthRem={28}>
              <thead>
                <tr className={dataTableHeadRowClass}>
                  <DataTableTh dense className="w-1/3">Name</DataTableTh>
                  <DataTableTh dense>Password</DataTableTh>
                  <DataTableTh dense align="right" className="w-12">Actions</DataTableTh>
                </tr>
              </thead>
              <tbody>
                {form.users.length === 0 && (
                  <tr className={dataTableBodyRowClass}>
                    <td colSpan={3} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                      No users yet. Add at least one to expose authenticated shares.
                    </td>
                  </tr>
                )}
                {form.users.map((user) => (
                  <tr key={user.id} className={dataTableInteractiveRowClass}>
                    <DataTableTd dense className="w-1/3">
                      <input
                        type="text"
                        className="input-field w-full min-w-0 text-xs"
                        placeholder="alice"
                        value={user.name}
                        onChange={(e) => updateUser(user.id, 'name', e.target.value)}
                      />
                    </DataTableTd>
                    <DataTableTd dense>
                      <div className="flex items-center gap-1">
                        <input
                          type={showPasswords[user.id] ? 'text' : 'password'}
                          className="input-field flex-1 min-w-0 text-xs"
                          placeholder={user.hasPassword && !user.passwordDirty ? 'Set (leave empty to keep)' : 'plaintext or $NT$<32 hex>'}
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
        )}

        {/* ── Shares ─────────────────────────────────────────────── */}
        <div className={subHeader} onClick={() => setSharesOpen((v) => !v)}>
          <span className={subHeaderTitle}>
            {sharesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Folder size={12} />
            Shares
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); addShare(); }}
            className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
            title="Add share"
            aria-label="Add share"
          >
            <Plus size={14} aria-hidden />
            <Folder size={14} aria-hidden />
          </button>
        </div>
        {sharesOpen && (
          <div className="space-y-2">
            {form.shares.length === 0 && (
              <p className="text-xs text-text-muted px-1 py-2">
                No shares configured. Add one to expose a directory over SMB.
              </p>
            )}
            {form.shares.map((share) => (
              <ShareRow
                key={share.id}
                share={share}
                storageMounts={storageMounts}
                declaredUserNames={declaredUserNames}
                onUpdate={updateShare}
                onRemove={removeShare}
                onToggleExpanded={toggleShareExpanded}
                onSetAccess={setShareAccess}
              />
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function ShareRow({ share, storageMounts, declaredUserNames, onUpdate, onRemove, onToggleExpanded, onSetAccess }) {
  const accessByUser = useMemo(() => {
    const map = new Map();
    for (const a of share.access) map.set(a.user, a.level);
    return map;
  }, [share.access]);

  return (
    <div className="rounded-md border border-surface-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => onToggleExpanded(share.id)}
          className="text-text-muted hover:text-text-primary shrink-0"
          title={share.expanded ? 'Collapse' : 'Expand'}
          aria-label={share.expanded ? 'Collapse share' : 'Expand share'}
        >
          {share.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <input
          type="text"
          className="input-field text-xs w-32 shrink-0"
          placeholder="documents"
          value={share.name}
          onChange={(e) => onUpdate(share.id, 'name', e.target.value)}
        />
        <select
          className="input-field text-xs w-40 shrink-0"
          value={share.sourceId}
          onChange={(e) => onUpdate(share.id, 'sourceId', e.target.value)}
          title="Where on the host the share's bytes live"
        >
          <option value="">Local (container files)</option>
          {storageMounts.map((sm) => (
            <option key={sm.id} value={sm.id}>
              {(sm.label && sm.label.trim()) || sm.mountPath}
            </option>
          ))}
        </select>
        {share.sourceId && (
          <input
            type="text"
            className="input-field text-xs flex-1 min-w-[12rem] font-mono"
            placeholder="sub-path inside the storage mount (empty = mount root)"
            title="Relative path inside the selected storage mount"
            value={share.subPath}
            onChange={(e) => onUpdate(share.id, 'subPath', e.target.value)}
          />
        )}
        <label
          className="inline-flex items-center gap-1 text-xs text-text-secondary shrink-0 ml-auto"
          title="Anonymous read-only access — disables the per-user access list"
        >
          <span>Guest</span>
          <Toggle
            checked={share.guest}
            onChange={(v) => onUpdate(share.id, 'guest', v)}
          />
        </label>
        <button
          type="button"
          className={`${iconBtn} shrink-0`}
          onClick={() => onRemove(share.id)}
          title="Remove share"
          aria-label="Remove share"
        >
          <Trash2 size={13} />
        </button>
      </div>
      {share.expanded && (
        <div className="border-t border-surface-border px-3 py-3 bg-surface-card">
          {share.guest ? (
            <p className="text-xs text-text-muted">
              Guest shares ignore per-user access. tiny-samba serves them anonymously, read-only.
            </p>
          ) : (
            <>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">
                Per-user access
              </div>
              {declaredUserNames.length === 0 ? (
                <p className="text-xs text-text-muted">
                  Declare users above to grant per-user access.
                </p>
              ) : (
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {declaredUserNames.map((u) => {
                    const level = accessByUser.get(u) || 'none';
                    return (
                      <label key={u} className="inline-flex items-center gap-2 text-xs">
                        <span className="font-mono w-16 text-text-secondary truncate" title={u}>{u}</span>
                        <select
                          className="input-field text-xs w-28"
                          value={level}
                          onChange={(e) => onSetAccess(share.id, u, e.target.value)}
                        >
                          <option value="none">None</option>
                          <option value="ro">Read</option>
                          <option value="rw">Read/Write</option>
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
