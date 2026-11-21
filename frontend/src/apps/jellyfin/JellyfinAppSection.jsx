/**
 * Jellyfin app configuration — define one or more media libraries (each
 * mounted at /media/<label> from a Storage source), an optional GPU hardware
 * acceleration toggle, and the published URL Jellyfin advertises to clients
 * on the LAN.
 */
import { useMemo, useCallback, useState } from 'react';
import { Cpu, Folder, Pencil, Plus, Trash2 } from 'lucide-react';

import SectionCard from '../../components/shared/SectionCard.jsx';
import Toggle from '../../components/shared/Toggle.jsx';
import HelpIcon from '../../components/shared/HelpIcon.jsx';
import JellyfinLibraryEditorModal from './JellyfinLibraryEditorModal.jsx';
import RecordGate from '../../components/shared/RecordGate.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { useForm } from '../../hooks/useForm.js';
import { rowId } from '../../hooks/formState.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';

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

function librariesFromConfig(config) {
  const ac = config?.metadata?.appConfig || {};
  const list = Array.isArray(ac.libraries) ? ac.libraries : [];
  /* A row's id is its identity in this form only (new at every reset), never sent. */
  return list.map((lib) => ({
    rowId: rowId(),
    label: lib?.label || '',
    sourceId: lib?.sourceId || '',
    subPath: lib?.subPath || '',
  }));
}

function parseAppConfig(config) {
  const ac = config?.metadata?.appConfig || {};
  return {
    libraries: librariesFromConfig(config),
    gpuEnabled: !!ac.gpuEnabled,
    publishedUrl: ac.publishedUrl || '',
  };
}

/** What Save sends for the form. */
function appConfigToSend(form) {
  return {
    libraries: form.libraries.map((lib) => ({
      label: (lib.label || '').trim(),
      sourceId: lib.sourceId,
      subPath: (lib.subPath || '').trim(),
    })),
    gpuEnabled: form.gpuEnabled,
    publishedUrl: form.publishedUrl,
  };
}

/** What a library row lacks to be saved (`libraries`: every row, for duplicates), or null. */
function libraryRowError(lib, libraries) {
  const label = (lib.label || '').trim();
  if (!label) return 'Label required';
  if (!isValidLibraryLabel(label)) {
    if (RESERVED_LIBRARY_LABELS.has(label)) return `"${label}" is reserved`;
    return 'Invalid label';
  }
  if (libraries.filter((other) => (other.label || '').trim() === label).length > 1) return 'Duplicate label';
  if (!lib.sourceId) return 'Source required';
  if (!isValidSubPath(lib.subPath)) return 'Invalid sub-path';
  return null;
}

/** What keeps the libraries from being saved, by the row each is about. */
function libraryProblems(form) {
  const problems = {};
  form.libraries.forEach((lib, i) => {
    const error = libraryRowError(lib, form.libraries);
    if (error) problems[`libraries.${i}`] = `Library ${(lib.label || '').trim() || i + 1}: ${error}`;
  });
  return problems;
}

