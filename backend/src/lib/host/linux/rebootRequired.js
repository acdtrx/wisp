/**
 * Host reboot-required signal. Wisp hosts run Debian or Ubuntu (setup refuses any
 * other): /var/run/reboot-required exists when a reboot is pending (created by
 * update-notifier-common on package upgrades), and /var/run/reboot-required.pkgs
 * lists the triggering packages, one per line.
 */
import { readFile, access } from 'node:fs/promises';

const REBOOT_MARKER = '/var/run/reboot-required';
const REBOOT_PKGS = '/var/run/reboot-required.pkgs';

/**
 * @returns {Promise<{ required: boolean, reasons: string[] }>}
 */
export async function getRebootSignal() {
  try {
    await access(REBOOT_MARKER);
  } catch {
    return { required: false, reasons: [] };
  }
  let reasons = [];
  try {
    const pkgs = await readFile(REBOOT_PKGS, 'utf8');
    reasons = pkgs.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    /* marker exists but pkgs file missing or unreadable — still flag as required */
  }
  return { required: true, reasons };
}
