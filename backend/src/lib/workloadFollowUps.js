/**
 * What a rename, a delete and a configuration update of a workload change
 * outside the workload's own record (app glue), written once for VMs and
 * containers: the sidebar section assignment (lib/sections.js), the last
 * backup attempt (lib/backupStatus.js) and the `.local` name (the mDNS
 * reconcilers). The operation modules (lib/vmOperations.js,
 * lib/containerOperations.js) call these once the command itself has
 * succeeded, under the workload's lock.
 *
 * Each follow-up is best effort: the command has already happened, so a
 * failed follow-up is logged and never fails it.
 */
import { renameWorkloadAssignment, removeWorkloadAssignment } from './sections.js';
import { moveBackupStatus, forgetBackupStatus } from './backupStatus.js';
import { publishVm, unpublishVm } from './vmMdnsReconciler.js';
import { publishContainer, unpublishContainer } from './containerMdnsReconciler.js';

/** @typedef {'vm' | 'container'} WorkloadType */

/** Each type's `.local` publisher: publish re-reads the workload, so it registers only what is reachable now. */
const LOCAL_NAME = {
  vm: { publish: publishVm, unpublish: unpublishVm },
  container: { publish: publishContainer, unpublish: unpublishContainer },
};

async function bestEffort(log, what, fields, fn) {
  try {
    await fn();
  } catch (err) {
    log.warn({ ...fields, err: err?.message ?? String(err) }, `Workload follow-up failed: ${what}`);
  }
}

/**
 * After a configuration update of a workload, under its name in effect
 * (`name`; `previousName` when the update renamed it).
 *
 * - A rename moves the section assignment and the last backup attempt to the
 *   new name, and withdraws the old `.local` name.
 * - A `localDns` toggle (re)publishes or withdraws the `.local` name: it is
 *   metadata, so no network-change event follows it. A renamed workload is
 *   published under its new name too — a no-op until it runs (a rename needs
 *   it stopped), after which the network-change event publishes it.
 *
 * @param {{ type: WorkloadType, name: string, previousName?: string | null,
 *           localDns?: boolean, log: import('fastify').FastifyBaseLogger }} opts
 */
export async function followWorkloadConfigUpdate({ type, name, previousName = null, localDns, log }) {
  const { publish, unpublish } = LOCAL_NAME[type];
  const fields = { type, name };
  if (previousName) {
    const renamed = { ...fields, previousName };
    await bestEffort(log, 'section assignment move', renamed, () => renameWorkloadAssignment(type, previousName, name));
    await bestEffort(log, 'backup status move', renamed, () => moveBackupStatus({ type, from: previousName, to: name }));
    await bestEffort(log, '.local name withdrawal', renamed, () => unpublish(previousName));
  }
  if (localDns === false) {
    await bestEffort(log, '.local name withdrawal', fields, () => unpublish(name));
  } else if (localDns === true || previousName) {
    await bestEffort(log, '.local name publish', fields, () => publish(name));
  }
}

/**
 * After a workload was deleted: its `.local` name is withdrawn (its teardown
 * already fired the network-change event that does it; this covers one that
 * did not run), and its last backup attempt and section assignment are
 * removed, so neither lingers nor lands on a later workload of that name.
 *
 * @param {{ type: WorkloadType, name: string, log: import('fastify').FastifyBaseLogger }} opts
 */
export async function followWorkloadDelete({ type, name, log }) {
  const fields = { type, name };
  await bestEffort(log, '.local name withdrawal', fields, () => LOCAL_NAME[type].unpublish(name));
  await bestEffort(log, 'backup status removal', fields, () => forgetBackupStatus({ type, name }));
  await bestEffort(log, 'section assignment removal', fields, () => removeWorkloadAssignment(type, name));
}
