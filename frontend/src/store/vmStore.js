import * as vmApi from '../api/vms.js';
import { CHANGE_KIND, TOPIC } from '../../../shared/wireNames.js';
import { createWorkloadStore } from './workloadStore.js';

const vms = createWorkloadStore({
  noun: 'VM',
  listTopic: TOPIC.VMS,
  changeKind: CHANGE_KIND.VM,
  get: (name) => vmApi.getVM(name),
  seed: (item) => ({
    name: item.name, uuid: item.uuid, state: item.state, stateCode: item.stateCode, vcpus: item.vcpus,
    memoryMiB: item.memoryMiB, osCategory: item.osCategory, iconId: item.iconId, pendingRestart: item.pendingRestart ?? null,
  }),
  /* The list refreshes on every libvirt domain event, so it carries the run state and
   * the restart-required flag ahead of any re-read (the flag is dropped by the list
   * refresh that observes the new QEMU). */
  listFields: ['state', 'pendingRestart'],
  statsUrl: (name) => `/api/vms/${encodeURIComponent(name)}/stats`,
  commands: ({ job, atAck, untilListLeaves }) => ({
    startVM: (name) => job(name, 'start', () => vmApi.startVM(name)),
    /* Stop (an ACPI shutdown) and reboot are requests the guest may ignore, so they
     * end at the ack: the list shows the VM stopping when it does. */
    stopVM: (name) => atAck(name, 'stop', () => vmApi.stopVM(name)),
    forceStopVM: (name) => job(name, 'force-stop', () => vmApi.forceStopVM(name)),
    rebootVM: (name) => atAck(name, 'reboot', () => vmApi.rebootVM(name)),
    /* Suspend and resume stay busy until the list shows the VM out of the state it was in. */
    suspendVM: (name) => untilListLeaves(name, 'suspend', 'running', () => vmApi.suspendVM(name)),
    resumeVM: (name) => untilListLeaves(name, 'resume', 'paused', () => vmApi.resumeVM(name)),
    deleteVM: (name, deleteDisks) => job(name, 'delete', () => vmApi.deleteVM(name, deleteDisks)),
  }),
});

/** The VMs (`data`: the `vms` topic's list), the selected VM's config, and the VM commands. */
export const useVmStore = vms.useStore;

/** The selected VM's stats, from its scoped stream. */
export const useVmStatsStore = vms.useStatsStore;

/** Send a command that changes VM `name` and resolve once its new state is shown (workloadStore.js). */
export const runVMCommand = vms.runCommand;
