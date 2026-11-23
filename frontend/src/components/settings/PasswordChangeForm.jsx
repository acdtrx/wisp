import { useState } from 'react';
import { Key } from 'lucide-react';

import { changePassword } from '../../api/auth.js';
import { useCommand } from '../../hooks/useCommand.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import Button from '../shared/Button.jsx';

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
        <Button
          variant="primary"
          size="md"
          type="submit"
          icon={Key}
          busy={saving}
          disabled={!currentPassword || !newPassword || !confirmPassword}
        >
          {saving ? 'Updating…' : 'Change password'}
        </Button>
      </form>
    </div>
  );
}
