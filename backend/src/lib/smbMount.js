/**
 * SMB mount helpers (Linux wisp-smb) vs stub (macOS dev).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/smbMount.js' : './darwin/host/smbMount.js',
);

export const mountSMB = impl.mountSMB;
export const checkSMBConnection = impl.checkSMBConnection;
export const unmountSMB = impl.unmountSMB;
export const getMountStatus = impl.getMountStatus;
