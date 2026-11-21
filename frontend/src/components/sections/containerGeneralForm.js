import { formatCommandLine, parseCommandLine } from '../../utils/commandLine.js';

/**
 * The container General section's form (useForm): its values from a container's
 * config, what Save sends for them, and what keeps them from being saved. Each is pure
 * and total: text that does not parse is sent as typed (so the form is dirty) and its
 * problem shown beside the field, blocking Save.
 */

/** The section's values from a container's config. */
export function containerGeneralForm(config) {
  return {
    name: config.name || '',
    image: config.image || '',
    /* A stored entry that is no string shows as its text: the form never throws. */
    command: formatCommandLine(Array.isArray(config.command) ? config.command.map((arg) => String(arg ?? '')) : null),
    cpuLimit: config.cpuLimit ?? '',
    memoryLimitMiB: config.memoryLimitMiB ?? '',
    restartPolicy: config.restartPolicy || 'unless-stopped',
    autostart: config.autostart ?? false,
    autoBackup: config.autoBackup ?? false,
    runAsRoot: config.runAsRoot ?? false,
    localDns: config.localDns === true,
  };
}

/** The command's argv, or why the text does not parse. */
function readCommand(text) {
  try {
    return { argv: parseCommandLine(text ?? '') };
  } catch (err) {
    return { problem: err.message };
  }
}

const blank = (value) => value === '' || value == null;
const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const isWholePositive = (value) => isPositive(value) && Number.isInteger(Number(value));

/** What Save sends: the name trimmed, the command as its argv (a re-quoted but identical
 *  command is no change; none: null), the limits as numbers (none: null). */
export function containerGeneralSent(form) {
  const command = readCommand(form.command);
  return {
    name: (form.name ?? '').trim(),
    image: form.image,
    command: command.problem ? form.command : (command.argv.length ? command.argv : null),
    cpuLimit: blank(form.cpuLimit) ? null : (isPositive(form.cpuLimit) ? Number(form.cpuLimit) : String(form.cpuLimit)),
    memoryLimitMiB: blank(form.memoryLimitMiB) ? null
      : (isWholePositive(form.memoryLimitMiB) ? Number(form.memoryLimitMiB) : String(form.memoryLimitMiB)),
    restartPolicy: form.restartPolicy,
    autostart: form.autostart,
    autoBackup: form.autoBackup,
    runAsRoot: form.runAsRoot,
    localDns: form.localDns,
  };
}

/** What keeps the values from being saved, by field (none: an empty object). */
export function containerGeneralProblems(form) {
  const problems = {};
  if ((form.name ?? '').trim() === '') problems.name = 'Name is required';
  const command = readCommand(form.command);
  if (command.problem) problems.command = command.problem;
  if (!blank(form.cpuLimit) && !isPositive(form.cpuLimit)) problems.cpuLimit = 'CPU must be a number above 0';
  if (!blank(form.memoryLimitMiB) && !isWholePositive(form.memoryLimitMiB)) problems.memoryLimitMiB = 'RAM must be a whole number of MiB above 0';
  return problems;
}
