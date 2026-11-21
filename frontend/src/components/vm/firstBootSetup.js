/**
 * First boot setup (cloud-init) as the VM page shows and edits it, pure. The record is
 * `GET /api/vms/:name/cloudinit`: `{ enabled: false }` alone when nothing is stored, the
 * stored config otherwise (`password` is `"set"` or ""). Save always turns the setup on:
 * Remove is the way off.
 */

/** The stored setup, or null when none is (the read's placeholder). */
export function storedSetup(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.enabled === false && Object.keys(data).length === 1) return null;
  return data;
}

/** The form for the stored setup (none: what setting one up starts from). The host name
 *  is empty for "the VM's name"; the password is empty for "keep the stored one". The
 *  SSH keys are picked apart from it (sshKeyChoice.js). */
export function setupForm(stored) {
  return {
    hostname: stored?.hostname ?? '',
    username: stored?.username || 'wisp',
    password: '',
    packageUpgrade: stored?.packageUpgrade ?? false,
    growPartition: stored?.growPartition ?? true,
    installQemuGuestAgent: stored?.installQemuGuestAgent ?? true,
    installAvahiDaemon: stored?.installAvahiDaemon ?? true,
  };
}

/** What Save sends (`PUT`): on, the host name the VM's name when empty, a password
 *  only when typed ("set" keeps the stored one, "" means none), and `sshKey` the keys
 *  picked, one per line. */
export function setupSent(form, stored, vmName, sshKey) {
  return {
    enabled: true,
    hostname: form.hostname.trim() || vmName,
    username: form.username.trim(),
    password: form.password || (stored?.password === 'set' ? 'set' : ''),
    sshKey,
    growPartition: form.growPartition,
    packageUpgrade: form.packageUpgrade,
    installQemuGuestAgent: form.installQemuGuestAgent,
    installAvahiDaemon: form.installAvahiDaemon,
  };
}

const HOSTNAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const USERNAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** Why the setup cannot be saved, or null: the server's rules for the host name (the
 *  VM's name when the field is empty) and the user. */
export function setupProblem(form, vmName) {
  const hostname = form.hostname.trim() || vmName;
  if (!HOSTNAME.test(hostname)) {
    return form.hostname.trim()
      ? 'The host name is up to 63 letters, digits and dashes.'
      : `The VM's name, ${vmName}, is no host name: type one (up to 63 letters, digits and dashes).`;
  }
  if (!USERNAME.test(form.username.trim())) return 'The user starts with a lowercase letter, then lowercase letters, digits, dashes or underscores.';
  return null;
}

/** What else the setup does at first boot, in words (none: null). */
export function extrasText(stored) {
  const extras = [
    stored.growPartition !== false ? 'grows the disk' : null,
    stored.installQemuGuestAgent !== false ? 'installs the guest agent' : null,
    stored.installAvahiDaemon !== false ? 'installs avahi' : null,
  ].filter(Boolean);
  return extras.length ? extras.join(', ') : null;
}
