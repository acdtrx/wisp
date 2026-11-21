import { useState } from 'react';
import { ShieldCheck, Copy, Check } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import { updateOidcSettings } from '../../api/settings.js';
import RecordGate from '../shared/RecordGate.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useForm } from '../../hooks/useForm.js';
import { errorText } from '../../api/errors.js';
import { sendAndAwaitKindChange } from '../../api/events.js';
import { CHANGE_KIND } from '../../../../shared/wireNames.js';

const HELP =
  'Single sign-on via OpenID Connect (e.g. Pocket ID). Wisp stays single-user — a ' +
  'successful SSO login is treated like the password. Restrict who can sign in from ' +
  'your provider (limit this client to your user/group). The password remains as a backup.';

/* The client secret is write-only: never read back, so its saved value is empty. */
const formFromSettings = (settings) => ({
  enabled: settings.oidc.enabled === true,
  issuer: settings.oidc.issuer || '',
  clientId: settings.oidc.clientId || '',
  clientSecret: '',
});

export default function OidcSettings() {
  const settingsRecord = useRecord(RECORD.SETTINGS);
  const settings = settingsRecord.data;
  const { form, saved, setField, dirty, save } = useForm(settings, formFromSettings);
  const hasSecret = !!settings?.oidc?.hasClientSecret;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const enabled = form?.enabled ?? false;
  const issuer = form?.issuer ?? '';
  const clientId = form?.clientId ?? '';
  const clientSecret = form?.clientSecret ?? '';

  // Full URL to register as the redirect/callback in the provider — the same
  // one the backend sends: the advertised URL's origin when set, else the
  // origin the admin is reaching Wisp on right now.
  const advertisedUrl = settings?.advertisedUrl;
  // The saved secret belongs to the saved issuer + client; the backend refuses
  // to reuse it for a different one, so a changed identity needs it re-entered.
  const secretRequired =
    hasSecret &&
    !!issuer.trim() &&
    !!clientId.trim() &&
    (issuer.trim() !== (saved?.issuer || '').trim() || clientId.trim() !== (saved?.clientId || '').trim());

  const redirectUri = advertisedUrl
    ? new URL('/api/auth/oidc/callback', advertisedUrl).href
    : `${window.location.origin}/api/auth/oidc/callback`;

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
    if (secretRequired && !clientSecret) {
      setError('Re-enter the client secret when changing the issuer or client ID');
      return;
    }
    setSaving(true);
    try {
      const oidcUpdate = {
        enabled,
        issuer: issuer.trim(),
        clientId: clientId.trim(),
      };
      // Only send the secret when the admin typed a new one — an empty field
      // keeps the saved secret (the API never returns it to echo back), as
      // long as issuer and client ID are unchanged.
      if (clientSecret) oidcUpdate.clientSecret = clientSecret;

      await save(() => sendAndAwaitKindChange(CHANGE_KIND.SETTINGS, () => updateOidcSettings(oidcUpdate)));
    } catch (err) {
      setError(errorText(err));
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
      <RecordGate record={settingsRecord} what="settings">
        {() => (
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
              <Toggle checked={enabled} onChange={(on) => setField('enabled', on)} />
            </div>

            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                Issuer URL
              </label>
              <input
                type="text"
                value={issuer}
                onChange={(e) => setField('issuer', e.target.value)}
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
                onChange={(e) => setField('clientId', e.target.value)}
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
                onChange={(e) => setField('clientSecret', e.target.value)}
                placeholder={
                  secretRequired
                    ? 'Required — re-enter for the new issuer / client ID'
                    : hasSecret ? '•••••••• (saved — leave blank to keep)' : 'Client secret'
                }
                autoComplete="new-password"
                required={secretRequired}
                aria-invalid={secretRequired && !clientSecret}
                className="input-field font-mono placeholder:text-text-muted"
              />
              {secretRequired && (
                <p className="mt-1 text-[10px] text-text-muted">
                  The saved secret is only kept for the same issuer and client ID.
                </p>
              )}
            </div>

            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                Redirect URI
              </label>
              <div className="flex items-center gap-2">
                {/* Read-only identity — muted summary box per FRONTEND-RULES § Modal form
                  * editor; wraps on phones where a single-line input truncated it. */}
                <div className="min-w-0 flex-1 select-all break-all rounded-md border border-surface-border bg-surface px-3 py-2 font-mono text-xs text-text-secondary">
                  {redirectUri}
                </div>
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
                {!advertisedUrl && ' Set the Advertised URL above to pin it when Wisp is reached under more than one address.'}
              </p>
            </div>
          </div>
        )}
      </RecordGate>
    </SectionCard>
  );
}
