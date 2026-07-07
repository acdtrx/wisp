import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, LogIn } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { getOidcStatus, OIDC_LOGIN_URL } from '../api/auth';
import WispGlyph from '../components/shared/WispGlyph.jsx';

// Messages shown when the browser returns from an SSO attempt. The presence of
// the `?sso=` marker is also what stops the auto-redirect from looping.
const SSO_NOTICES = {
  cancelled: 'SSO sign-in was cancelled. Sign in with your password, or try SSO again.',
  error: 'SSO is unavailable right now. Sign in with your password.',
};

export default function Login() {
  const [password, setPassword] = useState('');
  const { login, loading, error } = useAuthStore();
  const navigate = useNavigate();

  // `checking` gates the first paint: while true we may still redirect to the
  // provider, so we show a spinner instead of flashing the password form.
  const [checking, setChecking] = useState(true);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [ssoNotice, setSsoNotice] = useState(null);

  useEffect(() => {
    const sso = new URLSearchParams(window.location.search).get('sso');
    if (sso && SSO_NOTICES[sso]) setSsoNotice(SSO_NOTICES[sso]);

    let cancelled = false;
    getOidcStatus().then((status) => {
      if (cancelled) return;
      const enabled = !!status.enabled;
      // Happy path: SSO configured and we're not returning from a failed/cancelled
      // attempt → bounce straight to the provider. Keep `checking` true so the
      // spinner stays up through the navigation.
      if (enabled && !sso) {
        window.location.href = OIDC_LOGIN_URL;
        return;
      }
      setOidcEnabled(enabled);
      setChecking(false);
    });
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const ok = await login(password);
    if (ok) navigate('/', { replace: true });
  };

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <Loader2 size={24} className="animate-spin text-text-muted" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface">
      <div className="w-full max-w-sm">
        <div className="rounded-card bg-surface-card p-8 shadow-card border border-surface-border">
          <div className="mb-6 text-center">
            <WispGlyph size={32} className="mx-auto mb-2" />
            <h1 className="font-display text-2xl font-semibold text-text-primary">Wisp</h1>
            <p className="mt-1 text-sm text-text-secondary">Sign in to manage your server</p>
          </div>

          {ssoNotice && (
            <p className="mb-4 rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-text-secondary">
              {ssoNotice}
            </p>
          )}

          <form onSubmit={handleSubmit}>
            <label htmlFor="password" className="block text-sm font-medium text-text-secondary mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              autoFocus
              className="input-field rounded-lg placeholder:text-text-muted focus:ring-1 focus:ring-accent"
            />

            {error && (
              <p className="mt-2 text-sm text-status-stopped">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="mt-4 w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {oidcEnabled && (
            <>
              <div className="my-4 flex items-center gap-3">
                <div className="h-px flex-1 bg-surface-border" />
                <span className="text-[11px] uppercase tracking-wider text-text-muted">or</span>
                <div className="h-px flex-1 bg-surface-border" />
              </div>
              <button
                type="button"
                onClick={() => { window.location.href = OIDC_LOGIN_URL; }}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-surface-border bg-surface px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-sidebar transition-colors duration-150"
              >
                <LogIn size={16} />
                Sign in with SSO
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
