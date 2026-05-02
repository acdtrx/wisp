import Modal from '../shared/Modal.jsx';

export default function UpdateDetailsModal({ open, title, subtitle, footer, onClose, children }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size="2xl"
      height="cap"
      bodyPadding="none"
      footer={footer}
    >
      <div className="px-5 py-4">{children}</div>
    </Modal>
  );
}
