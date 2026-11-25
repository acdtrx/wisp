import { useState } from 'react';
import { ExternalLink, Globe, Pencil, Plus, Trash2 } from 'lucide-react';

import FormModal from '../../components/shared/FormModal.jsx';
import { FormField } from '../../components/shared/FormModalChrome.jsx';
import IconButton, { IconLink } from '../../components/shared/IconButton.jsx';
import Card from '../../components/shared/Card.jsx';
import GroupItem from '../../components/shared/GroupItem.jsx';
import RecordGate from '../../components/shared/RecordGate.jsx';
import ValueRows from '../../components/shared/ValueRows.jsx';
import { APP_CONFIG_COMMAND, appCommandRunning, appRowReason } from '../appConfigRows.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { useRecord } from '../../hooks/useRecord.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import { formatDay } from '../../utils/formatters.js';
import { siteForm, siteName, siteProblem, withSite, withoutSite } from './caddyConfig.js';
import { NOTHING_CHANGED } from '../../hooks/editorValues.js';

const appConfigOf = (config) => config.metadata?.appConfig ?? {};
const removeAbout = (sub) => `Couldn't remove the site ${sub}`;

/**
 * The Caddy reverse proxy's own groups: its sites (each saved or removed on its own,
 * with the whole app config), and the host's certificate they are served with, set
 * up in Host → App Config (docs/specs/UI-CONTAINER.md, App containers).
 */
export default function CaddyGroups({ config, busy, act, update }) {
  const ac = appConfigOf(config);
  /* The sites are under the domain of the certificate Wisp holds. */
  const certificateRecord = useRecord(RECORD.CERTIFICATE);
  const domain = certificateRecord.data?.certificate?.domain ?? null;
  /* One whole-config command at a time: the rows and switches wait for it. */
  const appReason = appRowReason(busy, act);
  /* The open editor: `{ site: key | null }`. */
  const [editor, setEditor] = useState(null);
  const save = (appConfig) => update({ appConfig });
  const hosts = (ac.hosts ?? []).filter(Boolean);

  const remove = (sub) => act.run(() => save(withoutSite(appConfigOf(config), sub)), {
    key: APP_CONFIG_COMMAND, about: removeAbout(sub),
  });

  return (
    <>
      <Card
        title="Sites"
        actions={<IconButton icon={Plus} kindIcon={Globe} variant="primary" label="Add a site" reason={appReason} onClick={() => setEditor({ site: null })} />}
      >
        {hosts.length === 0 && <p className="py-1 text-sm text-text-muted">No sites.</p>}
        {hosts.map((h) => {
          const removing = appCommandRunning(act, removeAbout(h.subdomain));
          return (
            <GroupItem
              key={h.subdomain}
              title={siteName(h.subdomain, domain)}
              detail={`to ${h.target}`}
              actions={(
                <>
                  <IconButton icon={Pencil} label={`Edit ${h.subdomain}`} reason={appReason} disabled={removing} onClick={() => setEditor({ site: h.subdomain })} />
                  <IconButton icon={Trash2} variant="danger" label={`Remove ${h.subdomain}`} reason={appReason} busy={removing} onClick={() => remove(h.subdomain)} />
                </>
              )}
            />
          );
        })}
      </Card>

      <Card
        title="Certificate"
        actions={<IconLink to="/host/app-config" icon={ExternalLink} label="Set up the certificate in Host → App Config" />}
      >
        <RecordGate record={certificateRecord} what="certificate">
          {(record) => (record.certificate ? (
            <ValueRows
              rows={[
                { label: 'Domain', value: record.certificate.domain, mono: true },
                { label: 'Valid until', value: formatDay(record.certificate.validUntil) },
              ]}
            />
          ) : (
            <p className="py-1 text-sm text-text-secondary">
              Wisp holds no certificate yet, so the sites are not served until it does. It is set up in Host → App Config.
            </p>
          ))}
        </RecordGate>
      </Card>

      {editor && <SiteEditor config={config} domain={domain} siteKey={editor.site} save={save} onClose={() => setEditor(null)} />}
    </>
  );
}

function SiteEditor({ config, domain, siteKey, save, onClose }) {
  const [opened] = useState(() => (appConfigOf(config).hosts ?? []).find((h) => h?.subdomain === siteKey) ?? null);
  const { form, setField, dirty } = useEditor(() => siteForm(opened));
  const command = useCommand();
  const problem = siteProblem(appConfigOf(config), siteKey, form);
  const blocked = problem ?? (siteKey == null || dirty ? null : NOTHING_CHANGED);
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
      <FormField label="Name" htmlFor="caddy-site-name" hint={domain ? `Reached at <name>.${domain}.` : 'Reached under the host certificate’s domain, once Wisp holds one.'}>
        <input id="caddy-site-name" ref={autoFocusField} type="text" value={form.subdomain} onChange={(e) => setField('subdomain', e.target.value)} placeholder="photos" autoComplete="off" spellCheck={false} className="input-field" />
      </FormField>
      <FormField label="Target" htmlFor="caddy-site-target" hint="host, host:port or scheme://host[:port][/path]">
        <input id="caddy-site-target" type="text" value={form.target} onChange={(e) => setField('target', e.target.value)} placeholder="192.168.1.20:8080" autoComplete="off" spellCheck={false} className="input-field font-mono" />
      </FormField>
      {problem && (form.subdomain || form.target) && <p className="text-[11px] text-text-muted">{problem}</p>}
    </FormModal>
  );
}
