/**
 * Reboot-required stub for macOS dev. Linux-only signal.
 */
export async function getRebootSignal() {
  return { required: false, reasons: [] };
}
