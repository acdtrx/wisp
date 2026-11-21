import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import {
  FormField,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import { createManagedNetworkBridge } from '../../api/host.js';
import { RECORD } from '../../store/records.js';
import { useCommand } from '../../hooks/useCommand.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { autoFocusField } from '../../lib/focus.js';

const FORM_ID = 'bridge-create-form';

/**
 * Modal form editor for creating one managed VLAN bridge (see
 * docs/FRONTEND-RULES.md § Modal form editor). The bridge name is derived
 * (`<parent>-vlan<id>`) and shown as a preview. The new bridge reaches the list
 * on the `network-bridges` cue its job announces.
 */
export default function BridgeCreateModal({ open, eligibleParents, onClose }) {
  const [baseBridge, setBaseBridge] = useState('');
  const [vlanId, setVlanId] = useState('');
  const create = useCommand();
  const submitting = create.busy;

  const parents = Array.isArray(eligibleParents) ? eligibleParents : [];

  useEffect(() => {
    if (!open) return;
    setBaseBridge(parents[0] || '');
    setVlanId('');
    create.dismiss();
    // parents comes fresh from the section on every open; keying the reset on
    // `open` alone avoids resetting the form while the user types.
  }, [open]);

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
      job: true, rereads: [[RECORD.NETWORK_BRIDGES], [RECORD.HOST_BRIDGES]], onDone: onClose,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add VLAN bridge"
      subtitle="The host handles VLAN tagging — guests connect untagged."
      size="sm"
      height="cap"
      closeOnEscape={!submitting}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={submitting} className={formModalNeutralBtn}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} disabled={!canCreate} className={formModalPrimaryBtn}>
            {submitting && <Loader2 size={14} className="animate-spin" aria-hidden />}
            Create
          </button>
        </>
      )}
    >
      {parents.length === 0 ? (
        <p className="text-xs text-text-muted">
          No eligible parent bridges. Create a plain bridge on the host first.
        </p>
      ) : (
        <form
          id={FORM_ID}
          onSubmit={(e) => { e.preventDefault(); handleCreate(); }}
          className="space-y-3"
        >
          <FormField label="Parent bridge" htmlFor="bridge-create-parent">
            <select
              id="bridge-create-parent"
              value={baseBridge}
              onChange={(e) => setBaseBridge(e.target.value)}
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
              onChange={(e) => setVlanId(e.target.value)}
              placeholder="10"
              ref={autoFocusField}
              className="input-field"
            />
          </FormField>
          <p className="text-xs text-text-muted">
            Bridge name:{' '}
            <span className="font-mono text-text-secondary">{bridgePreview || '—'}</span>
          </p>
          <ErrorBanner className="mt-3" error={create.error} onDismiss={create.dismiss} />
        </form>
      )}
    </Modal>
  );
}
