import { api } from './client.js';

export function changePassword(currentPassword, newPassword) {
  return api('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}
