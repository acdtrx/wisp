import { useState } from 'react';
import { AlertTriangle, Loader2, Shuffle } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import {
  EditorGone,
  FormField,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import NicModelPills from './NicModelPills.jsx';
import { randomMac } from '../../utils/randomMac.js';
import { autoFocusField } from '../../lib/focus.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { useForm } from '../../hooks/useForm.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';

const FORM_ID = 'nic-editor-form';

const sideBtn =
  'flex h-[34px] shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary hover:bg-surface-sidebar transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

/* A new NIC starts on the first host bridge with a fresh locally-administered
 * MAC — the same defaults the create-flow draft rows use. */
function formFromNic(nic, bridges) {
  if (!nic) return { source: bridges[0] || '', model: 'virtio', mac: randomMac() };
  return { source: nic.source || '', model: nic.model || 'virtio', mac: nic.mac || '' };
}

/** What Save writes for the values: the MAC trimmed and in lower case. */
const nicSent = (form) => ({ source: form.source, model: form.model, mac: form.mac.trim().toLowerCase() });

/** The NIC at `index` of a VM's config, as the form shows it, while it is the NIC the
 *  editor edits (its MAC is `mac`); null when that NIC is gone. */
function pickNic(vm, index, mac) {
  const nic = (vm.nics || [])[index];
  return nic && (nic.mac || '').toLowerCase() === mac ? formFromNic(nic, []) : null;
}

/**
 * Modal form editor for one VM network interface — create when `opened` is null, edit
 * the NIC at `index` otherwise (see docs/FRONTEND-RULES.md § Modal form editor). Its
 * record is the VM's config. The wire addresses a NIC by its position (the PATCH
 * re-sends the list, and MACs may repeat), so the editor holds the position and the
 * NIC it opened on (`opened`): another NIC at that position is "gone". The section
 * owns the full-array PATCH (`onSubmit(fields, index)`).
 */
export default function NicEditorModal(props) {
  return props.open ? <NicEditor {...props} /> : null;
}

function NicEditor({ open, vmName, index, opened, bridges = [], onSubmit, onClose }) {
  const record = useRecord(RECORD.VM, vmName);
  /* A new NIC's values are fixed when the editor opens (`bridges` with them): a late
   * host-bridge refresh does not reset a form in progress. */
  const [blank] = useState(() => formFromNic(null, bridges));
  const isEdit = opened != null;
  /* The MAC the edited NIC has: the one it opened with, then the one its own save sent. */
  const [mac, setMac] = useState(() => (opened?.mac || '').toLowerCase());
  const { form, dirty, setField, saving, save: saveForm } = useForm(
    record,
    (vm) => (isEdit ? pickNic(vm, index, mac) : blank),
    nicSent,
  );
  const save = useCommand();

  /* An edit needs a change; a new NIC only its values (they are all valid). */
  const canSave = form != null && (!isEdit || dirty) && !saving;

  /* cloud-init writes the network config against the first NIC's MAC. */
  const macBreaksCloudInit = isEdit && form != null && index === 0 && nicSent(form).mac !== mac;

  const handleSave = () => {
    if (!canSave) return;
    saveForm(async (values) => {
      const ok = await save.run(() => onSubmit(values, isEdit ? index : null));
      if (ok) setMac(values.mac);
      return ok;
    }).then((ok) => { if (ok) onClose(); });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit network interface' : 'Add network interface'}
      subtitle={`net${index} · bridged`}
      size="md"
      height="cap"
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
      {form == null ? <EditorGone what="network interface" /> : (
      <form
        id={FORM_ID}
        onSubmit={(e) => { e.preventDefault(); handleSave(); }}
        className="space-y-3"
      >
        <FormField label="Bridge" htmlFor="nic-editor-bridge">
          <select
            id="nic-editor-bridge"
            value={form.source}
            onChange={(e) => setField('source', e.target.value)}
            ref={!isEdit ? autoFocusField : undefined}
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
          <NicModelPills
            value={form.model}
            onChange={(v) => setField('model', v)}
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
              onChange={(e) => setField('mac', e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="input-field min-w-0 flex-1 font-mono"
            />
            <button
              type="button"
              onClick={() => setField('mac', randomMac())}
              className={sideBtn}
              title="Randomize MAC"
              aria-label="Randomize MAC"
            >
              <Shuffle size={14} aria-hidden />
            </button>
          </div>
        </FormField>
        <ErrorBanner className="mt-3" error={save.error} onDismiss={save.dismiss} />
      </form>
      )}
    </Modal>
  );
}
