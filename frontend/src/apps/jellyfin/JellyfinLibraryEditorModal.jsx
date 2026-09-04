import { useEffect, useMemo, useState } from 'react';

import Modal from '../../components/shared/Modal.jsx';
import {
  FormField,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../../components/shared/FormModalChrome.jsx';

const FORM_ID = 'jellyfin-library-editor-form';

/**
 * Create/edit one Jellyfin media library (modal form editor). Unlike the Host
 * Mgmt editors this writes no API: the section owns the whole appConfig and a
 * single section Save persists it, so `onApply` just hands the edited library
 * back to the parent's form state. Create vs edit = presence of `library`.
 *
 * Validation callbacks come from the section so the label rules (reserved
 * names, duplicates against the *other* rows) live in one place.
 */
export default function JellyfinLibraryEditorModal({
  open,
  library,
  storageMounts,
  validateLabel,
  validateSubPath,
  onApply,
  onClose,
}) {
  const empty = { label: '', sourceId: '', subPath: '' };
  const [form, setForm] = useState(empty);

  useEffect(() => {
    if (!open) return;
    setForm(library ? { label: library.label, sourceId: library.sourceId, subPath: library.subPath } : empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, library]);

  const labelError = useMemo(() => validateLabel(form.label, library), [validateLabel, form.label, library]);
  const subPathError = useMemo(
    () => (validateSubPath(form.subPath) ? null : 'Sub-path must be relative, without "." or ".." segments'),
    [validateSubPath, form.subPath],
  );
  const sourceMissing = !form.sourceId;
  const valid = !labelError && !subPathError && !sourceMissing;

  const dirty = library
    ? form.label !== library.label || form.sourceId !== library.sourceId || form.subPath !== library.subPath
    : true;

  const submit = (e) => {
    e.preventDefault();
    if (!valid || !dirty) return;
    onApply({ label: form.label.trim(), sourceId: form.sourceId, subPath: form.subPath.trim() });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      height="cap"
      title={library ? 'Edit media library' : 'Add media library'}
      subtitle={form.label.trim() ? `/media/${form.label.trim()}` : 'Mounted at /media/<label>'}
      footer={(
        <>
          <button type="button" className={formModalNeutralBtn} onClick={onClose}>Cancel</button>
          <button type="submit" form={FORM_ID} className={formModalPrimaryBtn} disabled={!valid || !dirty}>
            {library ? 'Save' : 'Add'}
          </button>
        </>
      )}
    >
      <form id={FORM_ID} onSubmit={submit} className="space-y-3">
        <FormField
          label="Label"
          htmlFor="jf-lib-label"
          hint={labelError || 'Folder name inside the container, e.g. movies → /media/movies.'}
        >
          <input
            id="jf-lib-label"
            type="text"
            className="input-field"
            placeholder="movies"
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            autoFocus
          />
        </FormField>

        <FormField
          label="Storage source"
          htmlFor="jf-lib-source"
          hint={sourceMissing ? 'Pick the Storage mount that holds this media.' : null}
        >
          <select
            id="jf-lib-source"
            className="input-field"
            value={form.sourceId}
            onChange={(e) => setForm((f) => ({ ...f, sourceId: e.target.value }))}
          >
            <option value="">— Select Storage source —</option>
            {storageMounts.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label || m.id} ({m.mountPath})
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="Sub-path"
          htmlFor="jf-lib-subpath"
          hint={subPathError || 'Optional folder inside the source, e.g. media/movies.'}
        >
          <input
            id="jf-lib-subpath"
            type="text"
            className="input-field"
            placeholder="Optional"
            value={form.subPath}
            onChange={(e) => setForm((f) => ({ ...f, subPath: e.target.value }))}
          />
        </FormField>

      </form>
    </Modal>
  );
}
