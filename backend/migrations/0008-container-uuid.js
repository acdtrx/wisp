/**
 * Every container gets a stable identity of its own: `container.json` `uuid`, a
 * random UUID. Since 2026-11-16 create and restore-as-new make one and a rename keeps
 * it, so a client can follow a container renamed in another tab, as it follows a VM's
 * libvirt uuid. Containers created earlier have none; this gives each one, through
 * containerManager's own read and write (as 0007 does).
 *
 * A uuid two containers share gets replaced in all but the first (in list order):
 * after a rollback, the previous release restores a backup as a new container with
 * the archive's `container.json` as it is, uuid included.
 *
 * Backward-compatible: the previous release reads `container.json` as plain JSON
 * (`readContainerConfig`) and keeps the fields it doesn't know through its edits and
 * its rename. A rollback reverts the ledger, so this runs again on the next update.
 * Idempotent: containers with a uuid of their own are left alone.
 */
import { randomUUID } from 'node:crypto';

export const id = '0008-container-uuid';
export const description = 'Every container.json carries a uuid of its own';

export async function run(ctx) {
  const cm = ctx.containerManager;
  const seen = new Set();
  for (const { name } of await cm.listContainers()) {
    const config = await cm.readContainerConfig(name);
    const current = typeof config.uuid === 'string' && config.uuid !== '' ? config.uuid : null;
    if (current && !seen.has(current)) {
      seen.add(current);
      continue;
    }
    const uuid = randomUUID();
    seen.add(uuid);
    ctx.recordChange(`${name}: uuid ${current ? `${current} (shared) → ` : ''}${uuid}`);
    if (ctx.dryRun) continue;
    config.uuid = uuid;
    await cm.writeContainerConfig(name, config);
  }
}
