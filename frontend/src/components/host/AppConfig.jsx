import { useState } from 'react';
import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import PasswordChangeForm from '../settings/PasswordChangeForm.jsx';
import OidcSettings from '../settings/OidcSettings.jsx';
import ApiTokensSettings from '../settings/ApiTokensSettings.jsx';
import { updateSettings } from '../../api/settings.js';
import RecordGate from '../shared/RecordGate.jsx';
import { errorText } from '../../api/errors.js';
import { sendAndAwaitKindChange } from '../../api/events.js';
import { CHANGE_KIND } from '../../../../shared/wireNames.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useForm } from '../../hooks/useForm.js';
import RecordError from '../shared/RecordError.jsx';

function formFromSettings(settings) {
  return {
    serverName: settings.serverName || '',
    vmsPath: settings.vmsPath ?? '',
    imagePath: settings.imagePath ?? '',
    discoveryEnabled: settings.discoveryEnabled !== false,
    advertisedUrl: settings.advertisedUrl ?? '',
  };
}

export default function AppConfig() {
  const settingsRecord = useRecord(RECORD.SETTINGS);
  const { form, setField, dirty, save } = useForm(settingsRecord, formFromSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await save(async (sent) => {
        await sendAndAwaitKindChange(CHANGE_KIND.SETTINGS, () => updateSettings({
          serverName: sent.serverName.trim() || undefined,
          vmsPath: sent.vmsPath.trim(),
          imagePath: sent.imagePath.trim(),
          discoveryEnabled: sent.discoveryEnabled,
          // explicit null clears back to the default announcement
          advertisedUrl: sent.advertisedUrl.trim() || null,
        }));
        return true;
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5 space-y-5">
      {settingsRecord.data != null && <RecordError record={settingsRecord} what="settings" />}

      <SectionCard
        title="General"
        onSave={handleSave}
        saving={saving}
        isDirty={dirty}
        error={error}
        onDismissError={() => setError(null)}
      >
        <RecordGate record={settingsRecord} what="settings">
          {() => (
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                    Server display name
                  </label>
                  <input
                    type="text"
                    value={form.serverName}
                    onChange={(e) => setField('serverName', e.target.value)}
                    placeholder="My Server"
                    className="input-field placeholder:text-text-muted"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                    VM storage path
                  </label>
                  <input
                    type="text"
                    value={form.vmsPath}
                    onChange={(e) => setField('vmsPath', e.target.value)}
                    placeholder="/var/lib/wisp/vms"
                    className="input-field font-mono placeholder:text-text-muted w-full max-w-md"
                  />
                  <p className="mt-1 text-[10px] text-text-muted">Base path for VM disks and config. Restart may be needed after change.</p>
                </div>
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                    Image library path
                  </label>
                  <input
                    type="text"
                    value={form.imagePath}
                    onChange={(e) => setField('imagePath', e.target.value)}
                    placeholder="/var/lib/wisp/images"
                    className="input-field font-mono placeholder:text-text-muted w-full max-w-md"
                  />
                  <p className="mt-1 text-[10px] text-text-muted">Path for ISOs and disk images.</p>
                </div>
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                    LAN discovery
                  </label>
                  <Toggle checked={form.discoveryEnabled} onChange={(on) => setField('discoveryEnabled', on)} />
                  <p className="mt-1 text-[10px] text-text-muted">
                    Announce this server on the local network and list other Wisp servers in the top bar.
                  </p>
                </div>
                <div>
                  <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                    Advertised URL
                  </label>
                  <input
                    type="text"
                    value={form.advertisedUrl}
                    onChange={(e) => setField('advertisedUrl', e.target.value)}
                    placeholder="http://myserver.local:8080"
                    className="input-field font-mono placeholder:text-text-muted w-full max-w-md"
                  />
                  <p className="mt-1 text-[10px] text-text-muted">
                    Full URL browsers and other Wisp servers use to open this one (e.g. behind a reverse proxy).
                    Also sets the SSO redirect URI. Leave empty to announce http://&lt;hostname&gt;.local:&lt;port&gt;.
                  </p>
                </div>
              </div>
              <PasswordChangeForm />
            </div>
          )}
        </RecordGate>
      </SectionCard>

      <OidcSettings />

      <ApiTokensSettings />
    </div>
  );
}
