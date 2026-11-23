import { useState } from 'react';
import { CloudDownload, KeyRound, Pencil, Plus, Star, Trash2 } from 'lucide-react';

import { addSshKey, importGithubKeys, removeSshKey, updateSshKey } from '../../api/settings.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { useRecord } from '../../hooks/useRecord.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import CommandErrors from '../shared/CommandErrors.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import FormModal from '../shared/FormModal.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import Card from '../shared/Card.jsx';
import GroupItem from '../shared/GroupItem.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import { NOTHING_CHANGED } from '../../hooks/editorValues.js';

const NAME_MAX = 64;
const GITHUB_USER = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** What an import did, in words. */
function importText(user, { added, alreadyListed, skipped }) {
  if (added.length === 0 && alreadyListed === 0 && skipped === 0) return `${user} has no public keys on GitHub.`;
  const parts = [added.length ? `Added ${plural(added.length, 'key', 'keys')} from ${user}` : `Added no key from ${user}`];
  if (alreadyListed) parts.push(`${plural(alreadyListed, 'was', 'were')} already in the list`);
  if (skipped) parts.push(`${plural(skipped, 'was', 'were')} skipped: unreadable, or of a type Wisp does not take`);
  return `${parts.join('; ')}.`;
}

/**
 * Wisp's SSH keys (docs/specs/SETTINGS.md, SSH keys): the keys a VM's first boot setup
 * picks from, the defaults preselected for a new VM. Add pastes one, Import takes a
 * GitHub user's; per row, Default (a star, saved at once), Edit for its name, and
 * Remove, which asks first. Removing a key changes no VM: each keeps its own copy.
 */
export default function SshKeysSettings() {
  const record = useRecord(RECORD.SETTINGS);
  const act = useCommand();
  const [form, setForm] = useState(null); // 'add' | 'import' | { rename: key }
  const [removing, setRemoving] = useState(null);
  const [notice, setNotice] = useState(null);

  const open = (which) => { setNotice(null); setForm(which); };

  return (
    <Card
      title="SSH keys"
      actions={(
        <>
          <GroupAction icon={Plus} kindIcon={KeyRound} variant="add" label="Add a key" onClick={() => open('add')} />
          <GroupAction icon={CloudDownload} label="Import a GitHub user’s keys" onClick={() => open('import')} />
        </>
      )}
    >
      <RecordGate record={record} what="settings">
        {(settings) => {
          const keys = settings.sshKeys ?? [];
          return (
            <>
              {keys.length === 0 && <p className="py-1 text-sm text-text-muted">No keys yet. A VM’s first boot setup picks from these.</p>}
              {keys.map((k) => (
                <GroupItem
                  key={k.id}
                  title={k.name}
                  detail={`${k.type} · ${k.fingerprint}`}
                  actions={(
                    <>
                      <GroupAction
                        icon={Star}
                        label={`Default for new VMs: ${k.name}`}
                        pressed={k.default}
                        busy={act.isBusy(`default:${k.id}`)}
                        onClick={() => act.run(() => updateSshKey(k.id, { default: !k.default }), {
                          key: `default:${k.id}`, about: `Couldn't change whether ${k.name} is a default`,
                        })}
                      />
                      <GroupAction icon={Pencil} label={`Rename ${k.name}`} onClick={() => open({ rename: k })} />
                      <GroupAction
                        icon={Trash2}
                        variant="danger"
                        label={`Remove ${k.name}`}
                        busy={act.isBusy(`remove:${k.id}`)}
                        onClick={() => setRemoving(k)}
                      />
                    </>
                  )}
                />
              ))}
            </>
          );
        }}
      </RecordGate>
      {notice && <p className="mt-2 text-xs text-text-secondary" role="status">{notice}</p>}
      <CommandErrors className="mt-2" commands={[act]} prefix={(_key, _cmd, about) => about} />

      {form === 'add' && <AddKeyForm onClose={() => setForm(null)} />}
      {form === 'import' && <ImportForm onDone={(text) => { setNotice(text); setForm(null); }} onClose={() => setForm(null)} />}
      {form?.rename && <RenameKeyForm sshKey={form.rename} onClose={() => setForm(null)} />}
      <ConfirmDialog
        open={removing != null}
        title={removing ? `Remove ${removing.name}?` : ''}
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const k = removing;
          setRemoving(null);
          act.run(() => removeSshKey(k.id), { key: `remove:${k.id}`, about: `Couldn't remove ${k.name}` });
        }}
      >
        <p>It leaves Wisp’s list. VMs that have the key keep it.</p>
      </ConfirmDialog>
    </Card>
  );
}

