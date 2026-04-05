import { useState } from 'react';
import { Loader2, Key } from 'lucide-react';
import { changePassword } from '../../api/auth.js';

export default function PasswordChangeForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 1) {
      setError('New password cannot be empty');
      return;
    }
    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err.message || 'Failed to change password');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h4 className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-3">
        Change password
      </h4>
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
        {error && (
          <p className="text-sm text-status-stopped">{error}</p>
        )}
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
