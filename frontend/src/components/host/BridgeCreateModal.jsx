import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import {
  FormField,
  FormModalError,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import { createManagedNetworkBridge } from '../../api/host.js';

const FORM_ID = 'bridge-create-form';

/**
 * Modal form editor for creating one managed VLAN bridge (see
 * docs/UI-PATTERNS.md § Modal form editor). The bridge name is derived
 * (`<parent>-vlan<id>`) and shown as a preview. Calls `onCreated` after a
 * successful create so the parent can refresh its list.
 */
export default function BridgeCreateModal({ open, eligibleParents, onClose, onCreated }) {
  const [baseBridge, setBaseBridge] = useState('');
  const [vlanId, setVlanId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const parents = Array.isArray(eligibleParents) ? eligibleParents : [];

  useEffect(() => {
    if (!open) return;
    setBaseBridge(parents[0] || '');
    setVlanId('');
    setError(null);
    // parents comes fresh from the section on every open; keying the reset on
    // `open` alone avoids resetting the form while the user types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const bridgePreview = useMemo(() => {
    const n = Number(vlanId);
    if (!baseBridge || !Number.isInteger(n) || n < 1 || n > 4094) return null;
    return `${baseBridge}-vlan${n}`;
  }, [baseBridge, vlanId]);

  const canCreate = !!bridgePreview && !submitting;

  const handleCreate = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    setError(null);
    try {
      await createManagedNetworkBridge(baseBridge, Number(vlanId));
      await onCreated?.();
      onClose();
    } catch (err) {
      setError(err.detail || err.message || 'Failed to create bridge');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add VLAN bridge"
      subtitle="The host handles VLAN tagging — guests connect untagged."
      size="sm"
      height="cap"
      closeOnBackdrop={!submitting}
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
              autoFocus
              className="input-field"
            />
          </FormField>
          <p className="text-xs text-text-muted">
            Bridge name:{' '}
            <span className="font-mono text-text-secondary">{bridgePreview || '—'}</span>
          </p>
          <FormModalError error={error} />
        </form>
      )}
    </Modal>
  );
}
