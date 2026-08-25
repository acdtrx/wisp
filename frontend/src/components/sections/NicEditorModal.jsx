import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Shuffle } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import {
  FormField,
  FormModalError,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import NicModelSegmentedControl from './NicModelSegmentedControl.jsx';
import { randomMac } from '../../utils/randomMac.js';

const FORM_ID = 'nic-editor-form';

const sideBtn =
  'flex h-[34px] shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary hover:bg-surface-sidebar transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

/* A new NIC starts on the first host bridge with a fresh locally-administered
 * MAC — the same defaults the create-flow draft rows use. */
function formFromNic(nic, bridges) {
  if (!nic) return { source: bridges[0] || '', model: 'virtio', mac: randomMac() };
  return { source: nic.source || '', model: nic.model || 'virtio', mac: nic.mac || '' };
}

/**
 * Modal form editor for one VM network interface — create when `nic` is null,
 * edit otherwise (see docs/UI-PATTERNS.md § Modal form editor). `index` is the
 * NIC's position (`net0`, `net1`, …). The section owns the `nics` array and its
 * full-array PATCH, so this hands the edited fields to `onSubmit` and stays
 * open on failure.
 */
export default function NicEditorModal({ open, nic, index, bridges = [], onSubmit, onClose }) {
  const [form, setForm] = useState(() => formFromNic(null, []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isEdit = nic != null;

  useEffect(() => {
    if (!open) return;
    /* `bridges` is read once, when the modal opens: a late host-bridge refresh
     * must not reset a form in progress. */
    setForm(formFromNic(nic, bridges));
    setError(null);
  }, [open, nic]);

  const dirty = !isEdit
    || form.source !== (nic.source || '')
    || form.model !== (nic.model || 'virtio')
    || form.mac !== (nic.mac || '');
  const canSave = dirty && !saving;

  /* cloud-init writes the network config against the first NIC's MAC. */
  const macBreaksCloudInit = isEdit && index === 0 && form.mac !== (nic.mac || '');

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ source: form.source, model: form.model, mac: form.mac });
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit network interface' : 'Add network interface'}
      subtitle={`net${index} · bridged`}
      size="md"
      height="cap"
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={formModalNeutralBtn}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} disabled={!canSave} className={formModalPrimaryBtn}>
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
            Save
          </button>
        </>
      )}
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => { e.preventDefault(); handleSave(); }}
        className="space-y-3"
      >
        <FormField label="Bridge" htmlFor="nic-editor-bridge">
          <select
            id="nic-editor-bridge"
            value={form.source}
            onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
            autoFocus={!isEdit}
            className="input-field"
          >
            {!form.source && <option value="">Select…</option>}
            {bridges.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
            {form.source && !bridges.includes(form.source) && (
              <option value={form.source}>{form.source}</option>
            )}
          </select>
        </FormField>
        <FormField label="Model">
          <NicModelSegmentedControl
            value={form.model}
            onChange={(v) => setForm((f) => ({ ...f, model: v }))}
          />
        </FormField>
        <FormField
          label="MAC address"
          htmlFor="nic-editor-mac"
          hint={macBreaksCloudInit ? (
            <span className="inline-flex items-center gap-1 text-status-warning">
              <AlertTriangle size={12} aria-hidden />
              If this VM uses cloud-init, re-save cloud-init after changing the MAC.
            </span>
          ) : null}
        >
          <div className="flex items-center gap-2">
            <input
              id="nic-editor-mac"
              type="text"
              value={form.mac}
              onChange={(e) => setForm((f) => ({ ...f, mac: e.target.value }))}
              autoComplete="off"
              spellCheck={false}
              className="input-field min-w-0 flex-1 font-mono"
            />
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, mac: randomMac() }))}
              className={sideBtn}
              title="Randomize MAC"
              aria-label="Randomize MAC"
            >
              <Shuffle size={14} aria-hidden />
            </button>
          </div>
        </FormField>
        <FormModalError error={error} />
      </form>
    </Modal>
  );
}
