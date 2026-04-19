import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Upload, Trash2, Pencil, Check, X, HardDrive, Disc, FileQuestion, Link, Loader2, Package, Images, RefreshCw } from 'lucide-react';

import {
  listFiles,
  deleteFile,
  renameFile,
  uploadFile,
  checkDownloadUrl,
  startDownloadFromUrl,
  startDownloadUbuntuCloud,
  startDownloadHaos,
  startDownloadArchCloud,
} from '../../api/library.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { useContainerStore } from '../../store/containerStore.js';
import { JOB_KIND } from '../../api/jobProgress.js';
import { listContainerImages, deleteContainerImage } from '../../api/containers.js';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import SectionCard from '../shared/SectionCard.jsx';
import PresetImageDownloadMenu from './PresetImageDownloadMenu.jsx';
import {
  DataTableScroll,
  DataTable,
  dataTableHeadRowClass,
  dataTableInteractiveRowClass,
  DataTableRowActions,
  DataTableTh,
  DataTableTd,
} from '../shared/DataTableChrome.jsx';
import { formatSize, formatRelativeTime } from '../../utils/formatters.js';

const FILTERS_PAGE = [
  { key: 'all', label: 'All' },
  { key: 'iso', label: 'ISO' },
  { key: 'disk', label: 'Disk Image' },
  { key: 'container', label: 'OCI' },
];

const FILTERS_PICKER = [
  { key: 'all', label: 'All' },
  { key: 'iso', label: 'ISO' },
  { key: 'disk', label: 'Disk Image' },
];

const FILTERS_PICKER_CONTAINER = [
  { key: 'container', label: 'OCI' },
];

function shortDigest(digest) {
  if (!digest) return '—';
  const s = String(digest).replace(/^sha256:/, '');
  return s.length > 14 ? `${s.slice(0, 14)}…` : s;
}

function OciTypeBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
      <Package size={12} /> OCI
    </span>
  );
}

function LibraryTableHead({ mode, compactPicker }) {
  return (
    <tr className={dataTableHeadRowClass}>
      <DataTableTh>Name</DataTableTh>
      <DataTableTh>Type</DataTableTh>
      {!compactPicker && <DataTableTh>Digest</DataTableTh>}
      <DataTableTh>Size</DataTableTh>
      {!compactPicker && <DataTableTh>Modified</DataTableTh>}
      <DataTableTh align="right">{mode === 'picker' ? '' : 'Actions'}</DataTableTh>
    </tr>
  );
}

function ContainerImageRow({ row, mode, onSelect, onDelete, compactPicker, onCheckUpdate, checkState }) {
  const thisChecking = checkState?.running && checkState.currentRef === row.name;
  const anyChecking = !!checkState?.running;
  return (
    <tr className={dataTableInteractiveRowClass}>
      <DataTableTd className="max-w-[14rem] break-all text-sm font-medium text-text-primary">{row.name}</DataTableTd>
      <DataTableTd>
        <OciTypeBadge />
      </DataTableTd>
      {!compactPicker && (
        <DataTableTd className="font-mono text-xs text-text-secondary">{shortDigest(row.digest)}</DataTableTd>
      )}
      <DataTableTd className="text-sm text-text-secondary">{formatSize(row.size)}</DataTableTd>
      {!compactPicker && (
        <DataTableTd className="text-sm text-text-muted">{formatRelativeTime(row.updated)}</DataTableTd>
      )}
      <DataTableTd align="right">
        {mode === 'picker' ? (
          <button
            type="button"
            onClick={() => onSelect?.({ kind: 'oci', name: row.name, digest: row.digest })}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150"
          >
            Select
          </button>
        ) : (
          <DataTableRowActions>
            <button
              type="button"
              onClick={() => onCheckUpdate?.(row)}
              disabled={anyChecking}
              className="rounded p-1.5 text-text-secondary hover:bg-surface-sidebar hover:text-text-primary disabled:opacity-50"
              title="Check this image for updates"
              aria-label={`Check image ${row.name} for updates`}
            >
              {thisChecking
                ? <Loader2 size={14} className="animate-spin" aria-hidden />
                : <RefreshCw size={14} aria-hidden />}
            </button>
            <button
              type="button"
              onClick={() => onDelete(row)}
              className="rounded p-1.5 text-text-secondary hover:bg-red-50 hover:text-status-stopped"
              title="Delete"
              aria-label={`Delete image ${row.name}`}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </DataTableRowActions>
        )}
      </DataTableTd>
    </tr>
  );
}

