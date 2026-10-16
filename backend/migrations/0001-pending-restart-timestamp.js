/**
 * Containers' restart-required flag moves from `pendingRestart: true` to
 * `pendingRestart: { since }` (when the change was saved), so the flag can be
 * judged against the task's real start time. A `true` becomes `since = now`:
 * a running container started before now and stays flagged until its next
 * start; a stopped one clears on its next start — what `true` meant.
 *
 * Backward-compatible: the previous release only tests the flag for
 * truthiness (badges) and overwrites or deletes it on its own writes, so
 * `{ since }` reads as "restart required" there too. Idempotent: a container
 * without `pendingRestart: true` is left alone.
 */
export const id = '0001-pending-restart-timestamp';
export const description = 'Container restart-required flag: pendingRestart true → { since }';

export async function run(ctx) {
  const containers = await ctx.containerManager.listContainers();
  for (const { name } of containers) {
    const config = await ctx.containerManager.getContainerConfig(name);
    if (config.pendingRestart !== true) continue;
    ctx.recordChange(`${name}: pendingRestart true → { since: now }`);
    if (!ctx.dryRun) await ctx.setContainerPendingRestart(name, true);
  }
}
