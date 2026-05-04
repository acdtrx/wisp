import Modal from '../shared/Modal.jsx';

export default function UpdateDetailsModal({ open, title, subtitle, footer, headerAction, onClose, children }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      headerExtra={headerAction}
      size="2xl"
      height="cap"
      bodyPadding="none"
      footer={footer}
    >
      <div className="px-5 py-4">{children}</div>
    </Modal>
  );
}
