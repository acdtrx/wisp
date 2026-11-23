import { useMemo, useState } from 'react';
import { Library, Pencil, Plus, Trash2 } from 'lucide-react';

import FormModal from '../../components/shared/FormModal.jsx';
import { FormField } from '../../components/shared/FormModalChrome.jsx';
import GroupAction from '../../components/shared/GroupAction.jsx';
import Card from '../../components/shared/Card.jsx';
import GroupItem from '../../components/shared/GroupItem.jsx';
import GroupSwitch from '../../components/shared/GroupSwitch.jsx';
import RecordError from '../../components/shared/RecordError.jsx';
import ValueRows from '../../components/shared/ValueRows.jsx';
import { APP_CONFIG_COMMAND, appCommandRunning, appRowReason } from '../appConfigRows.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { useRecord } from '../../hooks/useRecord.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import {
  libraryForm, libraryProblems, withGpu, withLibrary, withoutLibrary, withPublishedUrl,
} from './jellyfinConfig.js';
import { NOTHING_CHANGED } from '../../hooks/editorValues.js';

const appConfigOf = (config) => config.metadata?.appConfig ?? {};
const removeAbout = (label) => `Couldn't remove the library ${label}`;
const gpuAbout = (on) => `Couldn't turn the GPU ${on ? 'on' : 'off'}`;
const NO_MOUNTS = [];

const storageLabel = (mounts, id) => {
  const m = mounts.find((s) => s.id === id);
  return m ? ((m.label && m.label.trim()) || m.mountPath) : id;
};

/**
 * Jellyfin's own groups: its media libraries, each a storage mount at
 * `/media/<label>` (saved or removed on its own), and the address it publishes, with
 * the switch that shares the host's GPU.
 */
export default function JellyfinGroups({ config, busy, act, update }) {
  const ac = appConfigOf(config);
  /* One whole-config command at a time: the rows and switches wait for it. */
  const appReason = appRowReason(busy, act);
  const [editor, setEditor] = useState(null);
  const settings = useRecord(RECORD.SETTINGS);
  const storage = settings.data?.mounts ?? NO_MOUNTS;
  const gpus = useRecord(RECORD.HOST_GPUS);
  const hostGpus = Array.isArray(gpus.data?.gpus) ? gpus.data.gpus : null;
  const save = (appConfig) => update({ appConfig });
  const libraries = (ac.libraries ?? []).filter(Boolean);

  const remove = (label) => act.run(() => save(withoutLibrary(appConfigOf(config), label)), {
    key: APP_CONFIG_COMMAND, about: removeAbout(label),
  });
  const toggleGpu = (on) => act.run(() => save(withGpu(appConfigOf(config), on)), {
    key: APP_CONFIG_COMMAND, about: gpuAbout(on),
  });

  const gpuReason = appReason ?? (hostGpus == null
    ? (gpus.status === 'error' ? 'the host GPUs could not be listed' : 'checking the host for a GPU')
    : (hostGpus.length === 0 && !ac.gpuEnabled ? 'the host has no Intel or AMD GPU to share' : undefined));

  return (
    <>
      <Card
        title="Libraries"
        actions={<GroupAction icon={Plus} kindIcon={Library} variant="add" label="Add a library" reason={appReason} onClick={() => setEditor({ library: null })} />}
      >
        <RecordError record={settings} what="storage mounts" className="mb-2" />
        {libraries.length === 0 && <p className="py-1 text-sm text-text-muted">No libraries.</p>}
        {libraries.map((lib) => {
          const removing = appCommandRunning(act, removeAbout(lib.label));
          return (
            <GroupItem
              key={lib.label}
              title={`/media/${lib.label}`}
              mono
              detail={`From ${storageLabel(storage, lib.sourceId)}${lib.subPath ? `/${lib.subPath}` : ''}`}
              actions={(
                <>
                  <GroupAction icon={Pencil} label={`Edit ${lib.label}`} reason={appReason} disabled={removing} onClick={() => setEditor({ library: lib.label })} />
                  <GroupAction icon={Trash2} variant="danger" label={`Remove ${lib.label}`} reason={appReason} busy={removing} onClick={() => remove(lib.label)} />
                </>
              )}
            />
          );
        })}
      </Card>

      <Card
        title="Published address"
        actions={<GroupAction icon={Pencil} label="Edit the published address" reason={appReason} onClick={() => setEditor({ address: true })} />}
      >
        <ValueRows rows={[{ label: 'Address', value: ac.publishedUrl || 'Its local name', mono: !!ac.publishedUrl }]} />
        <div className="mt-1 border-t border-surface-border">
          <GroupSwitch
            label="Use the GPU"
            hint="Hardware video encoding and decoding; turn it on in Jellyfin’s Playback settings too."
            checked={ac.gpuEnabled === true}
            onChange={toggleGpu}
            busy={appCommandRunning(act, gpuAbout(true)) || appCommandRunning(act, gpuAbout(false))}
            reason={gpuReason}
          />
        </div>
      </Card>

      {editor && 'library' in editor && (
        <LibraryEditor config={config} libraryKey={editor.library} storage={storage} save={save} onClose={() => setEditor(null)} />
      )}
      {editor?.address && <AddressEditor config={config} save={save} onClose={() => setEditor(null)} />}
    </>
  );
}

