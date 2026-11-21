/**
 * A VM remembers its profile since 2026-11-21 (`wisp:profile` in its prefs): this gives
 * every VM defined before then the one its definition reads as, through
 * `vmManager.setMissingVMProfile` — `windows-11` when it carries the Hyper-V features,
 * `linux` otherwise. Metadata only, so no VM gets the restart flag. A transient domain
 * is left without one: defining it would make it persistent.
 *
 * Backward-compatible: the previous release ignores the pref. Idempotent: a VM with a
 * profile is left alone.
 */
export const id = '0012-vm-profile';
export const description = 'VM definitions: each VM given the profile its definition reads as';

export async function run(ctx) {
  const vms = await ctx.vmManager.listVMs();
  for (const vm of vms) {
    const { changed, profile } = await ctx.vmManager.setMissingVMProfile(vm.name);
    if (changed) ctx.recordChange(`${vm.name}: profile ${profile}`);
  }
}
