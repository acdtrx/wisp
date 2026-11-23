import Modal from './Modal.jsx';
import Button from './Button.jsx';

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
  return (
    <Modal
      open={open}
      onClose={onCancel}
      ariaLabel={typeof title === 'string' ? title : undefined}
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
          <Button onClick={onCancel}>{cancelLabel}</Button>
          {/* The danger fill inverts its label in dark (the variant's dark:text-surface):
              white on the lifted coral falls under 3:1. */}
          <Button variant={variant === 'primary' ? 'primary' : 'danger'} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}
