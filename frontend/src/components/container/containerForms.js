import { formatCommandLine, parseCommandLine } from '../../utils/commandLine.js';

/**
 * The container page's group editors, pure: each group's values from the container's
 * config, what its Save sends for them, and what keeps them from being saved. A form
 * sends only the fields that changed (`changedFields`): an unchanged limit sent to a
 * running container would still mark it "Restart to apply".
 */

export const RESTART_POLICIES = [
  { value: 'unless-stopped', label: 'Unless I stopped it' },
  { value: 'always', label: 'Always' },
  { value: 'on-failure', label: 'After a failure' },
  { value: 'never', label: 'Never' },
];

/** What a restart policy says on the page. */
export const restartPolicyText = (policy) => RESTART_POLICIES.find((p) => p.value === policy)?.label ?? 'Unless I stopped it';

const blank = (value) => value === '' || value == null;
const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const isWholePositive = (value) => isPositive(value) && Number.isInteger(Number(value));

/* ---- Limits and restarts ---- */

export function limitsForm(config) {
  return {
    cpuLimit: config.cpuLimit == null ? '' : String(config.cpuLimit),
    memoryLimitMiB: config.memoryLimitMiB == null ? '' : String(config.memoryLimitMiB),
    restartPolicy: config.restartPolicy || 'unless-stopped',
  };
}

/** The limits as numbers (none: null); a value that is no limit is sent as typed, and
 *  is a problem. */
export function limitsSent(form) {
  return {
    cpuLimit: blank(form.cpuLimit) ? null : (isPositive(form.cpuLimit) ? Number(form.cpuLimit) : String(form.cpuLimit)),
    memoryLimitMiB: blank(form.memoryLimitMiB) ? null
      : (isWholePositive(form.memoryLimitMiB) ? Number(form.memoryLimitMiB) : String(form.memoryLimitMiB)),
    restartPolicy: form.restartPolicy,
  };
}

export function limitsProblems(form) {
  const problems = {};
  if (!blank(form.cpuLimit) && !isPositive(form.cpuLimit)) problems.cpuLimit = 'A CPU limit is a number of cores above 0.';
  if (!blank(form.memoryLimitMiB) && !isWholePositive(form.memoryLimitMiB)) {
    problems.memoryLimitMiB = 'A memory limit is a whole number of MiB above 0.';
  }
  return problems;
}

/* ---- Advanced ---- */

/** The command as one line of shell-style quoting; a stored entry that is no string
 *  shows as its text, so the form never throws. */
export function advancedForm(config) {
  const gpu = (Array.isArray(config.devices) ? config.devices : []).find((d) => d?.type === 'gpu') ?? null;
  return {
    command: formatCommandLine(Array.isArray(config.command) ? config.command.map((arg) => String(arg ?? '')) : null),
    runAsRoot: config.runAsRoot === true,
    gpu: gpu?.device ?? '',
  };
}

function readCommand(text) {
  try {
    return { argv: parseCommandLine(text ?? '') };
  } catch (err) {
    return { problem: err.message };
  }
}

/** The command as its argv (a re-quoted identical command is no change; none: null),
 *  the GPU as the device list. A command that does not parse is sent as typed. */
export function advancedSent(form) {
  const command = readCommand(form.command);
  return {
    command: command.problem ? form.command : (command.argv.length ? command.argv : null),
    runAsRoot: form.runAsRoot,
    devices: form.gpu ? [{ type: 'gpu', device: form.gpu }] : [],
  };
}

export function advancedProblems(form) {
  const command = readCommand(form.command);
  return command.problem ? { command: command.problem } : {};
}

/* ---- Network ---- */

export const networkForm = (config) => ({ interface: config.network?.interface || '', mac: config.network?.mac || '' });

/** The MAC trimmed and in lower case, the bridge (none: null). */
export const networkSent = (form) => ({ interface: form.interface.trim() || null, mac: form.mac.trim().toLowerCase() });

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

export function networkProblems(form) {
  return MAC.test(form.mac.trim()) ? {} : { mac: 'A MAC address is six pairs of hex digits, like 52:54:00:12:34:56.' };
}

/* ---- Image ---- */

export const imageProblems = (form) => (form.image.trim() === '' ? { image: 'An image is required.' } : {});
