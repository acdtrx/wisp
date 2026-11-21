import { useState } from 'react';
import { Pencil, Plus, Trash2, UserPlus } from 'lucide-react';

import FormModal from '../../components/shared/FormModal.jsx';
import { FormCheckbox, FormField } from '../../components/shared/FormModalChrome.jsx';
import GroupAction from '../../components/shared/GroupAction.jsx';
import GroupCard from '../../components/shared/GroupCard.jsx';
import GroupItem from '../../components/shared/GroupItem.jsx';
import ValueRows from '../../components/shared/ValueRows.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useForm.js';
import { autoFocusField } from '../../lib/focus.js';
import {
  USERNAME_CLAIMS, callbackUrl, ssoForm, ssoProblem, userForm, userProblem, withAddress, withSso, withUser, withoutUser,
} from './zotConfig.js';

const appConfigOf = (config) => config.metadata?.appConfig ?? {};

/**
 * The Zot registry's own groups: its users (password sign-in, for `docker login`), the
 * address browsers reach it on, and single sign-on for its web UI.
 */
export default function ZotGroups({ config, busy, act, update }) {
  const ac = appConfigOf(config);
  const [editor, setEditor] = useState(null);
  const save = (appConfig) => update({ appConfig });
  const users = (ac.users ?? []).filter(Boolean);
  const oidc = ac.oidc ?? {};

  const remove = (username) => act.run(() => save(withoutUser(appConfigOf(config), username)), {
    key: `user:${username}`, about: `Couldn't remove ${username}`,
  });

  return (
    <>
      <GroupCard
        title="Users"
        actions={<GroupAction icon={Plus} kindIcon={UserPlus} variant="add" label="Add a user" reason={busy} onClick={() => setEditor({ user: null })} />}
      >
        {users.length === 0 && <p className="py-1 text-sm text-text-muted">{oidc.enabled ? 'No users: sign in with single sign-on.' : 'No users: anyone may push and pull.'}</p>}
        {users.map((u) => {
          const removing = act.isBusy(`user:${u.username}`);
          return (
            <GroupItem
              key={u.username}
              title={u.username}
              detail={u.hasPassword ? 'Password set' : 'No password'}
              actions={(
                <>
                  <GroupAction icon={Pencil} label={`Edit ${u.username}`} reason={busy} disabled={removing} onClick={() => setEditor({ user: u.username })} />
                  <GroupAction icon={Trash2} variant="danger" label={`Remove ${u.username}`} reason={busy} busy={removing} onClick={() => remove(u.username)} />
                </>
              )}
            />
          );
        })}
      </GroupCard>

      <GroupCard
        title="Address"
        actions={<GroupAction icon={Pencil} label="Edit the address" reason={busy} onClick={() => setEditor({ address: true })} />}
      >
        <ValueRows rows={[{ label: 'Reached at', value: ac.externalUrl || 'Not set', mono: !!ac.externalUrl }]} />
      </GroupCard>

      <GroupCard
        title="Sign-in (SSO)"
        actions={<GroupAction icon={Pencil} label="Edit sign-in" reason={busy} onClick={() => setEditor({ sso: true })} />}
      >
        <ValueRows
          rows={[
            { label: 'Single sign-on', value: oidc.enabled ? 'On' : 'Off' },
            { label: 'Issuer', value: oidc.enabled ? oidc.issuer : null, mono: true },
            { label: 'Client ID', value: oidc.enabled ? oidc.clientId : null, mono: true },
            { label: 'Redirect URI', value: oidc.enabled ? callbackUrl(ac.externalUrl) : null, mono: true },
          ]}
        />
      </GroupCard>

      {editor && 'user' in editor && <UserEditor config={config} userKey={editor.user} save={save} onClose={() => setEditor(null)} />}
      {editor?.address && <AddressEditor config={config} save={save} onClose={() => setEditor(null)} />}
      {editor?.sso && <SsoEditor config={config} save={save} onClose={() => setEditor(null)} />}
    </>
  );
}

