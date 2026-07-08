/**
 * Zot OCI Registry app configuration — htpasswd users table plus optional OIDC sign-on.
 *
 * The two auth methods coexist by design: zot resolves either to a bare identity string,
 * and they are independent code paths, so htpasswd keeps working when the IdP is down —
 * and it stays the only way `docker login` can authenticate without an API key.
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Container, Eye, EyeOff, UserPlus, KeyRound } from 'lucide-react';
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

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

const labelClass = 'flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5';

/** zot reads the identity from one claim of the ID token. `preferred_username` matches a
 *  short htpasswd username; `email` is zot's own default. See CUSTOM-APPS.md § Zot. */
const USERNAME_CLAIMS = ['preferred_username', 'email', 'sub', 'name'];

const DEFAULT_SCOPES = 'openid profile email';

function parseAppConfig(config) {
  const ac = config?.metadata?.appConfig || {};
  const oidc = ac.oidc || {};
  return {
    externalUrl: ac.externalUrl ?? '',
    users: (ac.users || []).map((u) => ({
      id: randomId(),
      username: u.username ?? '',
      password: '',
      hasPassword: u.hasPassword ?? false,
      passwordDirty: false,
    })),
    oidcEnabled: oidc.enabled ?? false,
    oidcName: oidc.name ?? '',
    oidcIssuer: oidc.issuer ?? '',
    oidcClientId: oidc.clientId ?? '',
    oidcClientSecret: '',
    oidcSecretIsSet: oidc.clientSecret?.isSet ?? false,
    oidcSecretDirty: false,
    oidcScopes: (oidc.scopes || []).join(' ') || DEFAULT_SCOPES,
    oidcUsernameClaim: oidc.usernameClaim || USERNAME_CLAIMS[0],
  };
}

