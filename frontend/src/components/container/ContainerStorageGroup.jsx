import { useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Archive, File, FileText, Folder, KeyRound, MemoryStick, Pencil, Plus, Trash2, Upload,
} from 'lucide-react';

import { removeContainerMount, uploadMountFile, uploadMountZip } from '../../api/containers.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import { formatBytes, formatMemory } from '../../utils/formatters.js';
import ContainerMountEditorModal from './ContainerMountEditorModal.jsx';
import MountFileEditorModal from './MountFileEditorModal.jsx';
import SecretMountContentModal from './SecretMountContentModal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import Card from '../shared/Card.jsx';
import GroupItem from '../shared/GroupItem.jsx';
import RecordError from '../shared/RecordError.jsx';

const KIND = { file: 'File', directory: 'Folder', tmpfs: 'Memory folder' };

/** Whether removing the mount deletes data kept on this host (its `files/<name>`). */
const removalDeletesData = (mount) => mount.type !== 'tmpfs' && !mount.sourceId;

/**
 * What a plain container keeps outside itself: each mount, with its path, kind and
 * size. Add a folder, a file or a memory folder; Edit; Remove (asking first when the
 * mount's data on this host goes with it); open a file's content; upload. A row's
 * removal and uploads are the page's commands (`act`), keyed by the mount.
 */