export default function JellyfinAppSection({ config, onSave }) {
  const settingsRecord = useRecord(RECORD.SETTINGS);
  const settings = settingsRecord.data;

  /* The form follows the container's config record until it is edited. */
  const record = useRecord(RECORD.CONTAINER, config.name);
  const { form, setForm, dirty, saving, save: saveForm } = useForm(record, parseAppConfig, appConfigToSend);
  /* A library row with a problem shows it under the row, and keeps Save off. */
  const problems = libraryProblems(form);
  const blocked = Object.values(problems)[0] ?? null;
  const gpus = useRecord(RECORD.HOST_GPUS);
  const hostGpus = gpus.data ? (Array.isArray(gpus.data.gpus) ? gpus.data.gpus : []) : (gpus.error ? [] : null);
  /* A failed read of the host's GPUs shows once, in the Devices section: here the
   * choice is only unavailable. */
  const gpuUnknown = gpus.data == null && gpus.status === 'error';
  const save = useCommand();

  const storageMounts = useMemo(() => settings?.mounts || [], [settings]);


  const gpuAvailable = Array.isArray(hostGpus) && hostGpus.length > 0;
  const gpuLabel = gpuAvailable
    ? `${hostGpus[0].vendorName || hostGpus[0].vendor}${hostGpus[0].model ? ` — ${hostGpus[0].model}` : ''}`
    : null;

  const removeLibrary = useCallback((id) => {
    setForm((f) => ({ ...f, libraries: f.libraries.filter((lib) => lib.rowId !== id) }));
  }, [setForm]);

  /* The library editor: the row it edits (null to add one) and the form as it was when
   * it opened. A reset of the form (a save elsewhere) closes it, and an edit whose row
   * is gone never applies to another. */
  const [editor, setEditor] = useState(null);
  const editingLibrary = editor?.rowId != null
    ? form.libraries.find((lib) => lib.rowId === editor.rowId) || null
    : null;
  const editorOpen = editor != null && (editor.rowId == null || editingLibrary != null);

  const validateModalLabel = useCallback((label, editing) => {
    const t = (label || '').trim();
    if (!t) return 'Label is required';
    if (!isValidLibraryLabel(t)) {
      if (RESERVED_LIBRARY_LABELS.has(t)) return `"${t}" is reserved`;
      return 'No slashes, leading dots, or ".."';
    }
    const clash = form.libraries.some(
      (lib) => lib.rowId !== editing?.rowId && (lib.label || '').trim() === t,
    );
    return clash ? 'A library with this label already exists' : null;
  }, [form.libraries]);

  const editingRow = editor?.rowId ?? null;
  const applyLibrary = useCallback((values) => {
    setForm((f) => (editingRow != null
      ? { ...f, libraries: f.libraries.map((lib) => (lib.rowId === editingRow ? { ...lib, ...values } : lib)) }
      : { ...f, libraries: [...f.libraries, { rowId: rowId(), ...values }] }));
  }, [editingRow, setForm]);

  const handleSave = () => saveForm((appConfig) => save.run(() => onSave(appConfig)));

  return (
    <SectionCard
      title="Jellyfin"
      requiresRestart={!!config?.pendingRestart}
      commands={[save]}
      onSave={handleSave}
      saving={saving}
      isDirty={dirty}
      saveDisabledReason={blocked ?? undefined}
    >
      <RecordGate record={settingsRecord} what="storage settings">
        {() => (
          <>
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
                  <div className="space-y-1">
                    {form.libraries.map((lib, i) => {
                      const err = problems[`libraries.${i}`] ?? null;
                      const source = storageMounts.find((m) => m.id === lib.sourceId);
                      return (
                        <div key={lib.rowId} className="space-y-0.5">
                          <div className="flex items-center gap-2 rounded-md border border-surface-border px-2.5 py-1.5">
                            <span className="shrink-0 font-mono text-xs text-text-primary">/media/{(lib.label || '?').trim() || '?'}</span>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
                              {source ? (source.label || source.id) : lib.sourceId || '—'}
                              {lib.subPath ? ` / ${lib.subPath}` : ''}
                            </span>
                            <button
                              type="button"
                              className={iconBtn}
                              title="Edit library"
                              aria-label="Edit library"
                              onClick={() => setEditor({ rowId: lib.rowId })}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              className={`${iconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`}
                              title="Remove library"
                              aria-label="Remove library"
                              onClick={() => removeLibrary(lib.rowId)}
                            >
                              <Trash2 size={13} />
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
                    onClick={() => setEditor({ rowId: null })}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>

              <JellyfinLibraryEditorModal
                open={editorOpen}
                library={editingLibrary}
                storageMounts={storageMounts}
                validateLabel={validateModalLabel}
                validateSubPath={isValidSubPath}
                onApply={applyLibrary}
                onClose={() => setEditor(null)}
              />

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
                  className="input-field text-xs"
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
                      : hostGpus == null ? 'Checking the host for a GPU…'
                        : gpuUnknown ? 'Unavailable: the host GPUs could not be listed (see Devices).'
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
          </>
        )}
      </RecordGate>
    </SectionCard>
  );
}
