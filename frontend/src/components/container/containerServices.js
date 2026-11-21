import { rowId } from '../../hooks/formState.js';
import { KNOWN_SERVICE_TYPES, DEFAULT_TXT_FOR_TYPE, isValidServiceType, parsePortLabel, suggestTypeForPort } from '../../lib/mdnsServiceTypes.js';

/**
 * The services a container announces under its local name, pure: what a row says, the
 * ports the Add form offers, and the service editor's values.
 */

export const CUSTOM_TYPE = '__custom__';
export const OTHER_PORT = '__other__';

/** What a service's type says on the page: its catalog name, or the type itself. */
export const serviceTypeText = (type) => KNOWN_SERVICE_TYPES.find((k) => k.type === type)?.label ?? type;

/** The image's exposed ports that no service announces yet, in the image's order. */
export function unannouncedPorts(exposedPorts, services) {
  const taken = new Set((services ?? []).map((s) => s.port));
  const out = [];
  for (const label of exposedPorts ?? []) {
    const port = parsePortLabel(label);
    if (port != null && !taken.has(port) && !out.includes(port)) out.push(port);
  }
  return out;
}

/** TXT records as the editor's rows, each with an id of its own (never sent). */
const txtRows = (txt) => Object.entries(txt ?? {}).map(([k, v]) => ({ id: rowId(), k, v: String(v) }));

/** A type's choice in the editor, and its TXT records: a known type pre-fills its defaults. */
function typeChoice(type) {
  const known = KNOWN_SERVICE_TYPES.some((k) => k.type === type);
  return { typeSelect: known ? type : CUSTOM_TYPE, customType: known ? '' : type };
}

/** The editor's values for `service` (none: a new one, its port the first offered). */
export function serviceForm(service, offeredPorts) {
  if (service) return { portChoice: String(service.port), port: String(service.port), ...typeChoice(service.type), txt: txtRows(service.txt) };
  const first = offeredPorts[0];
  const type = (first != null && suggestTypeForPort(first)) || '_http._tcp';
  return {
    portChoice: first != null ? String(first) : OTHER_PORT,
    port: first != null ? String(first) : '',
    ...typeChoice(type),
    txt: txtRows(DEFAULT_TXT_FOR_TYPE[type]),
  };
}

/** The values once a port is picked: a suggested type replaces the type while the TXT
 *  records are the old type's defaults (none were typed). */
export function withPortChoice(form, choice) {
  const port = choice === OTHER_PORT ? '' : choice;
  const suggested = suggestTypeForPort(Number(port));
  if (!suggested) return { ...form, portChoice: choice, port };
  return withType({ ...form, portChoice: choice, port }, suggested);
}

/** The values once a type is picked: its TXT defaults replace records left empty. */
export function withType(form, typeSelect) {
  if (typeSelect === CUSTOM_TYPE) return { ...form, typeSelect };
  const txt = form.txt.length === 0 ? txtRows(DEFAULT_TXT_FOR_TYPE[typeSelect]) : form.txt;
  return { ...form, typeSelect, customType: '', txt };
}

/** What Save sends: the port, the type, the TXT records with a key. */
export function serviceSent(form) {
  const txt = {};
  for (const { k, v } of form.txt) {
    const key = k.trim();
    if (key) txt[key] = v ?? '';
  }
  return {
    port: Number.parseInt(form.port, 10),
    type: form.typeSelect === CUSTOM_TYPE ? form.customType.trim() : form.typeSelect,
    txt,
  };
}

/** Why the values cannot be saved (`taken`: the ports other services announce), or null. */
export function serviceProblem(form, taken) {
  const { port, type } = serviceSent(form);
  if (!Number.isInteger(port) || String(port) !== form.port.trim() || port < 1 || port > 65535) {
    return 'The port is a whole number from 1 to 65535.';
  }
  if (taken.includes(port)) return `Port ${port} is announced already.`;
  if (!isValidServiceType(type)) return 'The type looks like _name._tcp or _name._udp.';
  return null;
}