export default function ZotAppSection({ config, onSave }) {
  const [form, setForm] = useState(() => parseAppConfig(config));
  const [original, setOriginal] = useState(() => parseAppConfig(config));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [showPasswords, setShowPasswords] = useState({});
  const [showSecret, setShowSecret] = useState(false);

  const appConfigSig = JSON.stringify(config?.metadata?.appConfig);
  useEffect(() => {
    const parsed = parseAppConfig(config);
    setForm(parsed);
    setOriginal(parsed);
    setRequiresRestart(false);
    setError(null);
    setShowPasswords({});
    setShowSecret(false);
  }, [appConfigSig]);

  const isDirty = useCallback(() => {
    if (form.externalUrl !== original.externalUrl) return true;
    if (form.oidcEnabled !== original.oidcEnabled) return true;
    if (form.oidcName !== original.oidcName) return true;
    if (form.oidcIssuer !== original.oidcIssuer) return true;
    if (form.oidcClientId !== original.oidcClientId) return true;
    if (form.oidcSecretDirty) return true;
    if (form.oidcScopes !== original.oidcScopes) return true;
    if (form.oidcUsernameClaim !== original.oidcUsernameClaim) return true;
    if (form.users.length !== original.users.length) return true;
    for (let i = 0; i < form.users.length; i++) {
      if (form.users[i].username !== original.users[i]?.username) return true;
      if (form.users[i].passwordDirty) return true;
    }
    return false;
  }, [form, original]);

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

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
        // Omit the password when untouched — the backend recovers the stored hash by
        // username. A renamed user reads as new and is rejected without a password.
        const entry = { username: u.username.trim() };
        if (u.passwordDirty && u.password) {
          entry.password = u.password;
        }
        return entry;
      });

      const oidc = {
        enabled: form.oidcEnabled,
        name: form.oidcName.trim(),
        issuer: form.oidcIssuer.trim(),
        clientId: form.oidcClientId.trim(),
        scopes: form.oidcScopes.split(/[\s,]+/).filter(Boolean),
        usernameClaim: form.oidcUsernameClaim,
      };
      // Only send the secret when retyped; omitting it keeps the stored one. Sending ''
      // when nothing is stored is how you'd clear it, which the backend then rejects
      // while OIDC is enabled.
      if (form.oidcSecretDirty || !form.oidcSecretIsSet) {
        oidc.clientSecret = form.oidcClientSecret;
      }

      const result = await onSave({ users, externalUrl: form.externalUrl.trim(), oidc });
      if (result?.requiresRestart) setRequiresRestart(true);
    } catch (err) {
      setError(err?.detail || err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const dirty = isDirty();
  const callbackUrl = form.externalUrl.trim()
    ? `${form.externalUrl.trim().replace(/\/+$/, '')}/zot/auth/callback/oidc`
    : null;

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
      helpText="The registry listens on port 5000. With no users and no SSO it allows anonymous push and pull — add users or enable OIDC to require authentication. Anonymous pull stays enabled either way."
      onSave={handleSave}
      saving={saving}
      isDirty={dirty}
      requiresRestart={requiresRestart || config?.pendingRestart}
      error={error}
      headerAction={addUserButton}
    >
      <div className="space-y-5">
        <div>
          <label className={labelClass} htmlFor="zot-external-url">External URL</label>
          <input
            id="zot-external-url"
            type="text"
            className="input-field"
            placeholder="https://registry.example.com"
            value={form.externalUrl}
            onChange={(e) => updateField('externalUrl', e.target.value)}
          />
          <p className="mt-1 text-[11px] text-text-muted">
            The address browsers reach the registry on. Required for OIDC — it is the base of the
            redirect URI, and zot otherwise falls back to <code>0.0.0.0:5000</code>.
          </p>
        </div>

        <div>
          <p className={labelClass}>Users (htpasswd)</p>
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
                      No users — password auth disabled. Use the + button above to add a user.
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

        <div className="rounded-md border border-surface-border bg-surface p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
              <KeyRound size={13} aria-hidden />
              Single sign-on (OIDC)
            </span>
            <Toggle checked={form.oidcEnabled} onChange={(v) => updateField('oidcEnabled', v)} />
          </div>
          <p className="mt-1 text-[11px] text-text-muted">
            Adds a sign-in button to the registry&rsquo;s web UI. Users above keep working — zot has no
            account list, so an SSO login and an htpasswd user are the same person only when the
            username claim below matches the username. <code>docker login</code> cannot use SSO;
            it needs a password from the table above, or an API key minted in the web UI.
          </p>
          {form.oidcEnabled && (
            <p className="mt-2 rounded-md bg-status-warning-soft px-2 py-1.5 text-[11px] text-text-secondary">
              zot performs OIDC discovery against the issuer <em>at startup</em>. If the provider is
              unreachable when this container starts, zot exits and the whole registry is down — not
              just SSO. Password auth only covers a provider that fails while zot is already running.
            </p>
          )}

          {form.oidcEnabled && (
            <div className="mt-3 space-y-3">
              <div className="flex items-end gap-3 flex-wrap">
                <div className="min-w-[180px] flex-[2]">
                  <label className={labelClass} htmlFor="zot-oidc-issuer">Issuer URL</label>
                  <input
                    id="zot-oidc-issuer"
                    type="text"
                    className="input-field"
                    placeholder="https://id.example.com"
                    value={form.oidcIssuer}
                    onChange={(e) => updateField('oidcIssuer', e.target.value)}
                  />
                </div>
                <div className="min-w-[120px] flex-1">
                  <label className={labelClass} htmlFor="zot-oidc-name">Button label</label>
                  <input
                    id="zot-oidc-name"
                    type="text"
                    className="input-field"
                    placeholder="SSO"
                    value={form.oidcName}
                    onChange={(e) => updateField('oidcName', e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-end gap-3 flex-wrap">
                <div className="min-w-[140px] flex-1">
                  <label className={labelClass} htmlFor="zot-oidc-client-id">Client ID</label>
                  <input
                    id="zot-oidc-client-id"
                    type="text"
                    className="input-field"
                    placeholder="zot-registry"
                    value={form.oidcClientId}
                    onChange={(e) => updateField('oidcClientId', e.target.value)}
                  />
                </div>
                <div className="min-w-[160px] flex-1">
                  <label className={labelClass} htmlFor="zot-oidc-client-secret">Client secret</label>
                  <div className="flex items-stretch gap-2">
                    <input
                      id="zot-oidc-client-secret"
                      type={showSecret ? 'text' : 'password'}
                      className="input-field flex-1"
                      placeholder={form.oidcSecretIsSet && !form.oidcSecretDirty ? 'Set (leave empty to keep)' : 'client secret'}
                      value={form.oidcClientSecret}
                      onChange={(e) => {
                        updateField('oidcClientSecret', e.target.value);
                        updateField('oidcSecretDirty', true);
                      }}
                    />
                    <button
                      type="button"
                      className={iconBtn}
                      onClick={() => setShowSecret((v) => !v)}
                      title={showSecret ? 'Hide secret' : 'Show secret'}
                      aria-label={showSecret ? 'Hide client secret' : 'Show client secret'}
                    >
                      {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-end gap-3 flex-wrap">
                <div className="min-w-[160px] flex-1">
                  <label className={labelClass} htmlFor="zot-oidc-claim">Username claim</label>
                  <select
                    id="zot-oidc-claim"
                    className="input-field"
                    value={form.oidcUsernameClaim}
                    onChange={(e) => updateField('oidcUsernameClaim', e.target.value)}
                  >
                    {USERNAME_CLAIMS.map((claim) => (
                      <option key={claim} value={claim}>{claim}</option>
                    ))}
                  </select>
                </div>
                <div className="min-w-[180px] flex-[2]">
                  <label className={labelClass} htmlFor="zot-oidc-scopes">Scopes</label>
                  <input
                    id="zot-oidc-scopes"
                    type="text"
                    className="input-field"
                    placeholder={DEFAULT_SCOPES}
                    value={form.oidcScopes}
                    onChange={(e) => updateField('oidcScopes', e.target.value)}
                  />
                </div>
              </div>

              <p className="text-[11px] text-text-muted">
                Register this redirect URI with your provider:{' '}
                {callbackUrl
                  ? <code className="text-text-secondary">{callbackUrl}</code>
                  : <span>set an External URL above to see it.</span>}
              </p>
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
