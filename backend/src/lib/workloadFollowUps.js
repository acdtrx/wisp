/**
 * What a rename, a delete and a configuration update of a workload change
 * outside the workload's own record (app glue): for VMs and containers alike,
 * the sidebar section assignment (lib/sections.js) and the last backup attempt
 * (lib/backupStatus.js); for a container, its `.local` name too
 * (lib/containerMdnsReconciler.js) — a VM announces its own. The operation
 * modules (lib/vmOperations.js, lib/containerOperations.js) call these once
 * the command itself has succeeded, under the workload's lock.
 *
 * Each follow-up is best effort: the command has already happened, so a
 * failed follow-up is logged and never fails it.
 */
import { renameWorkloadAssignment, removeWorkloadAssignment } from './sections.js';
import { moveBackupStatus, forgetBackupStatus } from './backupStatus.js';
import { publishContainer, unpublishContainer } from './containerMdnsReconciler.js';

/** @typedef {'vm' | 'container'} WorkloadType */

async function bestEffort(log, what, fields, fn) {
  try {
    await fn();
  } catch (err) {
    log.warn({ ...fields, err: err?.message ?? String(err) }, `Workload follow-up failed: ${what}`);
  }
}

/**
 * After a rename of a workload from `from` to `to`: the section assignment
 * and the last backup attempt move to the new name. A container's old `.local`
 * name is withdrawn and the new one published — a no-op until it runs (a
 * rename needs it stopped), after which the network-change event publishes it.
 *
 * @param {{ type: WorkloadType, from: string, to: string,
 *           log: import('fastify').FastifyBaseLogger }} opts
 */
export async function followWorkloadRename({ type, from, to, log }) {
  const fields = { type, name: to, previousName: from };
  await bestEffort(log, 'section assignment move', fields, () => renameWorkloadAssignment(type, from, to));
  await bestEffort(log, 'backup status move', fields, () => moveBackupStatus({ type, from, to }));
  if (type !== 'container') return;
  await bestEffort(log, '.local name withdrawal', fields, () => unpublishContainer(from));
  await bestEffort(log, '.local name publish', fields, () => publishContainer(to));
}

/**
 * After a configuration update of a container: a `localDns` toggle
 * (re)publishes or withdraws its `.local` name — it is metadata, so no
 * network-change event follows it.
 *
 * @param {{ name: string, localDns?: boolean,
 *           log: import('fastify').FastifyBaseLogger }} opts
 */
export async function followContainerConfigUpdate({ name, localDns, log }) {
  const fields = { type: 'container', name };
  if (localDns === false) {
    await bestEffort(log, '.local name withdrawal', fields, () => unpublishContainer(name));
  } else if (localDns === true) {
    await bestEffort(log, '.local name publish', fields, () => publishContainer(name));
  }
}

/**
 * After a workload was deleted: a container's `.local` name is withdrawn (its
 * teardown already fired the network-change event that does it; this covers
 * one that did not run), and the last backup attempt and section assignment
 * are removed, so neither lingers nor lands on a later workload of that name.
 *
 * @param {{ type: WorkloadType, name: string, log: import('fastify').FastifyBaseLogger }} opts
 */
export async function followWorkloadDelete({ type, name, log }) {
  const fields = { type, name };
  if (type === 'container') {
    await bestEffort(log, '.local name withdrawal', fields, () => unpublishContainer(name));
  }
  await bestEffort(log, 'backup status removal', fields, () => forgetBackupStatus({ type, name }));
  await bestEffort(log, 'section assignment removal', fields, () => removeWorkloadAssignment(type, name));
}
