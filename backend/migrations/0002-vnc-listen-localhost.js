/**
 * VM consoles listen on localhost only: QEMU's VNC/SPICE has no password, and
 * Wisp's console proxy connects to 127.0.0.1. Create and Graphics edits write
 * `listen='127.0.0.1'` since 2026-10-16; this brings every VM defined earlier
 * (or cloned/restored from one) to the same — the `listen` attribute and each
 * `<listen type='address'>` child of the saved definition. A running VM keeps
 * its current listener until its next full stop/start, so it gets the
 * restart-required flag.
 *
 * Backward-compatible: 127.0.0.1 is what the previous release writes itself.
 * Idempotent: a VM already on 127.0.0.1 everywhere is left alone.
 */
export const id = '0002-vnc-listen-localhost';
export const description = 'VM consoles (VNC/SPICE) listen on 127.0.0.1 only';

const LOCALHOST = '127.0.0.1';

export async function run(ctx) {
  const vms = await ctx.vmManager.listVMs();
  for (const vm of vms) {
    const listens = await ctx.vmManager.getGraphicsListen(vm.name);
    const stale = listens.filter((l) => l.address !== LOCALHOST);
    if (stale.length === 0) continue;
    const kinds = [...new Set(stale.map((l) => (l.graphics || 'graphics').toUpperCase()))].join('/');
    const from = [...new Set(stale.map((l) => l.address))].join(', ');
    const running = !ctx.vmManager.isOfflineState(vm.stateCode);
    ctx.recordChange(`${vm.name}: ${kinds} listen ${from} → ${LOCALHOST}${running ? ' (restart required)' : ''}`);
    if (ctx.dryRun) continue;
    await ctx.vmManager.setGraphicsListen(vm.name, LOCALHOST);
    if (running) await ctx.setVMPendingRestart(vm.name, true);
  }
}
