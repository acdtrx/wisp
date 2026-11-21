import { useState } from 'react';
import { Eye, EyeOff, Globe, Pencil, Plus, Trash2 } from 'lucide-react';

import FormModal from '../../components/shared/FormModal.jsx';
import { FormCheckbox, FormField } from '../../components/shared/FormModalChrome.jsx';
import GroupAction from '../../components/shared/GroupAction.jsx';
import GroupCard from '../../components/shared/GroupCard.jsx';
import GroupItem from '../../components/shared/GroupItem.jsx';
import ValueRows from '../../components/shared/ValueRows.jsx';
import { APP_CONFIG_COMMAND, appCommandRunning, appRowReason } from '../appConfigRows.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { autoFocusField } from '../../lib/focus.js';
import { domainForm, siteForm, siteProblem, withDomain, withSite, withoutSite } from './caddyConfig.js';

const appConfigOf = (config) => config.metadata?.appConfig ?? {};
const removeAbout = (sub) => `Couldn't remove the site ${sub}`;

/**
 * The Caddy reverse proxy's own groups: its sites (each saved or removed on its own,
 * with the whole app config) and its domain and certificates.
 */
export default function CaddyGroups({ config, busy, act, update }) {
  const ac = appConfigOf(config);
  /* One whole-config command at a time: the rows and switches wait for it. */
  const appReason = appRowReason(busy, act);
  /* The open editor: `{ site: key | null }` or `{ domain: true }`. */
  const [editor, setEditor] = useState(null);
  const save = (appConfig) => update({ appConfig });
  const hosts = (ac.hosts ?? []).filter(Boolean);

  const remove = (sub) => act.run(() => save(withoutSite(appConfigOf(config), sub)), {
    key: APP_CONFIG_COMMAND, about: removeAbout(sub),
  });

  return (
    <>
      <GroupCard
        title="Sites"
        actions={<GroupAction icon={Plus} kindIcon={Globe} variant="add" label="Add a site" reason={appReason} onClick={() => setEditor({ site: null })} />}
      >
        {hosts.length === 0 && <p className="py-1 text-sm text-text-muted">No sites.</p>}
        {hosts.map((h) => {
          const removing = appCommandRunning(act, removeAbout(h.subdomain));
          return (
            <GroupItem
              key={h.subdomain}
              title={ac.domain ? `${h.subdomain}.${ac.domain}` : h.subdomain}
              detail={`to ${h.target}`}
              actions={(
                <>
                  <GroupAction icon={Pencil} label={`Edit ${h.subdomain}`} reason={appReason} disabled={removing} onClick={() => setEditor({ site: h.subdomain })} />
                  <GroupAction icon={Trash2} variant="danger" label={`Remove ${h.subdomain}`} reason={appReason} busy={removing} onClick={() => remove(h.subdomain)} />
                </>
              )}
            />
          );
        })}
      </GroupCard>

      <GroupCard
        title="Domain and certificates"
        actions={<GroupAction icon={Pencil} label="Edit the domain and certificates" reason={appReason} onClick={() => setEditor({ domain: true })} />}
      >
        <ValueRows
          rows={[
            { label: 'Domain', value: ac.domain || 'None' },
            { label: 'Email', value: ac.email || 'None' },
            {
              label: 'Cloudflare DNS',
              value: (ac.cloudflareDnsEnabled ?? ac.cloudflareApiToken?.isSet)
                ? (ac.cloudflareApiToken?.isSet ? 'On, token set' : 'On, no token')
                : 'Off',
            },
          ]}
        />
      </GroupCard>

      {editor && 'site' in editor && <SiteEditor config={config} siteKey={editor.site} save={save} onClose={() => setEditor(null)} />}
      {editor?.domain && <DomainEditor config={config} save={save} onClose={() => setEditor(null)} />}
    </>
  );
}

