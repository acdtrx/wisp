import { useState, useEffect } from 'react';
import { ShieldCheck, Copy, Check } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import { useSettingsStore } from '../../store/settingsStore.js';
import { updateSettings } from '../../api/settings.js';

const HELP =
  'Single sign-on via OpenID Connect (e.g. Pocket ID). Wisp stays single-user — a ' +
  'successful SSO login is treated like the password. Restrict who can sign in from ' +
  'your provider (limit this client to your user/group). The password remains as a backup.';

export default function OidcSettings() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const setSettings = useSettingsStore((s) => s.setSettings);

  const oidc = settings?.oidc;

  const [enabled, setEnabled] = useState(false);
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (oidc) {
      setEnabled(oidc.enabled === true);
      setIssuer(oidc.issuer || '');
      setClientId(oidc.clientId || '');
      setHasSecret(!!oidc.hasClientSecret);
      setClientSecret('');
    }
  }, [oidc]);

  useEffect(() => {
    if (!oidc) { setDirty(false); return; }
    setDirty(
      enabled !== (oidc.enabled === true) ||
      issuer !== (oidc.issuer || '') ||
      clientId !== (oidc.clientId || '') ||
      clientSecret !== '',
    );
  }, [oidc, enabled, issuer, clientId, clientSecret]);

  // Full URL to register as the redirect/callback in the provider. Derived from
  // how the admin is reaching Wisp right now — the same origin the backend sees.
  const redirectUri =
    typeof window !== 'undefined' ? `${window.location.origin}/api/auth/oidc/callback` : '';

  const copyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context) — the field is selectable anyway */
    }
  };

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const oidcUpdate = {
        enabled,
        issuer: issuer.trim(),
        clientId: clientId.trim(),
      };
      // Only send the secret when the admin typed a new one — an empty field
      // keeps the saved secret (the API never returns it to echo back).
      if (clientSecret) oidcUpdate.clientSecret = clientSecret;

      const updated = await updateSettings({ oidc: oidcUpdate });
      setSettings(updated);
      await loadSettings();
      setClientSecret('');
      setDirty(false);
    } catch (err) {
      setError(err.detail || err.message || 'Failed to save SSO settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Single sign-on (SSO)"
      titleIcon={<ShieldCheck size={14} />}
      helpText={HELP}
      onSave={handleSave}
      saving={saving}
      isDirty={dirty}
      error={error}
    >
      <div className="max-w-xl space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Enable SSO
            </label>
            <p className="mt-0.5 text-[10px] text-text-muted">
              When on, the login page offers (and jumps straight to) your provider.
            </p>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>

        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Issuer URL
          </label>
          <input
            type="text"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            placeholder="https://id.example.com"
            className="input-field font-mono placeholder:text-text-muted"
          />
          <p className="mt-1 text-[10px] text-text-muted">
            Base URL of your OIDC provider (its <span className="font-mono">/.well-known/openid-configuration</span> is discovered automatically).
          </p>
        </div>

        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Client ID
          </label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="wisp"
            className="input-field font-mono placeholder:text-text-muted"
          />
        </div>

        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Client secret
          </label>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={hasSecret ? '•••••••• (saved — leave blank to keep)' : 'Client secret'}
            autoComplete="new-password"
            className="input-field font-mono placeholder:text-text-muted"
          />
        </div>

        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Redirect URI
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={redirectUri}
              readOnly
              onFocus={(e) => e.target.select()}
              className="input-field font-mono text-text-secondary"
            />
            <button
              type="button"
              onClick={copyRedirect}
              title="Copy redirect URI"
              aria-label="Copy redirect URI"
              className="flex h-[34px] shrink-0 items-center gap-1 rounded-md border border-surface-border bg-surface px-2.5 text-xs text-text-secondary hover:bg-surface-sidebar transition-colors duration-150"
            >
              {copied ? <Check size={14} className="text-status-running" /> : <Copy size={14} />}
            </button>
          </div>
          <p className="mt-1 text-[10px] text-text-muted">
            Register this exact URL as the allowed redirect/callback in your provider.
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
