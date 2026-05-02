import Modal from './Modal.jsx';

export default function ConfirmDialog({
  open,
  title,
  message,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  onConfirm,
  onCancel,
}) {
  const confirmCls =
    variant === 'primary'
      ? 'rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150'
      : 'rounded-md bg-status-stopped px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors duration-150';

  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      bodyPadding="none"
    >
      <div className="p-6">
        {title && <h3 className="text-sm font-semibold text-text-primary">{title}</h3>}
        {children != null ? (
          <div className={`${title ? 'mt-2 ' : ''}text-sm text-text-secondary`}>{children}</div>
        ) : message ? (
          <p className={`${title ? 'mt-2 ' : ''}text-sm text-text-secondary`}>{message}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface transition-colors duration-150"
          >
            {cancelLabel}
          </button>
          <button onClick={onConfirm} className={confirmCls}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