function TypeBadge({ type }) {
  if (type === 'iso') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
        <Disc size={12} /> ISO
      </span>
    );
  }
  if (type === 'disk') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700">
        <HardDrive size={12} /> Disk Image
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-500">
      <FileQuestion size={12} /> Other
    </span>
  );
}

function FileRow({ file, mode, compactPicker, onSelect, onDelete, onRename }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(file.name);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      const dotIdx = editValue.lastIndexOf('.');
      inputRef.current.setSelectionRange(0, dotIdx > 0 ? dotIdx : editValue.length);
    }
  }, [editing]);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== file.name) {
      onRename(file.name, trimmed);
    }
    setEditing(false);
  };

  const cancelRename = () => {
    setEditValue(file.name);
    setEditing(false);
  };

  return (
    <tr className={dataTableInteractiveRowClass}>
      <DataTableTd>
        {editing ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') cancelRename();
              }}
              className="rounded border border-surface-border bg-white px-2 py-0.5 text-sm text-text-primary outline-none focus:border-accent"
            />
            <button type="button" onClick={commitRename} className="rounded p-0.5 text-status-running hover:bg-green-50" title="Confirm rename" aria-label="Confirm rename">
              <Check size={14} aria-hidden />
            </button>
            <button type="button" onClick={cancelRename} className="rounded p-0.5 text-text-muted hover:bg-gray-100" title="Cancel rename" aria-label="Cancel rename">
              <X size={14} aria-hidden />
            </button>
          </div>
        ) : (
          <span className="text-sm font-medium text-text-primary">{file.name}</span>
        )}
      </DataTableTd>
      <DataTableTd>
        <TypeBadge type={file.type} />
      </DataTableTd>
      {!compactPicker && (
        <DataTableTd className="font-mono text-xs text-text-muted">—</DataTableTd>
      )}
      <DataTableTd className="text-sm text-text-secondary">{formatSize(file.size)}</DataTableTd>
      {!compactPicker && (
        <DataTableTd className="text-sm text-text-muted">{formatRelativeTime(file.modified)}</DataTableTd>
      )}
      <DataTableTd align="right">
        {mode === 'picker' ? (
          <button
            type="button"
            onClick={() => onSelect(file)}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150"
          >
            Select
          </button>
        ) : (
          <DataTableRowActions forceVisible={editing}>
            <button
              type="button"
              onClick={() => { setEditValue(file.name); setEditing(true); }}
              className="rounded p-1.5 text-text-secondary hover:bg-surface-sidebar hover:text-text-primary"
              title="Rename"
              aria-label={`Rename ${file.name}`}
            >
              <Pencil size={14} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => onDelete(file)}
              className="rounded p-1.5 text-text-secondary hover:bg-red-50 hover:text-status-stopped"
              title="Delete"
              aria-label={`Delete ${file.name}`}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </DataTableRowActions>
        )}
      </DataTableTd>
    </tr>
  );
}

