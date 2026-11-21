import { useId } from 'react';
import { Loader2 } from 'lucide-react';

import ErrorBanner from './ErrorBanner.jsx';
import Modal from './Modal.jsx';
import { formModalNeutralBtn, formModalPrimaryBtn } from './FormModalChrome.jsx';

/**
 * The shell of an editor that opens over a page (docs/FRONTEND-RULES.md, Modal form
 * editor): its fields, then Cancel and Save. `save` is the editor's command
 * (`useCommand`): Save is busy until the server answers, and its failure shows at the
 * bottom of the form, which stays open. `blocked` says why Save is off (a problem with
 * the values, or nothing changed); `onSubmit` runs on Save and on Enter.
 */
export default function FormModal({
  title, subtitle, saveLabel = 'Save', save, blocked, onSubmit, onClose, size = 'sm', footerStart, children,
}) {
  const formId = useId();
  const saving = save.busy;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size={size}
      height="cap"
      closeOnEscape={!saving}
      footer={(
        <>
          {footerStart && <div className="mr-auto flex items-center gap-2">{footerStart}</div>}
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
        <ErrorBanner error={save.error} onDismiss={save.dismiss} />
      </form>
    </Modal>
  );
}
