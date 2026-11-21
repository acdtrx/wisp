import { useState } from 'react';
import { Loader2, Key } from 'lucide-react';
import { changePassword } from '../../api/auth.js';
import { useCommand } from '../../hooks/useCommand.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';

export default function PasswordChangeForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const change = useCommand();
  const saving = change.busy;
  const [success, setSuccess] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    setSuccess(false);
    if (newPassword !== confirmPassword) {
      change.fail('New passwords do not match');
      return;
    }
    if (newPassword.length < 1) {
      change.fail('New password cannot be empty');
      return;
    }
    change.run(() => changePassword(currentPassword, newPassword), {
      onDone: () => {
        setSuccess(true);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      },
    });
  };

  return (
    <div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Current password
          </label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="input-field"
            autoComplete="current-password"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            New password
          </label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="input-field"
            autoComplete="new-password"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
            Confirm new password
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="input-field"
            autoComplete="new-password"
          />
        </div>
        {success && (
          <p className="text-sm text-status-running">Password updated.</p>
        )}
        <ErrorBanner error={change.error} onDismiss={change.dismiss} />
        <button
          type="submit"
          disabled={saving || !currentPassword || !newPassword || !confirmPassword}
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors duration-150"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Key size={16} />}
          {saving ? 'Updating…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}