export default function ImageLibrary({ mode = 'page', pickerKind = 'vm', onSelect, defaultFilter = 'all' }) {
  const filterTabs = useMemo(() => {
    if (mode === 'page') return FILTERS_PAGE;
    if (pickerKind === 'container') return FILTERS_PICKER_CONTAINER;
    return FILTERS_PICKER;
  }, [mode, pickerKind]);
  const registerJob = useBackgroundJobsStore((s) => s.registerJob);
  const bgJobs = useBackgroundJobsStore((s) => s.jobs);
  const imageUpdateCheck = useContainerStore((s) => s.imageUpdateCheck);
  const startImageUpdateCheck = useContainerStore((s) => s.startImageUpdateCheck);
  const refreshImageUpdateStatus = useContainerStore((s) => s.refreshImageUpdateStatus);

  const [files, setFiles] = useState([]);
  const [containerImages, setContainerImages] = useState([]);
  const [filter, setFilter] = useState(() => {
    if (mode === 'picker' && pickerKind === 'container') return 'container';
    if (mode === 'picker' && defaultFilter === 'container') return 'all';
    return defaultFilter;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState(null);

  /** @type {[{ kind: 'file', name: string } | { kind: 'oci', ref: string }] | null} */
  const [deleteTarget, setDeleteTarget] = useState(null);

  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlCheckResult, setUrlCheckResult] = useState(null);
  const [urlChecking, setUrlChecking] = useState(false);
  const [urlJobId, setUrlJobId] = useState(null);
  const [urlDownloadError, setUrlDownloadError] = useState(null);

  const [presetJobId, setPresetJobId] = useState(null);
  const [presetError, setPresetError] = useState(null);

  const urlRow = urlJobId ? bgJobs[urlJobId] : null;
  const urlDownloading = urlRow?.status === 'running';
  const urlDownloadProgress = urlRow?.percent ?? 0;

  const presetRow = presetJobId ? bgJobs[presetJobId] : null;
  const presetDownloading = presetJobId && presetRow?.status === 'running';
  const presetProgress = presetRow?.percent ?? 0;
  const presetPhase = presetRow?.step === 'decompressing' ? 'decompressing' : null;

  const fileInputRef = useRef(null);

  const isOciView = filter === 'container';
  const compactPicker = mode === 'picker';
  const tableMinWidthRem = compactPicker ? 32 : 56;

  useEffect(() => {
    if (mode === 'picker' && pickerKind !== 'container' && filter === 'container') {
      setFilter('all');
    }
  }, [mode, pickerKind, filter]);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (filter === 'container') {
        const data = await listContainerImages();
        setContainerImages(data);
        setFiles([]);
      } else if (mode === 'page' && filter === 'all') {
        const [fileData, ociData] = await Promise.all([
          listFiles(undefined),
          listContainerImages(),
        ]);
        setFiles(fileData);
        setContainerImages(ociData);
      } else {
        const apiFilter = filter === 'all' ? undefined : filter;
        const data = await listFiles(apiFilter);
        setFiles(data);
        setContainerImages([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filter, mode]);

  const mergedAllRows = useMemo(() => {
    if (mode !== 'page' || filter !== 'all') return null;
    const merged = [
      ...files.map((f) => ({ kind: 'file', file: f })),
      ...containerImages.map((o) => ({ kind: 'oci', oci: o })),
    ];
    merged.sort((a, b) => {
      const na = a.kind === 'file' ? a.file.name : a.oci.name;
      const nb = b.kind === 'file' ? b.file.name : b.oci.name;
      return na.localeCompare(nb);
    });
    return merged;
  }, [mode, filter, files, containerImages]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  /** Fetch cached update-check status once on mount so the "Checked X ago" line is populated. */
  useEffect(() => {
    refreshImageUpdateStatus();
  }, [refreshImageUpdateStatus]);

  /** When a check finishes, re-fetch images so new digests/sizes show up. */
  const updateCheckRunning = imageUpdateCheck.running;
  useEffect(() => {
    if (!updateCheckRunning) {
      fetchFiles();
    }
  }, [updateCheckRunning, fetchFiles]);

  const handleUpload = async (file) => {
    setUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    try {
      await uploadFile(file, setUploadProgress);
      await fetchFiles();
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleFileInput = (e) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = '';
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.kind === 'oci') {
        await deleteContainerImage(deleteTarget.ref);
      } else {
        await deleteFile(deleteTarget.name);
      }
      setDeleteTarget(null);
      await fetchFiles();
    } catch (err) {
      setError(err.message);
      setDeleteTarget(null);
    }
  };

  const handleRename = async (oldName, newName) => {
    try {
      await renameFile(oldName, newName);
      await fetchFiles();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUrlCheck = async () => {
    const url = urlInput.trim();
    if (!url) return;
    setUrlChecking(true);
    setUrlCheckResult(null);
    try {
      const result = await checkDownloadUrl(url);
      setUrlCheckResult(result);
    } catch (err) {
      setUrlCheckResult({ ok: false, error: err.message });
    } finally {
      setUrlChecking(false);
    }
  };

  const handleUrlDownload = async () => {
    const url = urlInput.trim();
    if (!url) return;
    setUrlDownloadError(null);
    try {
      const { jobId, title } = await startDownloadFromUrl(url);
      setUrlJobId(jobId);
      registerJob({
        jobId,
        kind: JOB_KIND.LIBRARY_DOWNLOAD,
        title,
        onTerminal: (data) => {
          if (data.step === 'done') {
            setUrlJobId(null);
            setUrlModalOpen(false);
            setUrlInput('');
            setUrlCheckResult(null);
            fetchFiles();
          }
          if (data.step === 'error') {
            setUrlDownloadError(data.error || 'Download failed');
            setUrlJobId(null);
          }
        },
      });
    } catch (err) {
      setUrlDownloadError(err.message);
      setUrlJobId(null);
    }
  };

  const closeUrlModal = () => {
    setUrlModalOpen(false);
    setUrlInput('');
    setUrlCheckResult(null);
    setUrlDownloadError(null);
    setUrlJobId(null);
  };

  const runPresetDownload = (jobId, label) => {
    setPresetError(null);
    setPresetJobId(jobId);
    registerJob({
      jobId,
      kind: JOB_KIND.LIBRARY_DOWNLOAD,
      title: label,
      onTerminal: (data) => {
        if (data.step === 'done') {
          queueMicrotask(() => fetchFiles());
        }
        setPresetJobId((current) => {
          if (current !== jobId) return current;
          if (data.step === 'done') {
            return null;
          }
          if (data.step === 'error') {
            queueMicrotask(() => setPresetError(data.error || 'Download failed'));
            return null;
          }
          return current;
        });
      },
    });
  };

  const handlePresetSelect = async (presetId) => {
    try {
      let result;
      if (presetId === 'ubuntu') result = await startDownloadUbuntuCloud();
      else if (presetId === 'arch') result = await startDownloadArchCloud();
      else if (presetId === 'haos') result = await startDownloadHaos();
      else return;
      const { jobId, title } = result;
      runPresetDownload(jobId, title);
    } catch (err) {
      setPresetError(err.message);
    }
  };

  const libraryHeaderAction = (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <div className="flex rounded-lg border border-surface-border bg-surface p-0.5">
        {filterTabs.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors duration-150 ${
              filter === f.key
                ? 'bg-surface-card text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 border-l border-surface-border pl-3">
        {mode === 'page' && isOciView && (
          <button
            type="button"
            onClick={() => startImageUpdateCheck(null)}
            disabled={imageUpdateCheck.running}
            className="inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-50"
            title="Check all OCI images for updates"
            aria-label="Check all OCI images for updates"
          >
            {imageUpdateCheck.running && !imageUpdateCheck.ref
              ? <Loader2 size={14} className="animate-spin" aria-hidden />
              : <RefreshCw size={14} aria-hidden />}
          </button>
        )}
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInput} />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center justify-center rounded-md bg-accent p-1.5 text-white hover:bg-accent-hover transition-colors duration-150 disabled:opacity-50"
          title="Upload file"
          aria-label="Upload file"
        >
          {uploading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Upload size={14} aria-hidden />}
        </button>
        <button
          type="button"
          onClick={() => setUrlModalOpen(true)}
          className="inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
          title="Download from URL"
          aria-label="Download from URL"
        >
          <Link size={14} aria-hidden />
        </button>
        <PresetImageDownloadMenu onSelectPreset={handlePresetSelect} />
      </div>
    </div>
  );

  const pageGutters = mode === 'page' ? 'px-6 py-5' : 'px-4 py-4';

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className={`min-h-0 flex-1 overflow-y-auto ${pageGutters}`}>
        <SectionCard
          title="Image Library"
          titleIcon={<Images size={14} strokeWidth={2} />}
          headerAction={libraryHeaderAction}
          error={error || undefined}
        >
          {(uploading || uploadError || presetError || presetDownloading) && (
            <div className="mb-4 border-b border-surface-border pb-4">
              {uploading && (
                <div className="max-w-md">
                  <div className="mb-1 text-xs font-medium text-text-secondary">
                    Uploading… {uploadProgress}%
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-border">
                    <div
                      className="h-full rounded-full bg-accent transition-all duration-200"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}
              {presetDownloading && (
                <div className={`max-w-md ${uploading ? 'mt-3' : ''}`}>
                  <div className="mb-1 text-xs font-medium text-text-secondary">
                    {presetRow?.title ?? 'Download'}…{' '}
                    {presetPhase === 'decompressing' ? 'Uncompressing…' : `${presetProgress}%`}
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-border">
                    <div
                      className="h-full rounded-full bg-accent transition-all duration-200"
                      style={{ width: presetPhase === 'decompressing' ? '100%' : `${presetProgress}%` }}
                    />
                  </div>
                </div>
              )}
              {uploadError && (
                <p className={`text-xs text-status-stopped ${uploading || presetDownloading ? 'mt-2' : ''}`}>{uploadError}</p>
              )}
              {presetError && (
                <p className={`text-xs text-status-stopped ${uploading || presetDownloading || uploadError ? 'mt-2' : ''}`}>{presetError}</p>
              )}
            </div>
          )}

          {mode === 'page' && isOciView && (
            <div className="mb-3 flex items-center justify-between text-xs text-text-muted">
              <span>
                {imageUpdateCheck.running ? (
                  <>
                    Checking
                    {imageUpdateCheck.currentRef ? ` ${shortDigest(imageUpdateCheck.currentRef)}` : '…'}
                    {imageUpdateCheck.progress
                      ? ` (${imageUpdateCheck.progress.index}/${imageUpdateCheck.progress.total})`
                      : ''}
                  </>
                ) : imageUpdateCheck.lastCheckedAt ? (
                  <>
                    Checked {formatRelativeTime(imageUpdateCheck.lastCheckedAt)}
                    {` · ${imageUpdateCheck.imagesUpdated} update${imageUpdateCheck.imagesUpdated === 1 ? '' : 's'} found`}
                    {imageUpdateCheck.flaggedContainers > 0
                      ? ` · ${imageUpdateCheck.flaggedContainers} container${imageUpdateCheck.flaggedContainers === 1 ? '' : 's'} flagged`
                      : ''}
                  </>
                ) : (
                  <>Never checked for updates</>
                )}
              </span>
              {imageUpdateCheck.lastError && (
                <span className="text-status-stopped">{imageUpdateCheck.lastError}</span>
              )}
            </div>
          )}
          {loading ? (
          <p className="py-8 text-center text-sm text-text-muted">Loading…</p>
        ) : isOciView ? (
          containerImages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Package size={32} className="mb-2 text-text-muted" />
              <p className="text-sm text-text-muted">No OCI images found</p>
              <p className="mt-1 max-w-sm text-xs text-text-muted">
                Images are stored in containerd when you create a container or pull an image. Remove a container first if an image is still in use.
              </p>
            </div>
          ) : (
            <DataTableScroll>
              <DataTable minWidthRem={tableMinWidthRem}>
                <thead>
                  <LibraryTableHead mode={mode} compactPicker={compactPicker} />
                </thead>
                <tbody>
                  {containerImages.map((row) => (
                    <ContainerImageRow
                      key={row.name}
                      row={row}
                      mode={mode}
                      compactPicker={compactPicker}
                      onSelect={onSelect}
                      onDelete={(r) => setDeleteTarget({ kind: 'oci', ref: r.name })}
                      onCheckUpdate={(r) => startImageUpdateCheck(r.name)}
                      checkState={imageUpdateCheck}
                    />
                  ))}
                </tbody>
              </DataTable>
            </DataTableScroll>
          )
        ) : mode === 'page' && filter === 'all' && mergedAllRows ? (
          mergedAllRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <HardDrive size={32} className="mb-2 text-text-muted" />
              <p className="text-sm text-text-muted">No images found</p>
              <p className="mt-1 max-w-sm text-xs text-text-muted">
                Use the upload control in the section header to add VM disk or ISO files, or pull OCI images when creating a container.
              </p>
            </div>
          ) : (
            <DataTableScroll>
              <DataTable minWidthRem={tableMinWidthRem}>
                <thead>
                  <LibraryTableHead mode={mode} compactPicker={compactPicker} />
                </thead>
                <tbody>
                  {mergedAllRows.map((row) =>
                    row.kind === 'file' ? (
                      <FileRow
                        key={`file:${row.file.name}`}
                        file={row.file}
                        mode={mode}
                        compactPicker={compactPicker}
                        onSelect={onSelect}
                        onDelete={(f) => setDeleteTarget({ kind: 'file', name: f.name })}
                        onRename={handleRename}
                      />
                    ) : (
                      <ContainerImageRow
                        key={`oci:${row.oci.name}`}
                        row={row.oci}
                        mode={mode}
                        compactPicker={compactPicker}
                        onSelect={onSelect}
                        onDelete={(r) => setDeleteTarget({ kind: 'oci', ref: r.name })}
                        onCheckUpdate={(r) => startImageUpdateCheck(r.name)}
                        checkState={imageUpdateCheck}
                      />
                    ),
                  )}
                </tbody>
              </DataTable>
            </DataTableScroll>
          )
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <HardDrive size={32} className="mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">No images found</p>
            <p className="mt-1 text-xs text-text-muted">Use the upload control in the section header to add an ISO or disk image</p>
          </div>
        ) : (
          <DataTableScroll>
            <DataTable minWidthRem={tableMinWidthRem}>
              <thead>
                <LibraryTableHead mode={mode} compactPicker={compactPicker} />
              </thead>
              <tbody>
                {files.map((file) => (
                  <FileRow
                    key={file.name}
                    file={file}
                    mode={mode}
                    compactPicker={compactPicker}
                    onSelect={onSelect}
                    onDelete={(f) => setDeleteTarget({ kind: 'file', name: f.name })}
                    onRename={handleRename}
                  />
                ))}
              </tbody>
            </DataTable>
          </DataTableScroll>
        )}
        </SectionCard>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title={deleteTarget?.kind === 'oci' ? 'Delete container image' : 'Delete file'}
        message={
          deleteTarget?.kind === 'oci'
            ? `Remove "${deleteTarget.ref}" from containerd? This cannot be undone.`
            : `Are you sure you want to delete "${deleteTarget?.name}"? This cannot be undone.`
        }
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* URL download modal */}
      {urlModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={closeUrlModal}>
          <div
            className="w-full max-w-md rounded-card border border-surface-border bg-surface-card p-5 shadow-lg"
            data-wisp-modal-root
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-text-primary mb-3">Download from URL</h3>
            <p className="text-xs text-text-muted mb-2">Enter an HTTP or HTTPS URL to an ISO or disk image (qcow2, img).</p>
            <div className="flex gap-2 mb-3">
              <input
                type="url"
                value={urlInput}
                onChange={(e) => { setUrlInput(e.target.value); setUrlCheckResult(null); setUrlDownloadError(null); }}
                placeholder="https://..."
                className="input-field flex-1"
              />
              <button
                type="button"
                onClick={handleUrlCheck}
                disabled={urlChecking || !urlInput.trim()}
                className="rounded border border-surface-border bg-surface px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-sidebar disabled:opacity-50"
              >
                {urlChecking ? '…' : 'Check'}
              </button>
            </div>
            {urlCheckResult && (
              <div className={`mb-3 rounded px-3 py-2 text-xs ${urlCheckResult.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-status-stopped'}`}>
                {urlCheckResult.ok
                  ? `OK${urlCheckResult.contentLength != null ? ` — ${(urlCheckResult.contentLength / 1024 / 1024).toFixed(1)} MB` : ''}`
                  : urlCheckResult.error}
              </div>
            )}
            {urlDownloadError && (
              <p className="mb-3 text-xs text-status-stopped">{urlDownloadError}</p>
            )}
            {urlDownloading && (
              <div className="mb-3">
                <div className="mb-1 text-xs text-text-secondary">Downloading… {urlDownloadProgress}%</div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface-border">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-200"
                    style={{ width: `${urlDownloadProgress}%` }}
                  />
                </div>
                <p className="mt-2 text-[11px] text-text-muted">
                  You can close this dialog — progress continues in the background jobs list (top bar).
                </p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeUrlModal}
                className="rounded border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface"
              >
                {urlDownloading ? 'Close' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleUrlDownload}
                disabled={urlDownloading || !urlInput.trim()}
                className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {urlDownloading && <Loader2 size={14} className="animate-spin" />}
                Download
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
