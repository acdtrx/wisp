/**
 * A VM's SSH keys against Wisp's list (`GET /api/settings`'s `sshKeys`), pure. A VM
 * keeps its own copy of its keys, one per line of its first boot setup's `sshKey`; a
 * key is the list's when its type and data match (its comment may differ). A choice of
 * keys is the texts picked, in no order: `sshKeyText` puts the list's first, in the
 * list's order (docs/specs/UI-VM.md, First boot setup).
 */

/** A key's type and data: what two copies of the same key share. Null for no key. */
export function keyIdentity(text) {
  const [type, data] = String(text ?? '').trim().split(/\s+/);
  return type && data ? `${type} ${data}` : null;
}

/** A pasted key as the server stores it: trimmed, spaces made single. */
export const tidyKey = (text) => String(text ?? '').trim().split(/\s+/).join(' ');

/** The keys a VM holds: the lines of its `sshKey`. */
export const vmKeyLines = (sshKey) => String(sshKey ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** The list's key with the text's identity, or null. */
export const listedKey = (list, text) => {
  const id = keyIdentity(text);
  return id ? (list ?? []).find((k) => keyIdentity(k.key) === id) ?? null : null;
};

/** Whether the choice holds the key (by identity). */
export const picks = (chosen, text) => chosen.some((t) => keyIdentity(t) === keyIdentity(text));

/** The choice with the key in it, or out of it. */
export function toggled(chosen, text, on) {
  const rest = chosen.filter((t) => keyIdentity(t) !== keyIdentity(text));
  return on ? [...rest, text] : rest;
}

/** The list's default keys: what a new setup starts from. */
export const defaultKeys = (list) => (list ?? []).filter((k) => k.default).map((k) => k.key);

/** What a key not in the list is called: its comment, else that. */
export const otherKeyName = (text) => String(text).trim().split(/\s+/).slice(2).join(' ') || 'A key not in Wisp’s list';

/** The keys the picker shows beside the list's: the VM's own and the ones picked that the list does not hold. */
export function otherKeys(list, own, chosen) {
  const seen = new Set();
  return [...own, ...chosen].filter((text) => {
    const id = keyIdentity(text);
    if (!id || seen.has(id) || listedKey(list, text)) return false;
    seen.add(id);
    return true;
  });
}

/** The choice as `sshKey`: the list's keys in its order, then the others, one per line. */
export function sshKeyText(chosen, list) {
  const listed = (list ?? []).flatMap((k) => chosen.filter((t) => keyIdentity(t) === keyIdentity(k.key)).slice(0, 1));
  const others = chosen.filter((t) => !listedKey(list, t));
  return [...listed, ...others].join('\n');
}

/** A VM's keys as the page names them: the list's by name, then how many others. */
export function keysText(sshKey, list) {
  const lines = vmKeyLines(sshKey);
  if (lines.length === 0) return 'None';
  const names = [];
  let others = 0;
  for (const line of lines) {
    const key = listedKey(list, line);
    if (key) names.push(key.name);
    else others += 1;
  }
  if (others) names.push(`${others} other key${others === 1 ? '' : 's'}`);
  return names.join(', ');
}
