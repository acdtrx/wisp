import { useMemo, useState } from 'react';

import FormModal from '../shared/FormModal.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import { createManagedNetworkBridge } from '../../api/host.js';
import { useCommand } from '../../hooks/useCommand.js';
import { autoFocusField } from '../../lib/focus.js';

/**
 * Modal form editor for creating one managed VLAN bridge (see
 * docs/FRONTEND-RULES.md § Modal form editor). The bridge name is derived
 * (`<parent>-vlan<id>`) and shown as a preview. The new bridge reaches the list
 * on the `network-bridges` cue its job announces.
 */
export default function BridgeCreateModal(props) {
  return props.open ? <BridgeCreateEditor {...props} /> : null;
}

function BridgeCreateEditor({ eligibleParents, onClose }) {
  /* The create's input: the dialog's own values (it edits no saved record). */
  const [input, setInput] = useState({ baseBridge: '', vlanId: '' });
  const setField = (key, value) => setInput((v) => ({ ...v, [key]: value }));
  const create = useCommand();
  const submitting = create.busy;

  const parents = Array.isArray(eligibleParents) ? eligibleParents : [];
  /* No parent chosen yet: the first eligible one, also once the list arrives after
   * the dialog opened. */
  const baseBridge = input.baseBridge || parents[0] || '';
  const { vlanId } = input;

  const bridgePreview = useMemo(() => {
    const n = Number(vlanId);
    if (!baseBridge || !Number.isInteger(n) || n < 1 || n > 4094) return null;
    return `${baseBridge}-vlan${n}`;
  }, [baseBridge, vlanId]);

  const canCreate = !!bridgePreview && !submitting;

  /* A job: busy until it ended and the bridge lists, read again after it, have
   * landed, so the new bridge is on screen when the modal closes. */
  const handleCreate = () => {
    if (!canCreate) return;
    create.run(() => createManagedNetworkBridge(baseBridge, Number(vlanId)), {
      job: true, onDone: onClose,
    });
  };

  return (
    <FormModal
      title="Add VLAN bridge"
      subtitle="The host handles VLAN tagging — guests connect untagged."
      saveLabel="Create"
      save={create}
      blocked={parents.length === 0 ? 'No eligible parent bridge.' : bridgePreview ? null : 'Set a VLAN ID from 1 to 4094.'}
      onSubmit={handleCreate}
      onClose={onClose}
    >
      {parents.length === 0 ? (
        <p className="text-xs text-text-muted">
          No eligible parent bridges. Create a plain bridge on the host first.
        </p>
      ) : (
        <>
      <FormField label="Parent bridge" htmlFor="bridge-create-parent">
        <select
          id="bridge-create-parent"
          value={baseBridge}
          onChange={(e) => setField('baseBridge', e.target.value)}
          className="input-field"
        >
          {parents.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </FormField>
      <FormField
        label="VLAN Id"
        htmlFor="bridge-create-vlan"
        hint="1–4094"
      >
        <input
          id="bridge-create-vlan"
          type="number"
          min="1"
          max="4094"
          value={vlanId}
          onChange={(e) => setField('vlanId', e.target.value)}
          placeholder="10"
          ref={autoFocusField}
          className="input-field"
        />
      </FormField>
      <p className="text-xs text-text-muted">
        Bridge name:{' '}
        <span className="font-mono text-text-secondary">{bridgePreview || '—'}</span>
      </p>
        </>
      )}
    </FormModal>
  );
}
