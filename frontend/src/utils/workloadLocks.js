/**
 * When a workload's settings are locked: one rule per kind, the UI's (stated by the user,
 * 2026-11-21). Every section that edits a kind uses its rule for every field and control
 * that needs the workload offline; what works on a running workload (a VM's CD-ROM
 * hot-plug) is not locked.
 */

/** A VM: its name, CPU and RAM, the Advanced offline-only fields, its disks and its NICs
 *  are editable only when it is shut off. */
export const vmLocked = (state) => state !== 'shutoff';
