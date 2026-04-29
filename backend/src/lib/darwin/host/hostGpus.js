/**
 * macOS dev stub for host GPU enumeration. There is no /dev/dri here and
 * containerd is unavailable on darwin builds anyway, so always return an empty
 * list — the UI surfaces "no GPUs" gracefully.
 */
export async function listHostGpus() {
  return [];
}
