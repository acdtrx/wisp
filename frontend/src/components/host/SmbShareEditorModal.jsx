import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import {
  FormField,
  FormModalError,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import { randomId } from '../../utils/randomId.js';
import { addMount, patchMount, checkMountConnection } from '../../api/settings.js';

const FORM_ID = 'smb-share-editor-form';

function emptyForm() {
  const id = randomId();
  return {
    id,
    label: '',
    share: '',
    mountPath: `/mnt/wisp/smb-${id.slice(0, 6)}`,
    username: '',
    password: '',
  };
}

function formFromShare(share) {
  return {
    id: share.id,
    label: share.label || '',
    share: share.share || '',
    mountPath: share.mountPath || '',
    username: share.username || '',
    /* Backend never returns the password; empty means "keep what's on file". */
    password: '',
  };
}

/**
 * Modal form editor for one SMB share — create when `share` is null, edit
 * otherwise (see docs/UI-PATTERNS.md § Modal form editor). Owns validation
 * and the add/patch/check API calls; calls `onSaved` after a successful save
 * so the parent can refresh settings and mount status.
 */
export default function SmbShareEditorModal({ open, share, onClose, onSaved }) {
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState(null);
  const [error, setError] = useState(null);

  const isEdit = share != null;

  useEffect(() => {
    if (!open) return;
    setForm(share ? formFromShare(share) : emptyForm());
    setCheck(null);
    setError(null);
  }, [open, share]);

  const setField = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const trimmedShare = form.share.trim();
  const trimmedPath = form.mountPath.trim();
  const pathOk = trimmedPath.startsWith('/');
  const dirty = !isEdit
    || form.label.trim() !== (share.label || '').trim()
    || trimmedShare !== (share.share || '').trim()
    || trimmedPath !== (share.mountPath || '').trim()
    || form.username.trim() !== (share.username || '').trim()
    || form.password.trim() !== '';
  const canSave = pathOk && trimmedShare !== '' && dirty && !saving;
  const hasStoredPassword = isEdit && share.hasPassword === true;

  /* Test against the stored credentials only when nothing credential-affecting
   * was edited; otherwise test exactly what's typed in the form. */
  const credsDirty = !isEdit
    || trimmedShare !== (share.share || '').trim()
    || form.username.trim() !== (share.username || '').trim()
    || form.password.trim() !== '';

  const handleCheck = () => {
    if (!trimmedShare) {
      setCheck({ error: 'Set share first' });
      return;
    }
    setChecking(true);
    setCheck(null);
    const body = credsDirty
      ? { share: trimmedShare, username: form.username.trim(), password: form.password.trim() }
      : { id: form.id };
    checkMountConnection(body)
      .then(() => setCheck({ ok: true }))
      .catch((err) => setCheck({ error: err.detail || err.message || 'Failed' }))
      .finally(() => setChecking(false));
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (!isEdit) {
        await addMount({
          id: form.id,
          type: 'smb',
          label: form.label.trim(),
          share: trimmedShare,
          mountPath: trimmedPath,
          username: form.username.trim(),
          password: form.password.trim(),
        });
      } else {
        const patch = {};
        if (form.label.trim() !== (share.label || '').trim()) patch.label = form.label.trim();
        if (trimmedPath !== (share.mountPath || '').trim()) patch.mountPath = trimmedPath;
        if (trimmedShare !== (share.share || '').trim()) patch.share = trimmedShare;
        if (form.username.trim() !== (share.username || '').trim()) patch.username = form.username.trim();
        /* Only send `password` when the user actually typed one; empty means
         * "keep what's on file" (the backend never returns the stored value). */
        const newPw = form.password.trim();
        if (newPw !== '') patch.password = newPw;
        if (Object.keys(patch).length > 0) await patchMount(form.id, patch);
      }
      await onSaved?.();
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
      title={isEdit ? 'Edit SMB share' : 'Add SMB share'}
      subtitle={isEdit ? share.share || share.label : 'Network mount over SMB/CIFS'}
      size="md"
      height="cap"
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      footer={(
        <>
          <div className="mr-auto flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={handleCheck}
              disabled={checking || saving}
              className={formModalNeutralBtn}
            >
              {checking
                ? <Loader2 size={14} className="animate-spin" aria-hidden />
                : <ShieldCheck size={14} aria-hidden />}
              Test connection
            </button>
            {check?.ok && <span className="text-status-running">Connection OK</span>}
            {check?.error && (
              <span className="min-w-0 truncate text-status-stopped" title={check.error}>
                {check.error}
              </span>
            )}
          </div>
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
        <FormField label="Label" htmlFor="smb-editor-label">
          <input
            id="smb-editor-label"
            type="text"
            value={form.label}
            onChange={setField('label')}
            placeholder="media-nas"
            autoFocus
            className="input-field"
          />
        </FormField>
        <FormField label="Share" htmlFor="smb-editor-share">
          <input
            id="smb-editor-share"
            type="text"
            value={form.share}
            onChange={setField('share')}
            placeholder="//server/share"
            className="input-field font-mono"
          />
        </FormField>
        <FormField
          label="Mount path"
          htmlFor="smb-editor-path"
          hint={pathOk ? null : 'Must be absolute (start with /).'}
        >
          <input
            id="smb-editor-path"
            type="text"
            value={form.mountPath}
            onChange={setField('mountPath')}
            placeholder="/mnt/wisp/smb"
            className="input-field font-mono"
          />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Username" htmlFor="smb-editor-user">
            <input
              id="smb-editor-user"
              type="text"
              value={form.username}
              onChange={setField('username')}
              placeholder="Optional"
              autoComplete="off"
              className="input-field"
            />
          </FormField>
          <FormField
            label="Password"
            htmlFor="smb-editor-password"
            hint={hasStoredPassword ? 'Leave empty to keep the saved password.' : null}
          >
            <input
              id="smb-editor-password"
              type="password"
              value={form.password}
              onChange={setField('password')}
              placeholder={hasStoredPassword ? '••••' : 'Optional'}
              autoComplete="new-password"
              className="input-field"
            />
          </FormField>
        </div>
        <FormModalError error={error} />
      </form>
    </Modal>
  );
}
