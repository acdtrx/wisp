import { useState } from 'react';
import { Pencil } from 'lucide-react';

import { updateSettings } from '../../api/settings.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useRecord } from '../../hooks/useRecord.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import ApiTokensSettings from '../settings/ApiTokensSettings.jsx';
import OidcSettings from '../settings/OidcSettings.jsx';
import PasswordChangeForm from '../settings/PasswordChangeForm.jsx';
import SshKeysSettings from '../settings/SshKeysSettings.jsx';
import CommandErrors from '../shared/CommandErrors.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import Card from '../shared/Card.jsx';
import GroupSwitch from '../shared/GroupSwitch.jsx';
import RecordError from '../shared/RecordError.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import SettingsEditor from './SettingsEditor.jsx';
import { pathsForm, pathsProblem, pathsSent, serverForm, serverProblem, serverSent } from './settingsForms.js';

/**
 * Host → App Config (docs/specs/SETTINGS.md): this server, its storage paths, the
 * password, SSH keys, single sign-on and API tokens, each a group of its own.
 */
export default function AppConfig() {
  const settings = useRecord(RECORD.SETTINGS);
  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5">
      {settings.data != null && <RecordError record={settings} what="settings" />}
      <ServerGroup record={settings} />
      <StoragePathsGroup record={settings} />
      <Card title="Password">
        <div className="max-w-md py-1">
          <PasswordChangeForm />
        </div>
      </Card>
      <SshKeysSettings />
      <OidcSettings />
      <ApiTokensSettings />
    </div>
  );
}

/** The server's name and the URL it is opened by; LAN discovery as a switch. */
function ServerGroup({ record }) {
  const [editing, setEditing] = useState(false);
  const act = useCommand();
  return (
    <Card
      title="This server"
      actions={<GroupAction icon={Pencil} label="Edit the server’s name and URL" reason={record.data ? undefined : 'the settings are loading'} onClick={() => setEditing(true)} />}
    >
      <RecordGate record={record} what="settings">
        {(settings) => (
          <>
            <ValueRows
              rows={[
                { label: 'Name', value: settings.serverName },
                {
                  label: 'Advertised URL',
                  value: settings.advertisedUrl ?? 'None: it announces http://<host name>.local:<port>',
                  mono: !!settings.advertisedUrl,
                },
              ]}
            />
            <GroupSwitch
              label="LAN discovery"
              hint="Announce this server on the local network, and list other Wisp servers in the top bar."
              checked={settings.discoveryEnabled !== false}
              busy={act.isBusy('discovery')}
              onChange={(on) => act.run(() => updateSettings({ discoveryEnabled: on }), {
                key: 'discovery', about: `Couldn't turn LAN discovery ${on ? 'on' : 'off'}`,
              })}
            />
            <CommandErrors className="mt-2" commands={[act]} prefix={(_key, _cmd, about) => about} />
            {editing && (
              <SettingsEditor
                title="This server"
                initial={() => serverForm(settings)}
                sent={serverSent}
                problem={serverProblem}
                send={updateSettings}
                onClose={() => setEditing(false)}
              >
                {({ form, setField }) => (
                  <>
                    <FormField label="Name" htmlFor="server-name" hint="Shown in the top bar. Empty: My Server.">
                      <input id="server-name" ref={autoFocusField} type="text" value={form.serverName} onChange={(e) => setField('serverName', e.target.value)} placeholder="My Server" className="input-field" />
                    </FormField>
                    <FormField
                      label="Advertised URL"
                      htmlFor="server-url"
                      hint="The full URL browsers and other Wisp servers open this one by (behind a reverse proxy, say); it also sets the SSO redirect URI. Empty: http://<host name>.local:<port>."
                    >
                      <input id="server-url" type="text" value={form.advertisedUrl} onChange={(e) => setField('advertisedUrl', e.target.value)} placeholder="https://wisp.example.com" autoComplete="off" spellCheck={false} className="input-field font-mono" />
                    </FormField>
                  </>
                )}
              </SettingsEditor>
            )}
          </>
        )}
      </RecordGate>
    </Card>
  );
}

/** Where VM directories and the image library live. */
function StoragePathsGroup({ record }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card
      title="Storage paths"
      actions={<GroupAction icon={Pencil} label="Edit the storage paths" reason={record.data ? undefined : 'the settings are loading'} onClick={() => setEditing(true)} />}
    >
      <RecordGate record={record} what="settings">
        {(settings) => (
          <>
            <ValueRows
              rows={[
                { label: 'VMs', value: settings.vmsPath, mono: true },
                { label: 'Image library', value: settings.imagePath, mono: true },
              ]}
            />
            {editing && (
              <SettingsEditor
                title="Storage paths"
                initial={() => pathsForm(settings)}
                sent={pathsSent}
                problem={pathsProblem}
                send={updateSettings}
                onClose={() => setEditing(false)}
              >
                {({ form, setField }) => (
                  <>
                    <FormField label="VM storage path" htmlFor="paths-vms" hint="Each VM’s disks and settings live in a folder of its own here.">
                      <input id="paths-vms" ref={autoFocusField} type="text" value={form.vmsPath} onChange={(e) => setField('vmsPath', e.target.value)} placeholder="/var/lib/wisp/vms" autoComplete="off" spellCheck={false} className="input-field font-mono" />
                    </FormField>
                    <FormField label="Image library path" htmlFor="paths-images" hint="ISOs and disk images.">
                      <input id="paths-images" type="text" value={form.imagePath} onChange={(e) => setField('imagePath', e.target.value)} placeholder="/var/lib/wisp/images" autoComplete="off" spellCheck={false} className="input-field font-mono" />
                    </FormField>
                    <p className="text-[11px] text-text-muted">VMs and images already there stay where they are; a restart may be needed.</p>
                  </>
                )}
              </SettingsEditor>
            )}
          </>
        )}
      </RecordGate>
    </Card>
  );
}
