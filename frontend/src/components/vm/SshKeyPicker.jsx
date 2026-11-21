import { Loader2, Plus } from 'lucide-react';

import { addSshKey } from '../../api/settings.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import RecordError from '../shared/RecordError.jsx';
import { keyIdentity, listedKey, otherKeyName, otherKeys, picks, tidyKey, toggled } from './sshKeyChoice.js';

const NO_KEYS = [];

/** One key to pick: its name, and under it its type and fingerprint, cut to the width. */
function KeyChoice({ name, detail, checked, onChange, disabled }) {
  return (
    <label className={`flex min-w-0 items-start gap-2 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-text-secondary">{name}</span>
        <span className="block truncate text-[11px] text-text-muted" title={detail}>{detail}</span>
      </span>
    </label>
  );
}

/**
 * The SSH keys a VM's first boot setup gives its user: Wisp's list as a choice, the
 * VM's own keys the list does not hold (`own`), and a field to paste a key, which is
 * added to the list at once and then shows picked. `chosen` is the texts picked;
 * `onChange` takes an update of them (`(chosen) => chosen`), so a paste that answers
 * late does not undo a pick made meanwhile. The paste field's text is the form's
 * (`paste`, `onPaste`): a form does not send while it holds a key not added
 * (`keysProblem`).
 */
export default function SshKeyPicker({ idPrefix, chosen, onChange, paste, onPaste, own = NO_KEYS, disabled = false }) {
  const settings = useRecord(RECORD.SETTINGS);
  const list = settings.data?.sshKeys ?? NO_KEYS;
  const others = otherKeys(list, own, chosen);
  const add = useCommand();

  const pick = (text) => (e) => {
    const on = e.target.checked;
    onChange((c) => toggled(c, text, on));
  };

  const addPasted = () => {
    const text = tidyKey(paste);
    if (!text || add.busy) return;
    const listed = listedKey(list, text);
    if (listed) {
      onChange((c) => toggled(c, listed.key, true));
      onPaste('');
      return;
    }
    add.run(() => addSshKey({ key: text }), {
      onDone: () => {
        onChange((c) => toggled(c, text, true));
        onPaste('');
      },
    });
  };

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-xs font-medium text-text-secondary">SSH keys</legend>
      <RecordError record={settings} what="Wisp’s SSH keys" />
      {settings.data == null && !settings.error && <p className="text-[11px] text-text-muted">Loading Wisp’s keys…</p>}
      {settings.data != null && list.length === 0 && others.length === 0 && (
        <p className="text-[11px] text-text-muted">Wisp’s list has no keys yet: paste one below, or add some in Host, App Config.</p>
      )}
      {(list.length > 0 || others.length > 0) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {list.map((k) => (
            <KeyChoice
              key={k.id}
              name={k.name}
              detail={`${k.type}${k.default ? ', default' : ''} · ${k.fingerprint}`}
              checked={picks(chosen, k.key)}
              onChange={pick(k.key)}
              disabled={disabled}
            />
          ))}
          {others.map((text) => (
            <KeyChoice
              key={keyIdentity(text)}
              name={otherKeyName(text)}
              detail="Not in Wisp’s list"
              checked={picks(chosen, text)}
              onChange={pick(text)}
              disabled={disabled}
            />
          ))}
        </div>
      )}
      <div className="flex items-stretch gap-2">
        <input
          id={`${idPrefix}-paste`}
          type="text"
          value={paste}
          onChange={(e) => { onPaste(e.target.value); if (add.error) add.dismiss(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPasted(); } }}
          placeholder="Paste a public key: ssh-ed25519 AAAA… name"
          aria-label="Paste an SSH public key to add it to Wisp’s list"
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          className="input-field min-w-0 flex-1 font-mono"
        />
        <button
          type="button"
          onClick={addPasted}
          disabled={disabled || add.busy || !paste.trim()}
          className="inline-flex shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary disabled:opacity-40"
          title="Add the key to Wisp’s list and pick it"
          aria-label="Add the key to Wisp’s list and pick it"
        >
          {add.busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Plus size={15} aria-hidden />}
        </button>
      </div>
      <ErrorBanner error={add.error} prefix="Couldn't add the key" onDismiss={add.dismiss} />
    </fieldset>
  );
}