function UserEditor({ config, userKey, save, onClose }) {
  const [opened] = useState(() => (appConfigOf(config).users ?? []).find((u) => u?.username === userKey) ?? null);
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
      <FormField label="Username" htmlFor="zot-user">
        <input id="zot-user" ref={autoFocusField} type="text" value={form.username} onChange={(e) => setField('username', e.target.value)} autoComplete="off" spellCheck={false} className="input-field" />
      </FormField>
      <FormField label="Password" htmlFor="zot-password" hint={userKey != null ? 'Empty: keep the stored password (a renamed user needs a new one).' : null}>
        <input id="zot-password" type="password" value={form.password} onChange={(e) => setField('password', e.target.value)} placeholder={userKey != null ? 'Unchanged' : ''} autoComplete="new-password" className="input-field" />
      </FormField>
      {problem && form.username && <p className="text-[11px] text-text-muted">{problem}</p>}
    </FormModal>
  );
}

function AddressEditor({ config, save, onClose }) {
  const { form, setField, dirty } = useEditor(() => ({ externalUrl: appConfigOf(config).externalUrl ?? '' }));
  const command = useCommand();
  return (
    <FormModal
      title="Address"
      subtitle={config.name}
      save={command}
      blocked={dirty ? null : 'Nothing changed'}
      onClose={onClose}
      onSubmit={() => command.run(() => save(withAddress(appConfigOf(config), form.externalUrl))).then((ok) => { if (ok) onClose(); })}
    >
      <FormField label="Reached at" htmlFor="zot-url" hint="The address browsers reach the registry on. Single sign-on needs it.">
        <input id="zot-url" ref={autoFocusField} type="text" value={form.externalUrl} onChange={(e) => setField('externalUrl', e.target.value)} placeholder="https://registry.example.com" autoComplete="off" spellCheck={false} className="input-field font-mono" />
      </FormField>
    </FormModal>
  );
}

function SsoEditor({ config, save, onClose }) {
  const { form, setField, dirty } = useEditor(() => ssoForm(appConfigOf(config)));
  const command = useCommand();
  const problem = ssoProblem(appConfigOf(config), form);
  const blocked = problem ?? (dirty ? null : 'Nothing changed');
  const field = (key, label, props = {}) => (
    <FormField label={label} htmlFor={`zot-sso-${key}`} hint={props.hint}>
      <input
        id={`zot-sso-${key}`}
        type={props.type ?? 'text'}
        value={form[key]}
        onChange={(e) => setField(key, e.target.value)}
        placeholder={props.placeholder}
        autoComplete={props.type === 'password' ? 'new-password' : 'off'}
        spellCheck={false}
        className="input-field"
      />
    </FormField>
  );
  return (
    <FormModal
      title="Sign-in (SSO)"
      subtitle={config.name}
      save={command}
      blocked={blocked}
      onClose={onClose}
      size="md"
      onSubmit={() => command.run(() => save(withSso(appConfigOf(config), form))).then((ok) => { if (ok) onClose(); })}
    >
      <FormCheckbox
        label="Single sign-on for the web UI"
        hint="zot checks the provider when it starts: if the provider is down then, the whole registry stays down. docker login still uses a password or an API key."
        checked={form.enabled}
        onChange={(e) => setField('enabled', e.target.checked)}
      />
      {form.enabled && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {field('issuer', 'Issuer URL', { placeholder: 'https://id.example.com' })}
            {field('name', 'Button label', { placeholder: 'SSO' })}
            {field('clientId', 'Client ID', { placeholder: 'zot-registry' })}
            {field('secret', 'Client secret', { type: 'password', placeholder: form.secretIsSet ? 'Set' : '', hint: form.secretIsSet ? 'Empty: keep the stored secret.' : null })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Username claim" htmlFor="zot-sso-claim">
              <select id="zot-sso-claim" value={form.usernameClaim} onChange={(e) => setField('usernameClaim', e.target.value)} className="input-field">
                {USERNAME_CLAIMS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </FormField>
            {field('scopes', 'Scopes', { placeholder: 'openid profile email' })}
          </div>
          <p className="text-[11px] text-text-muted">
            Redirect URI to register: <span className="font-mono">{callbackUrl(appConfigOf(config).externalUrl) ?? 'set the address first'}</span>
          </p>
        </>
      )}
      {problem && <p className="text-[11px] text-text-muted">{problem}</p>}
    </FormModal>
  );
}
