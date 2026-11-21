import { useState } from 'react';
import { Folder, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';

import ConfirmDialog from '../../components/shared/ConfirmDialog.jsx';
import FormModal from '../../components/shared/FormModal.jsx';
import { FormCheckbox, FormField } from '../../components/shared/FormModalChrome.jsx';
import GroupAction from '../../components/shared/GroupAction.jsx';
import GroupCard from '../../components/shared/GroupCard.jsx';
import GroupItem from '../../components/shared/GroupItem.jsx';
import RecordError from '../../components/shared/RecordError.jsx';
import ValueRows from '../../components/shared/ValueRows.jsx';
import { APP_CONFIG_COMMAND, appCommandRunning, appRowReason } from '../appConfigRows.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useForm.js';
import { useRecord } from '../../hooks/useRecord.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import {
  ICON_MODEL_OFF, PROTOCOLS, editDeletesShareData, removalDeletesShareData, serverForm, serverProblems,
  shareForm, shareProblem, sharesOnlyUserReaches, userForm, userProblem, withServer, withShare, withUser, withoutShare,
  withAppleExtensions, withoutUser,
} from './tinySambaConfig.js';

const appConfigOf = (config) => config.metadata?.appConfig ?? {};
const removeShareAbout = (name) => `Couldn't remove the share ${name}`;
const removeUserAbout = (name) => `Couldn't remove ${name}`;
const NO_MOUNTS = [];
const LEVEL_TEXT = { rw: 'read and write', ro: 'read' };

const storageLabel = (mounts, id) => {
  const m = mounts.find((s) => s.id === id);
  return m ? ((m.label && m.label.trim()) || m.mountPath) : id;
};

/** The confirm before a save that deletes a share's files on this host, naming them. */
function ShareDataConfirm({ share, moving, onConfirm, onCancel }) {
  return (
    <ConfirmDialog
      open
      title={moving ? `Move ${share} to the storage mount?` : `Remove the share ${share}?`}
      confirmLabel={moving ? 'Move and delete' : 'Remove and delete'}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>
        Its files on this host are deleted: <span className="font-mono text-text-primary">files/share-{share}</span>.
        {moving ? ' Nothing is copied to the storage mount.' : ''}
      </p>
      <p className="mt-2 text-xs text-text-muted">This cannot be undone.</p>
    </ConfirmDialog>
  );
}

/**
 * The Samba server's own groups: its shares and users (each saved or removed on its
 * own, with the whole app config) and the server's settings. A save that deletes a
 * share's files on this host asks first.
 */
export default function TinySambaGroups({ config, busy, act, update }) {
  const ac = appConfigOf(config);
  /* One whole-config command at a time: the rows and switches wait for it. */
  const appReason = appRowReason(busy, act);
  const [editor, setEditor] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const settings = useRecord(RECORD.SETTINGS);
  const storage = settings.data?.mounts ?? NO_MOUNTS;
  const save = (appConfig) => update({ appConfig });
  const shares = (ac.shares ?? []).filter(Boolean);
  const users = (ac.users ?? []).filter(Boolean);
  const server = ac.server ?? {};

  const removeShare = (name) => act.run(() => save(withoutShare(appConfigOf(config), name)), {
    key: APP_CONFIG_COMMAND, about: removeShareAbout(name),
  });
  const askRemoveShare = (name) => {
    if (removalDeletesShareData(ac, name)) setConfirmRemove(name);
    else removeShare(name);
  };
  const removeUser = (name) => act.run(() => save(withoutUser(appConfigOf(config), name)), {
    key: APP_CONFIG_COMMAND, about: removeUserAbout(name),
  });

  return (
    <>
      <GroupCard
        title="Shares"
        actions={<GroupAction icon={Plus} kindIcon={Folder} variant="add" label="Add a share" reason={appReason} onClick={() => setEditor({ share: null })} />}
      >
        <RecordError record={settings} what="storage mounts" className="mb-2" />
        {shares.length === 0 && <p className="py-1 text-sm text-text-muted">No shares.</p>}
        {shares.map((s) => {
          const removing = appCommandRunning(act, removeShareAbout(s.name));
          const where = s.source?.sourceId
            ? `on ${storageLabel(storage, s.source.sourceId)}${s.source.subPath ? `/${s.source.subPath}` : ''}`
            : 'on this host';
          const who = s.guest ? 'anyone, read only' : (s.access ?? []).map((a) => `${a.user} ${LEVEL_TEXT[a.level] ?? a.level}`).join(', ');
          return (
            <GroupItem
              key={s.name}
              title={s.name}
              detail={`${where} · ${who}`}
              actions={(
                <>
                  <GroupAction icon={Pencil} label={`Edit ${s.name}`} reason={appReason} disabled={removing} onClick={() => setEditor({ share: s.name })} />
                  <GroupAction icon={Trash2} variant="danger" label={`Remove ${s.name}`} reason={appReason} busy={removing} onClick={() => askRemoveShare(s.name)} />
                </>
              )}
            />
          );
        })}
      </GroupCard>

      <GroupCard
        title="Users"
        actions={<GroupAction icon={Plus} kindIcon={UserPlus} variant="add" label="Add a user" reason={appReason} onClick={() => setEditor({ user: null })} />}
      >
        {users.length === 0 && <p className="py-1 text-sm text-text-muted">No users.</p>}
        {users.map((u) => {
          const removing = appCommandRunning(act, removeUserAbout(u.name));
          const sole = sharesOnlyUserReaches(ac, u.name);
          return (
            <GroupItem
              key={u.name}
              title={u.name}
              detail={u.password?.isSet ? 'Password set' : 'No password'}
              actions={(
                <>
                  <GroupAction icon={Pencil} label={`Edit ${u.name}`} reason={appReason} disabled={removing} onClick={() => setEditor({ user: u.name })} />
                  <GroupAction
                    icon={Trash2}
                    variant="danger"
                    label={`Remove ${u.name}`}
                    reason={appReason ?? (sole.length > 0 ? `the only user of ${sole.join(', ')}` : undefined)}
                    busy={removing}
                    onClick={() => removeUser(u.name)}
                  />
                </>
              )}
            />
          );
        })}
      </GroupCard>

      <GroupCard
        title="Server"
        actions={<GroupAction icon={Pencil} label="Edit the server" reason={appReason} onClick={() => setEditor({ server: true })} />}
      >
        <ValueRows
          rows={[
            { label: 'Workgroup', value: server.workgroup || '—' },
            { label: 'NetBIOS name', value: server.netbiosName || '—' },
            { label: 'Data owner', value: `user ${server.dataUid ?? 1000} in the container` },
            { label: 'Oldest protocol', value: server.minProtocol || 'SMB3' },
            { label: 'Apple extensions', value: server.iconModel === ICON_MODEL_OFF ? 'Off' : 'On' },
          ]}
        />
      </GroupCard>

      {editor && 'share' in editor && (
        <ShareEditor config={config} shareKey={editor.share} storage={storage} save={save} onClose={() => setEditor(null)} />
      )}
      {editor && 'user' in editor && <UserEditor config={config} userKey={editor.user} save={save} onClose={() => setEditor(null)} />}
      {editor?.server && <ServerEditor config={config} save={save} onClose={() => setEditor(null)} />}
      {confirmRemove && (
        <ShareDataConfirm
          share={confirmRemove}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => { const name = confirmRemove; setConfirmRemove(null); removeShare(name); }}
        />
      )}
    </>
  );
}

