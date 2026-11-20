/**
 * Wisp publishes no `.local` name for a VM since 2026-11-20, and its Local DNS
 * pref went with the setting: this removes the `wisp:localDns` child an
 * earlier release wrote into every VM's saved definition (and wisp:prefs, or
 * an emptied <metadata>, once no pref is left), through
 * `vmManager.removeVMPref`. Metadata only, so no VM gets the restart flag.
 *
 * Backward-compatible: the previous release reads a VM without the pref as
 * Local DNS off. Idempotent: a VM without the pref is left alone.
 */
export const id = '0011-vm-local-dns-pref';
export const description = 'VM definitions: the retired wisp:localDns pref removed';

export async function run(ctx) {
  const vms = await ctx.vmManager.listVMs();
  for (const vm of vms) {
    const { changed } = await ctx.vmManager.removeVMPref(vm.name, 'localDns');
    if (changed) ctx.recordChange(`${vm.name}: wisp:localDns removed`);
  }
}