function LibraryEditor({ config, libraryKey, storage, save, onClose }) {
  const [opened] = useState(() => (appConfigOf(config).libraries ?? []).find((l) => l?.label === libraryKey) ?? null);
  const { form, setField, dirty } = useEditor(() => libraryForm(opened));
  const command = useCommand();
  const problems = libraryProblems(appConfigOf(config), libraryKey, form);
  const blocked = Object.values(problems)[0] ?? (libraryKey == null || dirty ? null : NOTHING_CHANGED);
  const choices = useMemo(() => (form.sourceId && !storage.some((m) => m.id === form.sourceId)
    ? [...storage, { id: form.sourceId, mountPath: form.sourceId }] : storage), [storage, form.sourceId]);
  return (
    <FormModal
      title={libraryKey == null ? 'Add a library' : 'Library'}
      subtitle={form.label.trim() ? `/media/${form.label.trim()}` : 'Mounted at /media/<label>'}
      saveLabel={libraryKey == null ? 'Add' : 'Save'}
      save={command}
      blocked={blocked}
      onClose={onClose}
      onSubmit={() => command.run(() => save(withLibrary(appConfigOf(config), libraryKey, form))).then((ok) => { if (ok) onClose(); })}
    >
      <FormField label="Label" htmlFor="jf-label" hint={(form.label.trim() && problems.label) || 'A folder name: movies is /media/movies.'}>
        <input id="jf-label" ref={autoFocusField} type="text" value={form.label} onChange={(e) => setField('label', e.target.value)} placeholder="movies" autoComplete="off" spellCheck={false} className="input-field" />
      </FormField>
      <FormField label="Storage" htmlFor="jf-source" hint={storage.length === 0 ? 'Add a storage mount on the host first (Host Mgmt, Storage).' : null}>
        <select id="jf-source" value={form.sourceId} onChange={(e) => setField('sourceId', e.target.value)} className="input-field">
          <option value="">Pick a storage mount</option>
          {choices.map((m) => <option key={m.id} value={m.id}>{storageLabel(choices, m.id)}</option>)}
        </select>
      </FormField>
      <FormField label="Sub-path" htmlFor="jf-subpath" hint={problems.subPath ?? 'Optional: a folder inside the storage, like media/movies.'}>
        <input id="jf-subpath" type="text" value={form.subPath} onChange={(e) => setField('subPath', e.target.value)} placeholder="Optional" autoComplete="off" spellCheck={false} className="input-field font-mono" />
      </FormField>
    </FormModal>
  );
}

function AddressEditor({ config, save, onClose }) {
  const { form, setField, dirty } = useEditor(() => ({ publishedUrl: appConfigOf(config).publishedUrl ?? '' }));
  const command = useCommand();
  return (
    <FormModal
      title="Published address"
      subtitle={config.name}
      save={command}
      blocked={dirty ? null : NOTHING_CHANGED}
      onClose={onClose}
      onSubmit={() => command.run(() => save(withPublishedUrl(appConfigOf(config), form.publishedUrl))).then((ok) => { if (ok) onClose(); })}
    >
      <FormField label="Address" htmlFor="jf-url" hint="What Jellyfin tells its apps and browsers. Empty: its local name.">
        <input id="jf-url" ref={autoFocusField} type="text" value={form.publishedUrl} onChange={(e) => setField('publishedUrl', e.target.value)} placeholder="http://jellyfin.local:8096" autoComplete="off" spellCheck={false} className="input-field font-mono" />
      </FormField>
    </FormModal>
  );
}