export default function ContainerStorageGroup({ config, busy, act }) {
  const mounts = useMemo(() => config.mounts ?? [], [config.mounts]);
  const settings = useRecord(RECORD.SETTINGS).data;
  const status = useRecord(RECORD.HOST_MOUNT_STATUS);
  /* Sizes: read again on the container's change cue, never polled (a walk can take seconds). */
  const usage = useRecord(RECORD.CONTAINER_MOUNT_USAGE, mounts.length > 0 ? config.name : null);

  /* The open editor: `{ kind, name }` (name null: a new mount of `kind`). */
  const [editor, setEditor] = useState(null);
  const [fileEditor, setFileEditor] = useState(null);
  const [secretEditor, setSecretEditor] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);

  const storageMounts = useMemo(() => settings?.mounts ?? [], [settings]);
  const usageByName = useMemo(() => new Map((usage.data?.mounts ?? []).map((u) => [u.name, u])), [usage.data]);
  const mountedById = useMemo(() => new Map((status.data ?? []).map((s) => [s.id, !!s.mounted])), [status.data]);

  const sizeOf = (m) => {
    if (m.type === 'tmpfs') return formatMemory(m.sizeMiB ?? 64);
    if (m.secret) return m.sizeBytes != null ? formatBytes(m.sizeBytes) : null;
    if (usage.data == null) return usage.status === 'loading' ? '…' : null;
    const u = usageByName.get(m.name);
    if (!u || u.sizeBytes == null) return null;
    return `${formatBytes(u.sizeBytes)}${u.partial ? '+' : ''}`;
  };

  const whereOf = (m) => {
    if (m.type === 'tmpfs') return { text: 'in memory, gone at stop' };
    if (!m.sourceId) return { text: 'on this host' };
    const sm = storageMounts.find((s) => s.id === m.sourceId);
    const label = sm ? ((sm.label && sm.label.trim()) || sm.mountPath) : m.sourceId;
    const where = m.subPath ? `${label}/${m.subPath}` : label;
    if (!sm) return { text: `${where} (no longer configured)`, warn: true };
    if (mountedById.get(sm.id) === false) return { text: `${where} (not mounted)`, warn: true };
    return { text: where };
  };

  const remove = (m) => act.run(() => removeContainerMount(config.name, m.name), {
    job: true, key: `mount:${m.name}`, about: `Couldn't remove ${m.containerPath}`,
  });

  const askRemove = (m) => {
    if (removalDeletesData(m)) setConfirmRemove(m);
    else remove(m);
  };

  const upload = (m, file) => act.run(
    () => (m.type === 'file' ? uploadMountFile(config.name, m.name, file) : uploadMountZip(config.name, m.name, file)),
    { job: m.type !== 'file', key: `mount:${m.name}`, about: `Couldn't upload to ${m.containerPath}` },
  );

  const addAction = (kind, kindIcon, label) => (
    <GroupAction icon={Plus} kindIcon={kindIcon} variant="add" label={label} reason={busy} onClick={() => setEditor({ kind, name: null })} />
  );

  return (
    <Card
      title="Storage"
      actions={(
        <div className="flex items-center gap-1">
          {addAction('directory', Folder, 'Add a folder')}
          {addAction('file', File, 'Add a file')}
          {addAction('tmpfs', MemoryStick, 'Add a memory folder')}
        </div>
      )}
    >
      <RecordError record={usage} what="mount sizes" className="mb-2" />
      <RecordError record={status} what="storage mount status" className="mb-2" />
      {mounts.length === 0 && <p className="py-1 text-sm text-text-muted">Nothing is kept outside the container.</p>}
      {mounts.map((m) => {
        const rowBusy = act.isBusy(`mount:${m.name}`);
        const where = whereOf(m);
        const size = sizeOf(m);
        const bits = [
          KIND[m.type] ?? m.type,
          m.type !== 'tmpfs' ? m.name : null,
          where.warn ? null : where.text,
          m.type !== 'tmpfs' ? size : null,
          m.readonly ? 'read-only' : null,
          m.secret ? (m.isSet ? 'secret' : 'secret, not set') : null,
          config.runAsRoot && m.type !== 'tmpfs' && !m.sourceId ? `owner ${m.containerOwnerUid ?? 0}:${m.containerOwnerGid ?? 0}` : null,
        ].filter(Boolean);
        const reason = busy ?? (rowBusy ? 'Working on it…' : undefined);
        return (
          <GroupItem
            key={m.name}
            title={m.containerPath}
            mono
            detail={(
              <>
                {bits.join(' · ')}
                {where.warn && (
                  <span className="ml-1 inline-flex items-center gap-1 text-status-stopped">
                    <AlertCircle size={12} aria-hidden /> {where.text}
                  </span>
                )}
              </>
            )}
            actions={(
              <>
                {m.type === 'file' && (m.secret
                  ? <GroupAction icon={KeyRound} label="Replace the secret content" reason={reason} onClick={() => setSecretEditor(m)} />
                  : <GroupAction icon={FileText} label="Open the file" reason={reason} onClick={() => setFileEditor(m.name)} />)}
                {m.type === 'file' && (
                  <UploadAction icon={Upload} label="Upload a file" reason={reason} busy={rowBusy} onFile={(f) => upload(m, f)} />
                )}
                {m.type === 'directory' && (
                  <UploadAction
                    icon={Archive}
                    label="Upload a zip into the folder"
                    accept=".zip,application/zip"
                    reason={reason ?? (m.sourceId ? 'only for a folder kept on this host' : undefined)}
                    busy={rowBusy}
                    onFile={(f) => upload(m, f)}
                  />
                )}
                <GroupAction icon={Pencil} label={`Edit ${m.containerPath}`} reason={reason} onClick={() => setEditor({ kind: m.type, name: m.name })} />
                <GroupAction icon={Trash2} variant="danger" label={`Remove ${m.containerPath}`} reason={busy} busy={rowBusy} onClick={() => askRemove(m)} />
              </>
            )}
          />
        );
      })}

      <ContainerMountEditorModal
        open={editor != null}
        containerName={config.name}
        mount={editor?.name == null ? null : mounts.find((m) => m.name === editor.name) ?? null}
        mounts={mounts}
        kind={editor?.kind ?? 'file'}
        storageMounts={storageMounts}
        runAsRoot={!!config.runAsRoot}
        onClose={() => setEditor(null)}
      />
      <SecretMountContentModal
        open={secretEditor != null}
        containerName={config.name}
        mount={secretEditor}
        onClose={() => setSecretEditor(null)}
      />
      <MountFileEditorModal
        open={fileEditor != null}
        containerName={config.name}
        mountName={fileEditor ?? ''}
        onClose={() => setFileEditor(null)}
      />
      <ConfirmDialog
        open={confirmRemove != null}
        title={`Remove ${confirmRemove?.containerPath ?? ''}?`}
        confirmLabel="Remove and delete"
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => { const m = confirmRemove; setConfirmRemove(null); remove(m); }}
      >
        {confirmRemove && (
          <>
            <p>
              Its {confirmRemove.type === 'file' ? 'file' : 'files'} on this host {confirmRemove.type === 'file' ? 'is' : 'are'} deleted:{' '}
              <span className="font-mono text-text-primary">files/{confirmRemove.name}</span>
              {sizeOf(confirmRemove) && sizeOf(confirmRemove) !== '…' ? ` (${sizeOf(confirmRemove)})` : ''}.
            </p>
            <p className="mt-2 text-xs text-text-muted">This cannot be undone.</p>
          </>
        )}
      </ConfirmDialog>
    </Card>
  );
}

/** An upload: the action opens the file picker, the picked file is sent at once. */
function UploadAction({ icon, label, accept, reason, busy, onFile }) {
  const inputRef = useRef(null);
  return (
    <>
      <GroupAction icon={icon} label={label} reason={reason} busy={busy} onClick={() => inputRef.current?.click()} />
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
    </>
  );
}
