import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
import PasswordChangeForm from '../settings/PasswordChangeForm.jsx';
import OidcSettings from '../settings/OidcSettings.jsx';
import ApiTokensSettings from '../settings/ApiTokensSettings.jsx';
import { useSettingsStore } from '../../store/settingsStore.js';
import { updateSettings } from '../../api/settings.js';

export default function AppConfig() {
  const settings = useSettingsStore((s) => s.settings);
  const settingsLoading = useSettingsStore((s) => s.loading);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const setSettings = useSettingsStore((s) => s.setSettings);

  const [serverName, setServerName] = useState('');
  const [vmsPath, setVmsPath] = useState('');
  const [imagePath, setImagePath] = useState('');
  const [discoveryEnabled, setDiscoveryEnabled] = useState(true);
  const [advertisedUrl, setAdvertisedUrl] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (settings) {
      setServerName(settings.serverName || '');
      setVmsPath(settings.vmsPath ?? '');
      setImagePath(settings.imagePath ?? '');
      setDiscoveryEnabled(settings.discoveryEnabled !== false);
      setAdvertisedUrl(settings.advertisedUrl ?? '');
    }
  }, [settings]);

  useEffect(() => {
    setDirty(
      settings != null &&
      (serverName !== (settings.serverName || '') ||
        vmsPath !== (settings.vmsPath ?? '') ||
        imagePath !== (settings.imagePath ?? '') ||
        discoveryEnabled !== (settings.discoveryEnabled !== false) ||
        advertisedUrl !== (settings.advertisedUrl ?? ''))
    );
  }, [settings, serverName, vmsPath, imagePath, discoveryEnabled, advertisedUrl]);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const updated = await updateSettings({
        serverName: serverName.trim() || undefined,
        vmsPath: vmsPath.trim().startsWith('/') ? vmsPath.trim() : undefined,
        imagePath: imagePath.trim().startsWith('/') ? imagePath.trim() : undefined,
        discoveryEnabled,
        // explicit null clears back to the default announcement
        advertisedUrl: advertisedUrl.trim() || null,
      });
      setSettings(updated);
      await loadSettings();
      setDirty(false);
    } catch (err) {
      setError(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5 space-y-5">
      <SectionCard
        title="General"
        onSave={handleSave}
        saving={saving}
        isDirty={dirty}
        error={error}
      >
        {settingsLoading && !settings ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-4">
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                  Server display name
                </label>
                <input
                  type="text"
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
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
                  value={vmsPath}
                  onChange={(e) => setVmsPath(e.target.value)}
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
                  value={imagePath}
                  onChange={(e) => setImagePath(e.target.value)}
                  placeholder="/var/lib/wisp/images"
                  className="input-field font-mono placeholder:text-text-muted w-full max-w-md"
                />
                <p className="mt-1 text-[10px] text-text-muted">Path for ISOs and disk images.</p>
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1">
                  LAN discovery
                </label>
                <Toggle checked={discoveryEnabled} onChange={setDiscoveryEnabled} />
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
                  value={advertisedUrl}
                  onChange={(e) => setAdvertisedUrl(e.target.value)}
                  placeholder="http://myserver.local:8080"
                  disabled={!discoveryEnabled}
                  className="input-field font-mono placeholder:text-text-muted w-full max-w-md disabled:opacity-60"
                />
                <p className="mt-1 text-[10px] text-text-muted">
                  Full URL other Wisp servers use to open this one (e.g. behind a reverse proxy).
                  Leave empty to announce http://&lt;hostname&gt;.local:&lt;port&gt;.
                </p>
              </div>
            </div>
            <PasswordChangeForm />
          </div>
        )}
      </SectionCard>

      <OidcSettings />

      <ApiTokensSettings />
    </div>
  );
}
