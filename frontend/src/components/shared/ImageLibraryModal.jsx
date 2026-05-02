import ImageLibrary from '../library/ImageLibrary.jsx';
import Modal from './Modal.jsx';

export default function ImageLibraryModal({ open, onClose, onSelect, defaultFilter = 'all', pickerKind = 'vm' }) {
  const handleSelect = (selection) => {
    onSelect(selection);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Select Image"
      size="3xl"
      height="tall"
      bodyPadding="none"
    >
      <ImageLibrary
        mode="picker"
        pickerKind={pickerKind}
        onSelect={handleSelect}
        defaultFilter={defaultFilter}
      />
    </Modal>
  );
}
