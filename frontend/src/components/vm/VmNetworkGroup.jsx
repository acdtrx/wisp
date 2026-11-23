import { useState } from 'react';
import { Network, Pencil, Plus, Trash2 } from 'lucide-react';

import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import NicEditorModal from './NicEditorModal.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import GroupCard from '../shared/GroupCard.jsx';
import GroupItem from '../shared/GroupItem.jsx';
import RecordError from '../shared/RecordError.jsx';
import { nicsForApi } from './vmForms.js';

/** Every change re-sends the whole `nics` list, so one runs at a time: one key. */
const NICS = 'nics';
const NO_BRIDGES = [];
const MODEL_LABEL = { virtio: 'VirtIO' };


/**
 * The VM's network adapters: bridge, model and MAC (its address is in the figures).
 * Add, Edit and Remove while it is shut off, each sending the whole list.
 */
export default function VmNetworkGroup({ config, busy, lockReason, act, update }) {
  /* The editor: the adapter's position, and the adapter as it opened (null: a new one). */
  const [editor, setEditor] = useState(null);
  const bridges = useRecord(RECORD.HOST_BRIDGES);
  const nics = config.nics ?? [];
  const running = act.isBusy(NICS);
  const reason = busy ?? (running ? 'another change to the adapters is being saved' : undefined) ?? lockReason;
  const removeAbout = (i) => `Couldn't remove adapter ${i + 1}`;

  /* The editor's save: the list as the config holds it when Save is pressed, that one
   * adapter changed (or added). */
  const submit = (fields, index) => {
    const list = nicsForApi(config.nics);
    const next = index == null ? [...list, { type: 'bridge', ...fields }] : list.map((n, i) => (i === index ? { ...n, ...fields } : n));
    return update({ nics: next });
  };

  const remove = (index) => act.run(
    () => update({ nics: nicsForApi(config.nics).filter((_, i) => i !== index) }),
    { key: NICS, about: removeAbout(index) },
  );

  return (
    <GroupCard
      title="Network"
      lockReason={lockReason ? 'Stop the VM to change its adapters' : undefined}
      actions={<GroupAction icon={Plus} kindIcon={Network} variant="add" label="Add an adapter" reason={reason} onClick={() => setEditor({ index: null, opened: null })} />}
    >
      <RecordError record={bridges} what="host bridges" className="mb-2" />
      {nics.length === 0 && <p className="py-1 text-sm text-text-muted">No adapters.</p>}
      {nics.map((nic, i) => (
        <GroupItem
          key={nic.mac || i}
          title={`Adapter ${i + 1}`}
          detail={[nic.source || 'no bridge', MODEL_LABEL[nic.model] ?? nic.model, nic.mac].filter(Boolean).join(' · ')}
          actions={(
            <>
              <GroupAction icon={Pencil} label={`Edit adapter ${i + 1}`} reason={reason} onClick={() => setEditor({ index: i, opened: nic })} />
              <GroupAction
                icon={Trash2}
                variant="danger"
                label={`Remove adapter ${i + 1}`}
                reason={reason ?? (nics.length <= 1 ? 'a VM keeps at least one adapter' : undefined)}
                busy={running && act.aboutOf(NICS) === removeAbout(i)}
                onClick={() => remove(i)}
              />
            </>
          )}
        />
      ))}
      <NicEditorModal
        open={editor != null}
        index={editor?.index ?? null}
        opened={editor?.opened ?? null}
        bridges={bridges.data ?? NO_BRIDGES}
        onSubmit={submit}
        onClose={() => setEditor(null)}
      />
    </GroupCard>
  );
}
