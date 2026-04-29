/**
 * Jellyfin app configuration — pick a media library Storage source, optional
 * GPU hardware acceleration toggle, and the published URL Jellyfin advertises
 * to clients on the LAN.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Cpu, Folder } from 'lucide-react';

import SectionCard from '../../components/shared/SectionCard.jsx';
import Toggle from '../../components/shared/Toggle.jsx';
import { useSettingsStore } from '../../store/settingsStore.js';
import { getHostGpus } from '../../api/host.js';

function parseAppConfig(config) {
  const ac = config?.appConfig || {};
  const media = (ac.media && typeof ac.media === 'object') ? ac.media : {};
  return {
    sourceId: media.sourceId || '',
    subPath: media.subPath || '',
    gpuEnabled: !!ac.gpuEnabled,
    publishedUrl: ac.publishedUrl || '',
  };
}

export default function JellyfinAppSection({ config, onSave }) {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  const [form, setForm] = useState(() => parseAppConfig(config));
  const [original, setOriginal] = useState(() => parseAppConfig(config));
  const [hostGpus, setHostGpus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);

  const storageMounts = useMemo(() => settings?.mounts || [], [settings]);

  useEffect(() => {
    if (!settings) loadSettings().catch(() => {});
  }, [settings, loadSettings]);

  useEffect(() => {
    let cancelled = false;
    getHostGpus()
      .then((res) => { if (!cancelled) setHostGpus(Array.isArray(res?.gpus) ? res.gpus : []); })
      .catch(() => { if (!cancelled) setHostGpus([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const parsed = parseAppConfig(config);
    setForm(parsed);
    setOriginal(parsed);
    setRequiresRestart(false);
    setError(null);
  }, [JSON.stringify(config?.appConfig)]);

  const dirty = useMemo(() => (
    form.sourceId !== original.sourceId
    || form.subPath !== original.subPath
    || form.gpuEnabled !== original.gpuEnabled
    || form.publishedUrl !== original.publishedUrl
  ), [form, original]);

  const gpuAvailable = Array.isArray(hostGpus) && hostGpus.length > 0;
  const gpuLabel = gpuAvailable
    ? `${hostGpus[0].vendorName || hostGpus[0].vendor}${hostGpus[0].model ? ` — ${hostGpus[0].model}` : ''}`
    : null;

  const handleSave = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      const appConfig = {
        media: {
          sourceId: form.sourceId || null,
          subPath: form.sourceId ? form.subPath : '',
        },
        gpuEnabled: form.gpuEnabled,
        publishedUrl: form.publishedUrl,
      };
      const result = await onSave(appConfig);
      if (result?.requiresRestart) setRequiresRestart(true);
      setOriginal(form);
    } catch (err) {
      setError(err?.detail || err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [form, onSave]);

  return (
    <SectionCard
      title="Jellyfin"
      requiresRestart={requiresRestart || !!config.pendingRestart}
      error={error}
      onSave={handleSave}
      saving={saving}
      isDirty={dirty}
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-text-muted" htmlFor="jellyfin-media-source">
            <Folder size={12} />
            Media library
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr]">
            <select
              id="jellyfin-media-source"
              value={form.sourceId}
              onChange={(e) => setForm((f) => ({ ...f, sourceId: e.target.value }))}
              className="rounded-md border border-surface-border bg-white px-2 py-1 text-xs"
            >
              <option value="">— None (local /media) —</option>
              {storageMounts.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label || m.id} ({m.mountPath})
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Sub-path (optional)"
              disabled={!form.sourceId}
              value={form.subPath}
              onChange={(e) => setForm((f) => ({ ...f, subPath: e.target.value }))}
              className="rounded-md border border-surface-border bg-white px-2 py-1 text-xs disabled:bg-surface-card disabled:text-text-muted"
            />
          </div>
          <p className="mt-1 text-[11px] text-text-muted">
            Pick a Storage source from Host Mgmt → Storage (SMB share, removable disk, etc). Leave empty to start without a library — you can add one later.
          </p>
        </div>

        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-text-muted" htmlFor="jellyfin-published-url">
            Published server URL
          </label>
          <input
            id="jellyfin-published-url"
            type="text"
            placeholder="http://jellyfin.local:8096"
            value={form.publishedUrl}
            onChange={(e) => setForm((f) => ({ ...f, publishedUrl: e.target.value }))}
            className="w-full rounded-md border border-surface-border bg-white px-2 py-1 text-xs"
          />
          <p className="mt-1 text-[11px] text-text-muted">
            Address Jellyfin advertises to clients (apps, browsers). Defaults to the container&apos;s mDNS hostname.
          </p>
        </div>

        <div className="flex items-start justify-between gap-3 rounded-md border border-surface-border bg-surface-card px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-text">
              <Cpu size={12} className="text-text-muted" />
              Hardware acceleration
            </div>
            <p className="mt-0.5 text-[11px] text-text-muted">
              {gpuAvailable
                ? `Expose the host GPU (${gpuLabel}) to Jellyfin. After enabling, turn on hardware acceleration in Jellyfin's Dashboard → Playback (VAAPI / device /dev/dri/renderD128).`
                : 'No supported GPU detected on the host (Intel/AMD render nodes only in v1).'}
            </p>
          </div>
          <Toggle
            checked={form.gpuEnabled}
            onChange={(v) => setForm((f) => ({ ...f, gpuEnabled: v }))}
            disabled={!gpuAvailable || saving}
          />
        </div>

      </div>
    </SectionCard>
  );
}
