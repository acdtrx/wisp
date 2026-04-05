import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

export default function Login() {
  const [password, setPassword] = useState('');
  const { login, loading, error } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    const ok = await login(password);
    if (ok) navigate('/', { replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface">
      <div className="w-full max-w-sm">
        <div className="rounded-card bg-surface-card p-8 shadow-card border border-surface-border">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-semibold text-text-primary">Wisp</h1>
            <p className="mt-1 text-sm text-text-secondary">Sign in to manage your VMs</p>
          </div>

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
        </div>
      </div>
    </div>
  );
}