function ShareEditor({ config, shareKey, storage, save, onClose }) {
  const [opened] = useState(() => (appConfigOf(config).shares ?? []).find((s) => s?.name === shareKey) ?? null);
  const { form, setField, setForm, dirty } = useEditor(() => shareForm(opened));
  const command = useCommand();
  const [confirming, setConfirming] = useState(false);
  const users = (appConfigOf(config).users ?? []).filter(Boolean);
  const problem = shareProblem(appConfigOf(config), shareKey, form);
  const blocked = problem ?? (shareKey == null || dirty ? null : 'Nothing changed');
  const choices = form.sourceId && !storage.some((m) => m.id === form.sourceId)
    ? [...storage, { id: form.sourceId, mountPath: form.sourceId }] : storage;

  const send = () => command.run(() => save(withShare(appConfigOf(config), shareKey, form))).then((ok) => { if (ok) onClose(); });
  const submit = () => {
    if (editDeletesShareData(appConfigOf(config), shareKey, form)) setConfirming(true);
    else send();
  };

  return (
    <>
      <FormModal
        title={shareKey == null ? 'Add a share' : 'Share'}
        subtitle={config.name}
        saveLabel={shareKey == null ? 'Add' : 'Save'}
        save={command}
        blocked={blocked}
        onClose={onClose}
        onSubmit={submit}
        size="md"
      >
        <FormField label="Name" htmlFor="samba-share-name" hint="What clients see: lowercase letters, digits and dashes.">
          <input id="samba-share-name" ref={autoFocusField} type="text" value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="documents" autoComplete="off" spellCheck={false} className="input-field" />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Kept" htmlFor="samba-share-source">
            <select
              id="samba-share-source"
              value={form.sourceId}
              onChange={(e) => setForm((f) => ({ ...f, sourceId: e.target.value, subPath: e.target.value ? f.subPath : '' }))}
              className="input-field"
            >
              <option value="">On this host</option>
              {choices.map((m) => <option key={m.id} value={m.id}>On {storageLabel(choices, m.id)}</option>)}
            </select>
          </FormField>
          {form.sourceId && (
            <FormField label="Sub-path" htmlFor="samba-share-subpath" hint="Empty: the mount’s root.">
              <input id="samba-share-subpath" type="text" value={form.subPath} onChange={(e) => setField('subPath', e.target.value)} placeholder="samba/documents" autoComplete="off" spellCheck={false} className="input-field font-mono" />
            </FormField>
          )}
        </div>
        <FormCheckbox
          label="Guest share"
          hint="Anyone on the network may read it, without a password."
          checked={form.guest}
          onChange={(e) => setField('guest', e.target.checked)}
        />
        {!form.guest && (
          <div>
            <div className="mb-1 text-xs font-medium text-text-secondary">Who may use it</div>
            {users.length === 0 && <p className="text-xs text-text-muted">Add a user first.</p>}
            <div className="space-y-1.5">
              {users.map((u) => (
                <label key={u.name} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-mono text-text-primary">{u.name}</span>
                  <select
                    value={form.access[u.name] ?? 'none'}
                    onChange={(e) => setForm((f) => ({ ...f, access: { ...f.access, [u.name]: e.target.value } }))}
                    className="input-field w-40"
                    aria-label={`Access for ${u.name}`}
                  >
                    <option value="none">No access</option>
                    <option value="ro">Read</option>
                    <option value="rw">Read and write</option>
                  </select>
                </label>
              ))}
            </div>
          </div>
        )}
        {problem && form.name && <p className="text-[11px] text-text-muted">{problem}</p>}
      </FormModal>
      {confirming && (
        <ShareDataConfirm
          share={shareKey}
          moving
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); send(); }}
        />
      )}
    </>
  );
}

