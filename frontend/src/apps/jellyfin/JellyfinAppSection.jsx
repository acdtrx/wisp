/**
 * Jellyfin app configuration — define one or more media libraries (each
 * mounted at /media/<label> from a Storage source), an optional GPU hardware
 * acceleration toggle, and the published URL Jellyfin advertises to clients
 * on the LAN.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Cpu, Folder, Plus, X } from 'lucide-react';

import SectionCard from '../../components/shared/SectionCard.jsx';
import Toggle from '../../components/shared/Toggle.jsx';
import HelpIcon from '../../components/shared/HelpIcon.jsx';
import { useSettingsStore } from '../../store/settingsStore.js';
import { getHostGpus } from '../../api/host.js';

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

const RESERVED_LIBRARY_LABELS = new Set(['config', 'cache']);

function isValidLibraryLabel(label) {
  if (!label || typeof label !== 'string') return false;
  const t = label.trim();
  if (!t) return false;
  if (t.includes('/') || t.includes('\\') || t.includes('..')) return false;
  if (t.startsWith('.')) return false;
  if (RESERVED_LIBRARY_LABELS.has(t)) return false;
  return true;
}

function isValidSubPath(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  const t = value.trim();
  if (t === '') return true;
  if (t.startsWith('/')) return false;
  return !t.split('/').filter(Boolean).some((seg) => seg === '..' || seg === '.');
}

let nextRowId = 1;
function makeRowId() {
  nextRowId += 1;
  return `lib-${Date.now()}-${nextRowId}`;
}

function librariesFromConfig(config) {
  const ac = config?.appConfig || {};
  const list = Array.isArray(ac.libraries) ? ac.libraries : [];
  return list.map((lib) => ({
    rowId: makeRowId(),
    label: lib?.label || '',
    sourceId: lib?.sourceId || '',
    subPath: lib?.subPath || '',
  }));
}

function parseAppConfig(config) {
  const ac = config?.appConfig || {};
  return {
    libraries: librariesFromConfig(config),
    gpuEnabled: !!ac.gpuEnabled,
    publishedUrl: ac.publishedUrl || '',
  };
}

function librariesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if ((x.label || '') !== (y.label || '')) return false;
    if ((x.sourceId || '') !== (y.sourceId || '')) return false;
    if ((x.subPath || '') !== (y.subPath || '')) return false;
  }
  return true;
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
    !librariesEqual(form.libraries, original.libraries)
    || form.gpuEnabled !== original.gpuEnabled
    || form.publishedUrl !== original.publishedUrl
  ), [form, original]);

  const labelCounts = useMemo(() => {
    const counts = new Map();
    for (const lib of form.libraries) {
      const key = (lib.label || '').trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [form.libraries]);

  const rowError = useCallback((lib) => {
    const label = (lib.label || '').trim();
    if (!label) return 'Label required';
    if (!isValidLibraryLabel(label)) {
      if (RESERVED_LIBRARY_LABELS.has(label)) return `"${label}" is reserved`;
      return 'Invalid label';
    }
    if ((labelCounts.get(label) || 0) > 1) return 'Duplicate label';
    if (!lib.sourceId) return 'Source required';
    if (!isValidSubPath(lib.subPath)) return 'Invalid sub-path';
    return null;
  }, [labelCounts]);

  const hasRowErrors = useMemo(
    () => form.libraries.some((lib) => rowError(lib) !== null),
    [form.libraries, rowError],
  );

  const gpuAvailable = Array.isArray(hostGpus) && hostGpus.length > 0;
  const gpuLabel = gpuAvailable
    ? `${hostGpus[0].vendorName || hostGpus[0].vendor}${hostGpus[0].model ? ` — ${hostGpus[0].model}` : ''}`
    : null;

  const updateLibrary = useCallback((rowId, patch) => {
    setForm((f) => ({
      ...f,
      libraries: f.libraries.map((lib) => (lib.rowId === rowId ? { ...lib, ...patch } : lib)),
    }));
  }, []);

  const removeLibrary = useCallback((rowId) => {
    setForm((f) => ({ ...f, libraries: f.libraries.filter((lib) => lib.rowId !== rowId) }));
  }, []);

  const addLibrary = useCallback(() => {
    setForm((f) => ({
      ...f,
      libraries: [...f.libraries, { rowId: makeRowId(), label: '', sourceId: '', subPath: '' }],
    }));
  }, []);

  const handleSave = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      const appConfig = {
        libraries: form.libraries.map((lib) => ({
          label: (lib.label || '').trim(),
          sourceId: lib.sourceId,
          subPath: (lib.subPath || '').trim(),
        })),
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
      isDirty={dirty && !hasRowErrors}
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
            <Folder size={12} />
            Media libraries
            <HelpIcon
              size={12}
              text="Each library mounts a Storage source (Host Mgmt → Storage) at /media/<label>. Add the matching libraries inside Jellyfin's Dashboard pointing to those paths."
            />
          </div>
          {form.libraries.length === 0 ? (
            <p className="text-[11px] text-text-muted">
              No libraries configured. Add one to mount a Storage source at <code>/media/&lt;label&gt;</code> inside the container.
            </p>
          ) : (
            <div className="space-y-1.5">
              {form.libraries.map((lib) => {
                const err = rowError(lib);
                return (
                  <div key={lib.rowId} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="Label (e.g. movies)"
                        value={lib.label}
                        onChange={(e) => updateLibrary(lib.rowId, { label: e.target.value })}
                        className="w-32 shrink-0 rounded-md border border-surface-border bg-white px-2 py-1 text-xs"
                      />
                      <select
                        value={lib.sourceId}
                        onChange={(e) => updateLibrary(lib.rowId, { sourceId: e.target.value })}
                        className="h-[26px] min-w-0 flex-1 rounded-md border border-surface-border bg-white px-2 py-0 text-xs"
                      >
                        <option value="">— Select Storage source —</option>
                        {storageMounts.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label || m.id} ({m.mountPath})
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        placeholder="Sub-path (optional)"
                        value={lib.subPath}
                        onChange={(e) => updateLibrary(lib.rowId, { subPath: e.target.value })}
                        className="min-w-0 flex-1 rounded-md border border-surface-border bg-white px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        className={`${iconBtn} text-text-muted hover:text-status-stopped hover:bg-red-50`}
                        title="Remove library"
                        aria-label="Remove library"
                        onClick={() => removeLibrary(lib.rowId)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {err && (
                      <p className="text-[11px] text-status-stopped">{err}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-2">
            <button
              type="button"
              className={iconBtn}
              title="Add library"
              aria-label="Add library"
              onClick={addLibrary}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-text-muted" htmlFor="jellyfin-published-url">
            Published server URL
            <HelpIcon
              size={12}
              text="Address Jellyfin advertises to clients (apps, browsers). Defaults to the container's mDNS hostname."
            />
          </label>
          <input
            id="jellyfin-published-url"
            type="text"
            placeholder="http://jellyfin.local:8096"
            value={form.publishedUrl}
            onChange={(e) => setForm((f) => ({ ...f, publishedUrl: e.target.value }))}
            className="w-full rounded-md border border-surface-border bg-white px-2 py-1 text-xs"
          />
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
