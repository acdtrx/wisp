import { useState } from 'react';
import { Images } from 'lucide-react';

import ImageLibraryModal from '../shared/ImageLibraryModal.jsx';
import IconButton from '../shared/IconButton.jsx';

/**
 * A container image, typed or picked from the image library: the New container form's
 * and the Image editor's field. `ref` focuses it where the form opens on it.
 */
export default function ContainerImageField({ id, value, onChange, disabled = false, ref }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <>
      <div className="flex items-stretch gap-2">
        <input
          id={id}
          ref={ref}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="e.g. nginx:latest"
          autoComplete="off"
          spellCheck={false}
          className="input-field min-w-0 flex-1 font-mono"
        />
        <IconButton variant="field" icon={Images} label="Pick from the image library" disabled={disabled} onClick={() => setPickerOpen(true)} />
      </div>
      <ImageLibraryModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(selection) => {
          if (selection?.kind === 'oci' && selection.name) onChange(selection.name);
        }}
        pickerKind="container"
        defaultFilter="container"
      />
    </>
  );
}