function UserEditor({ config, userKey, save, onClose }) {
  const [opened] = useState(() => (appConfigOf(config).users ?? []).find((u) => u?.name === userKey) ?? null);
  const { form, setField, dirty } = useEditor(() => userForm(opened));
  const command = useCommand();
  const problem = userProblem(appConfigOf(config), userKey, form);
  const blocked = problem ?? (userKey == null || dirty ? null : 'Nothing changed');
  return (
    <FormModal
      title={userKey == null ? 'Add a user' : 'User'}
      subtitle={config.name}
      saveLabel={userKey == null ? 'Add' : 'Save'}
      save={command}
      blocked={blocked}
      onClose={onClose}
      onSubmit={() => command.run(() => save(withUser(appConfigOf(config), userKey, form))).then((ok) => { if (ok) onClose(); })}
    >
      <FormField label="Name" htmlFor="samba-user" hint="Lowercase, starting with a letter.">
        <input id="samba-user" ref={autoFocusField} type="text" value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="alice" autoComplete="off" spellCheck={false} className="input-field" />
      </FormField>
      <FormField label="Password" htmlFor="samba-password" hint={userKey != null ? 'Empty: keep the stored password (a renamed user needs a new one).' : 'Plain text, or an NT hash as $NT$ and 32 hex digits.'}>
        <input id="samba-password" type="password" value={form.password} onChange={(e) => setField('password', e.target.value)} placeholder={userKey != null ? 'Unchanged' : ''} autoComplete="new-password" className="input-field" />
      </FormField>
      {problem && form.name && <p className="text-[11px] text-text-muted">{problem}</p>}
    </FormModal>
  );
}

function ServerEditor({ config, save, onClose }) {
  const { form, start, setField, setForm, dirty } = useEditor(() => serverForm(appConfigOf(config)));
  const command = useCommand();
  const problems = serverProblems(form);
  const blocked = Object.values(problems)[0] ?? (dirty ? null : 'Nothing changed');
  return (
    <FormModal
      title="Server"
      subtitle={config.name}
      save={command}
      blocked={blocked}
      onClose={onClose}
      size="md"
      onSubmit={() => command.run(() => save(withServer(appConfigOf(config), form))).then((ok) => { if (ok) onClose(); })}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Workgroup" htmlFor="samba-workgroup" hint={problems.workgroup ?? 'Applies at the next restart.'}>
          <input id="samba-workgroup" type="text" maxLength={15} value={form.workgroup} onChange={(e) => setField('workgroup', e.target.value)} className="input-field" />
        </FormField>
        <FormField label="NetBIOS name" htmlFor="samba-netbios" hint={problems.netbiosName ?? 'Applies at the next restart.'}>
          <input id="samba-netbios" type="text" maxLength={15} value={form.netbiosName} onChange={(e) => setField('netbiosName', e.target.value)} className="input-field" />
        </FormField>
        <FormField label="Data owner (user ID)" htmlFor="samba-uid" hint={problems.dataUid ?? 'The user inside the container that owns the shares’ files.'}>
          <input id="samba-uid" type="text" inputMode="numeric" value={form.dataUid} onChange={(e) => setField('dataUid', e.target.value.replace(/[^0-9]/g, ''))} className="input-field" />
        </FormField>
        <FormField label="Oldest protocol" htmlFor="samba-protocol">
          <select id="samba-protocol" value={form.minProtocol} onChange={(e) => setField('minProtocol', e.target.value)} className="input-field">
            {PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </FormField>
      </div>
      <FormCheckbox
        label="Apple extensions"
        hint="Nicer Finder icons and faster browsing on a Mac; shares on exFAT or FAT drives turn them off on their own."
        checked={form.iconModel !== ICON_MODEL_OFF}
        onChange={(e) => setForm((f) => withAppleExtensions(f, start, e.target.checked))}
      />
    </FormModal>
  );
}
