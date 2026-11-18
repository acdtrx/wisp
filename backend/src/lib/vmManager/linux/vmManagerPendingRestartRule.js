/**
 * The restart-required rule: the flag still in force — `{ since }` or null.
 * `startedAt` is the QEMU process's start time (epoch ms), null when not
 * running or unreadable. A flag QEMU started after is no longer in force; a
 * stopped VM, or one whose start time can't be read, keeps its flag. Pure:
 * reads apply it, and vmManagerPendingRestart's `clearOutgrownRestartFlag`
 * drops the stored flag.
 */
export function pendingRestartInForce(pendingRestart, startedAt) {
  if (!pendingRestart) return null;
  if (startedAt == null || !(startedAt > Date.parse(pendingRestart.since))) return pendingRestart;
  return null;
}
