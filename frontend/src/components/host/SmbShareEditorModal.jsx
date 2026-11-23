import { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';

import { FormField, formModalNeutralBtn } from '../shared/FormModalChrome.jsx';
import { randomId } from '../../utils/randomId.js';
import { addMount, patchMount, checkMountConnection } from '../../api/settings.js';
import { autoFocusField } from '../../lib/focus.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { changedFields, NOTHING_CHANGED } from '../../hooks/editorValues.js';
import FormModal from '../shared/FormModal.jsx';

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

/** What Save writes for the values: every field trimmed; an empty password keeps the
 *  one on file (the backend never returns it). */
const shareSent = (form) => ({
  label: form.label.trim(),
  share: form.share.trim(),
  mountPath: form.mountPath.trim(),
  username: form.username.trim(),
  password: form.password.trim(),
});

/** What an SMB share editor's values lack to be saved: a share, an absolute mount path. */
function shareProblems(form) {
  const problems = {};
  if (form.share.trim() === '') problems.share = 'Set the share (//server/share).';
  if (!form.mountPath.trim().startsWith('/')) problems.mountPath = 'Must be absolute (start with /).';
  return problems;
}

/**
 * Modal form editor for one SMB share — create when `shareId` is null, edit the
 * share with that id otherwise (see docs/FRONTEND-RULES.md § Modal form editor). Its
 * record is the settings (the mounts list). Owns validation and the add/patch/check
 * API calls; calls `onSaved` after a successful save so the parent can drop its
 * connection-test results.
 */
export default function SmbShareEditorModal(props) {
  return props.open ? <SmbShareEditor {...props} /> : null;
}

function SmbShareEditor({ share = null, onClose, onSaved }) {
  /* The share as the editor opened: it never reads the settings again. */
  const [stored] = useState(share);
  const isEdit = stored != null;
  const shareId = stored?.id ?? null;
  const { form, start, setField: setValue, dirty } = useEditor(() => (isEdit ? formFromShare(stored) : emptyForm()));
  const save = useCommand();
  const saving = save.busy;
  const problems = shareProblems(form);
  const blocked = Object.values(problems)[0] ?? null;
  /* The connection test: busy while it runs; a failure is its error, a pass shows as OK. */
  const test = useCommand();
  /* A passed test, of the values as they were. */
  const [testPassed, setTestPassed] = useState(null);
  const checking = test.busy;

  const setField = (field) => (e) => setValue(field, e.target.value);

  const trimmedShare = form.share.trim();
  /* An edit needs a change; a new share only valid values. */
  const canSave = !blocked && (!isEdit || dirty) && !saving;
  const hasStoredPassword = isEdit && stored?.hasPassword === true;

  const handleCheck = () => {
    setTestPassed(null);
    if (!trimmedShare) {
      test.fail('Set share first');
      return;
    }
    /* A saved share tests by id with the form's values as overrides, so an
     * empty password field means the stored password — same "empty keeps what's
     * on file" rule as Save. A new share has nothing on file: test what's typed. */
    const newPw = form.password.trim();
    const body = isEdit
      ? { id: form.id, share: trimmedShare, username: form.username.trim(), ...(newPw !== '' && { password: newPw }) }
      : { share: trimmedShare, username: form.username.trim(), password: newPw };
    test.run(() => checkMountConnection(body), { onDone: () => setTestPassed(true) });
  };

  const handleSave = () => {
    if (!canSave) return;
    const values = shareSent(form);
    save.run(async () => {
      if (!isEdit) {
        await addMount({ id: form.id, type: 'smb', ...values });
      } else {
        /* Only the changed fields; `password` only when one was typed. */
        await patchMount(form.id, changedFields(values, shareSent(start)));
      }
      await onSaved?.();
    }).then((ok) => { if (ok) onClose(); });
  };

  return (
    <FormModal
      title={isEdit ? 'Edit SMB share' : 'Add SMB share'}
      subtitle={isEdit ? stored?.share || stored?.label || shareId : 'Network mount over SMB/CIFS'}
      size="md"
      save={save}
      blocked={blocked ?? (isEdit && !dirty ? NOTHING_CHANGED : null)}
      onSubmit={handleSave}
      onClose={onClose}
      footerStart={(
        <>
          <button type="button" onClick={handleCheck} disabled={checking || saving} className={formModalNeutralBtn}>
            {checking ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
            Test connection
          </button>
          {testPassed && <span className="text-status-running">Connection OK</span>}
        </>
      )}
    >
      <FormField label="Label" htmlFor="smb-editor-label">
        <input
          id="smb-editor-label"
          type="text"
          value={form.label}
          onChange={setField('label')}
          placeholder="media-nas"
          ref={autoFocusField}
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
        hint={problems.mountPath ?? null}
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
      <ErrorBanner className="mt-3" error={test.error} prefix="Connection test" onDismiss={test.dismiss} />
    </FormModal>
  );
}
