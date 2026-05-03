/**
 * SMART summaries (macOS dev): no-op stub. wisp-smartctl is Linux-only.
 */

export async function readDiskSmartSummary() {
  return null;
}

export async function readAllDiskSmartSummaries() {
  return [];
}
