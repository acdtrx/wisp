import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from '../shared/Modal.jsx';
import {
  FormField,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import { getVmIcon } from '../shared/vmIcons.jsx';
import { useHomeStore } from '../../store/homeStore.js';
import { autoFocusField } from '../../lib/focus.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { useCommand } from '../../hooks/useCommand.js';

const DEFAULT_ICON_ID = 'globe';

/**
 * Modal for adding a manual Home link (docs/FRONTEND-RULES.md § Modal form editor):
 * its values are the add command's input, its own state. The parent only opens and
 * closes it — the store owns persistence.
 */
export default function ManualLinkModal(props) {
  return props.open ? <ManualLinkEditor {...props} /> : null;
}

function ManualLinkEditor({ open, onClose }) {
  const addManualTile = useHomeStore((s) => s.addManualTile);
  const [link, setLink] = useState({ name: '', url: '', iconId: DEFAULT_ICON_ID });
  const setField = (key, value) => setLink((l) => ({ ...l, [key]: value }));
  const { name, url, iconId } = link;
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const save = useCommand();

  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  const valid = trimmedName.length > 0 && /^https?:\/\/\S+$/i.test(trimmedUrl);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!valid) return;
    save.run(() => addManualTile({ name: trimmedName, url: trimmedUrl, iconId }), { onDone: onClose });
  };

  const Icon = getVmIcon(iconId).component;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Add link"
        subtitle="A tile for anything with a URL — on this host or elsewhere."
        size="sm"
        height="cap"
        closeOnEscape={!save.busy}
        footer={
          <>
            <button type="button" onClick={onClose} className={formModalNeutralBtn} disabled={save.busy}>
              Cancel
            </button>
            <button
              type="submit"
              form="manual-link-form"
              className={formModalPrimaryBtn}
              disabled={!valid || save.busy}
            >
              {save.busy && <Loader2 size={13} className="animate-spin" aria-hidden />}
              Add
            </button>
          </>
        }
      >
        <form id="manual-link-form" onSubmit={handleSubmit} className="space-y-3">
          <FormField label="Name" htmlFor="manual-link-name">
            <input
              id="manual-link-name"
              type="text"
              ref={autoFocusField}
              value={name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="Router"
              maxLength={64}
              className="input-field"
            />
          </FormField>
          <FormField
            label="URL"
            htmlFor="manual-link-url"
            hint="Must start with http:// or https://"
          >
            <input
              id="manual-link-url"
              type="text"
              value={url}
              onChange={(e) => setField('url', e.target.value)}
              placeholder="https://192.168.1.1"
              className="input-field"
            />
          </FormField>
          <FormField label="Icon">
            <button
              type="button"
              onClick={() => setIconPickerOpen(true)}
              className="flex items-center gap-2 rounded-md border border-surface-border bg-surface-input px-3 py-1.5 text-xs text-text-secondary hover:bg-surface transition-colors duration-150"
            >
              <Icon size={16} aria-hidden />
              <span>{getVmIcon(iconId).name}</span>
            </button>
          </FormField>
          <ErrorBanner className="mt-3" error={save.error} onDismiss={save.dismiss} />
        </form>
      </Modal>
      <IconPickerModal
        open={iconPickerOpen}
        currentIconId={iconId}
        onSelect={(next) => setField('iconId', next)}
        onClose={() => setIconPickerOpen(false)}
      />
    </>
  );
}
