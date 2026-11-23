import { useId } from 'react';
import { Loader2 } from 'lucide-react';

import CommandErrors from './CommandErrors.jsx';
import Modal from './Modal.jsx';
import { formModalNeutralBtn, formModalPrimaryBtn } from './FormModalChrome.jsx';

/**
 * The shell of an editor that opens over a page (docs/FRONTEND-RULES.md, Modal form
 * editor): its fields, then Cancel and Save. `save` is the editor's command
 * (`useCommand`): Save is busy until the server answers, and its failure shows at the
 * bottom of the form, which stays open. `blocked` says why Save is off (a problem with
 * the values, or nothing changed); `onSubmit` runs on Save and on Enter. While Save
 * runs the form cannot be closed (Cancel, Escape or the X), so its failure shows.
 * A save run under keys (one form, two writes) shows one banner per failed key,
 * `errorPrefix(key)` naming it. `footerStart` holds a secondary action, at the left.
 */
export default function FormModal({
  title, subtitle, saveLabel = 'Save', save, blocked, onSubmit, onClose, size = 'sm', footerStart, errorPrefix, children,
}) {
  const formId = useId();
  const saving = save.busy;
  const close = () => { if (!saving) onClose(); };
  return (
    <Modal
      open
      onClose={close}
      title={title}
      subtitle={subtitle}
      size={size}
      height="cap"
      closeOnEscape={!saving}
      footer={(
        <>
          {footerStart && <div className="mr-auto flex min-w-0 items-center gap-2">{footerStart}</div>}
          <button type="button" onClick={onClose} disabled={saving} className={formModalNeutralBtn}>
            Cancel
          </button>
          <button type="submit" form={formId} disabled={!!blocked || saving} title={blocked ?? undefined} className={formModalPrimaryBtn}>
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {saveLabel}
          </button>
        </>
      )}
    >
      <form
        id={formId}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked && !saving) onSubmit();
        }}
      >
        {children}
        <CommandErrors commands={[save]} prefix={errorPrefix} />
      </form>
    </Modal>
  );
}