function SiteEditor({ config, siteKey, save, onClose }) {
  const [opened] = useState(() => (appConfigOf(config).hosts ?? []).find((h) => h?.subdomain === siteKey) ?? null);
  const { form, setField, dirty } = useEditor(() => siteForm(opened));
  const command = useCommand();
  const domain = appConfigOf(config).domain;
  const problem = siteProblem(appConfigOf(config), siteKey, form);
  const blocked = problem ?? (siteKey == null || dirty ? null : 'Nothing changed');
  return (
    <FormModal
      title={siteKey == null ? 'Add a site' : 'Site'}
      subtitle={domain ? `*.${domain}` : config.name}
      saveLabel={siteKey == null ? 'Add' : 'Save'}
      save={command}
      blocked={blocked}
      onClose={onClose}
      onSubmit={() => command.run(() => save(withSite(appConfigOf(config), siteKey, form))).then((ok) => { if (ok) onClose(); })}
    >
      <FormField label="Name" htmlFor="caddy-site-name" hint={domain ? `Reached at <name>.${domain}.` : 'Set the domain to reach it by name.'}>
        <input id="caddy-site-name" ref={autoFocusField} type="text" value={form.subdomain} onChange={(e) => setField('subdomain', e.target.value)} placeholder="photos" autoComplete="off" spellCheck={false} className="input-field" />
      </FormField>
      <FormField label="Target" htmlFor="caddy-site-target" hint="host, host:port or scheme://host[:port][/path]">
        <input id="caddy-site-target" type="text" value={form.target} onChange={(e) => setField('target', e.target.value)} placeholder="192.168.1.20:8080" autoComplete="off" spellCheck={false} className="input-field font-mono" />
      </FormField>
      {problem && (form.subdomain || form.target) && <p className="text-[11px] text-text-muted">{problem}</p>}
    </FormModal>
  );
}

function DomainEditor({ config, save, onClose }) {
  const { form, setField, dirty } = useEditor(() => domainForm(appConfigOf(config)));
  const command = useCommand();
  const [showToken, setShowToken] = useState(false);
  return (
    <FormModal
      title="Domain and certificates"
      subtitle={config.name}
      save={command}
      blocked={dirty ? null : 'Nothing changed'}
      onClose={onClose}
      size="md"
      onSubmit={() => command.run(() => save(withDomain(appConfigOf(config), form))).then((ok) => { if (ok) onClose(); })}
    >
      <FormField label="Domain" htmlFor="caddy-domain" hint="One certificate covers every site under it.">
        <input id="caddy-domain" type="text" value={form.domain} onChange={(e) => setField('domain', e.target.value)} placeholder="example.com" autoComplete="off" spellCheck={false} className="input-field" />
      </FormField>
      <FormField label="Email" htmlFor="caddy-email" hint="For Let’s Encrypt notices. Optional.">
        <input id="caddy-email" type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} placeholder="admin@example.com" autoComplete="off" className="input-field" />
      </FormField>
      <FormCheckbox
        label="Cloudflare DNS certificates (DNS-01)"
        hint="Needs a Caddy image built with the caddy-dns/cloudflare module; the stock caddy image fails to start with this on."
        checked={form.cloudflareDnsEnabled}
        onChange={(e) => setField('cloudflareDnsEnabled', e.target.checked)}
      />
      {form.cloudflareDnsEnabled && (
        <FormField label="Cloudflare API token" htmlFor="caddy-token" hint={form.tokenIsSet ? 'Empty: keep the stored token.' : null}>
          <div className="flex items-stretch gap-2">
            <input
              id="caddy-token"
              type={showToken ? 'text' : 'password'}
              value={form.token}
              onChange={(e) => setField('token', e.target.value)}
              placeholder={form.tokenIsSet ? 'Set' : 'Token'}
              autoComplete="new-password"
              className="input-field min-w-0 flex-1"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="inline-flex shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary"
              title={showToken ? 'Hide the token' : 'Show the token'}
              aria-label={showToken ? 'Hide the token' : 'Show the token'}
            >
              {showToken ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
            </button>
          </div>
        </FormField>
      )}
    </FormModal>
  );
}