function AddKeyForm({ onClose }) {
  const { form, setField } = useEditor({ key: '', name: '' });
  const save = useCommand();
  const blocked = !form.key.trim() ? 'Paste a public key.' : null;
  return (
    <FormModal
      title="Add an SSH key"
      saveLabel="Add"
      save={save}
      blocked={blocked}
      onClose={onClose}
      onSubmit={() => save.run(() => addSshKey({ key: form.key, ...(form.name.trim() ? { name: form.name } : {}) }))
        .then((ok) => { if (ok) onClose(); })}
    >
      <FormField label="Public key" htmlFor="ssh-key-text" hint="One line, as in a .pub file.">
        <textarea
          id="ssh-key-text"
          ref={autoFocusField}
          value={form.key}
          onChange={(e) => setField('key', e.target.value)}
          rows={3}
          placeholder="ssh-ed25519 AAAA… name"
          spellCheck={false}
          className="input-field font-mono text-xs"
        />
      </FormField>
      <FormField label="Name" htmlFor="ssh-key-name" hint="Empty: the key’s comment, or one from its type.">
        <input id="ssh-key-name" type="text" value={form.name} maxLength={NAME_MAX} onChange={(e) => setField('name', e.target.value)} autoComplete="off" className="input-field" />
      </FormField>
    </FormModal>
  );
}

function ImportForm({ onDone, onClose }) {
  const { form, setField } = useEditor({ user: '' });
  const save = useCommand();
  const user = form.user.trim();
  const blocked = !user ? 'Type a GitHub user.' : (GITHUB_USER.test(user) ? null : 'A GitHub user is letters, digits and dashes.');
  return (
    <FormModal
      title="Import keys from GitHub"
      saveLabel="Import"
      save={save}
      blocked={blocked}
      onClose={onClose}
      onSubmit={() => save.run(() => importGithubKeys(user), { onDone: (result) => onDone(importText(user, result)) })}
    >
      <FormField label="GitHub user" htmlFor="ssh-key-github" hint="Every public key GitHub lists for the user is added; one already in the list is skipped.">
        <input id="ssh-key-github" ref={autoFocusField} type="text" value={form.user} onChange={(e) => setField('user', e.target.value)} autoComplete="off" spellCheck={false} className="input-field" />
      </FormField>
    </FormModal>
  );
}

function RenameKeyForm({ sshKey, onClose }) {
  const { form, setField, dirty } = useEditor({ name: sshKey.name });
  const save = useCommand();
  const name = form.name.trim();
  const blocked = !name ? 'A key needs a name.' : (!dirty || name === sshKey.name ? NOTHING_CHANGED : null);
  return (
    <FormModal
      title="Rename the key"
      subtitle={`${sshKey.type} · ${sshKey.fingerprint}`}
      save={save}
      blocked={blocked}
      onClose={onClose}
      onSubmit={() => save.run(() => updateSshKey(sshKey.id, { name })).then((ok) => { if (ok) onClose(); })}
    >
      <FormField label="Name" htmlFor="ssh-key-rename">
        <input id="ssh-key-rename" ref={autoFocusField} type="text" value={form.name} maxLength={NAME_MAX} onChange={(e) => setField('name', e.target.value)} autoComplete="off" className="input-field" />
      </FormField>
    </FormModal>
  );
}
