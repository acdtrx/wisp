import Modal from './Modal.jsx';

/**
 * Single-button informational dialog. Drop-in replacement for `alert()`.
 *
 * @param {boolean} open
 * @param {string} [title]
 * @param {string} [message]
 * @param {React.ReactNode} [children]
 * @param {string} [okLabel]
 * @param {() => void} onClose
 * @param {'info'|'error'} [tone] - error highlights the title in stopped color
 */
export default function AlertDialog({
  open,
  title,
  message,
  children,
  okLabel = 'OK',
  onClose,
  tone = 'info',
}) {
  const titleCls =
    tone === 'error'
      ? 'text-sm font-semibold text-status-stopped'
      : 'text-sm font-semibold text-text-primary';

  return (
    <Modal open={open} onClose={onClose} size="sm" bodyPadding="none">
      <div className="p-6">
        {title && <h3 className={titleCls}>{title}</h3>}
        {children != null ? (
          <div className={`${title ? 'mt-2 ' : ''}text-sm text-text-secondary`}>{children}</div>
        ) : message ? (
          <p className={`${title ? 'mt-2 ' : ''}text-sm text-text-secondary`}>{message}</p>
        ) : null}
        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150"
          >
            {okLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
