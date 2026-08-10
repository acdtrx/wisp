import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from '../shared/Modal.jsx';
import {
  FormField,
  FormModalError,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import { getVmIcon } from '../shared/vmIcons.jsx';
import { useHomeStore } from '../../store/homeStore.js';

const DEFAULT_ICON_ID = 'globe';

/**
 * Modal form editor for a manual Home link (docs/UI-PATTERNS.md § Modal form
 * editor). Create vs edit is the presence of `tile`; the parent only opens and
 * closes it — the store owns persistence.
 */
export default function ManualLinkModal({ open, tile, onClose }) {
  const addManualTile = useHomeStore((s) => s.addManualTile);
  const updateManualTile = useHomeStore((s) => s.updateManualTile);

  const [name, setName] = useState(tile?.name || '');
  const [url, setUrl] = useState(tile?.url || '');
  const [iconId, setIconId] = useState(tile?.iconId || DEFAULT_ICON_ID);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  const dirty =
    trimmedName !== (tile?.name || '') ||
    trimmedUrl !== (tile?.url || '') ||
    iconId !== (tile?.iconId || DEFAULT_ICON_ID);
  const valid = trimmedName.length > 0 && /^https?:\/\/\S+$/i.test(trimmedUrl);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (tile) await updateManualTile(tile.id, { name: trimmedName, url: trimmedUrl, iconId });
      else await addManualTile({ name: trimmedName, url: trimmedUrl, iconId });
      onClose();
    } catch (err) {
      setError(err.detail || err.message);
    } finally {
      setSaving(false);
    }
  };

  const Icon = getVmIcon(iconId).component;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={tile ? 'Edit link' : 'Add link'}
        subtitle="A tile for anything with a URL — on this host or elsewhere."
        size="sm"
        height="cap"
        closeOnBackdrop={!saving}
        closeOnEscape={!saving}
        footer={
          <>
            <button type="button" onClick={onClose} className={formModalNeutralBtn} disabled={saving}>
              Cancel
            </button>
            <button
              type="submit"
              form="manual-link-form"
              className={formModalPrimaryBtn}
              disabled={!valid || !dirty || saving}
            >
              {saving && <Loader2 size={13} className="animate-spin" aria-hidden />}
              {tile ? 'Save' : 'Add'}
            </button>
          </>
        }
      >
        <form id="manual-link-form" onSubmit={handleSubmit} className="space-y-3">
          <FormField label="Name" htmlFor="manual-link-name">
            <input
              id="manual-link-name"
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
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
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://192.168.1.1"
              className="input-field"
            />
          </FormField>
          <FormField label="Icon">
            <button
              type="button"
              onClick={() => setIconPickerOpen(true)}
              className="flex items-center gap-2 rounded-md border border-surface-border bg-white px-3 py-1.5 text-xs text-text-secondary hover:bg-surface transition-colors duration-150"
            >
              <Icon size={16} aria-hidden />
              <span>{getVmIcon(iconId).name}</span>
            </button>
          </FormField>
          <FormModalError error={error} />
        </form>
      </Modal>
      <IconPickerModal
        open={iconPickerOpen}
        currentIconId={iconId}
        onSelect={setIconId}
        onClose={() => setIconPickerOpen(false)}
      />
    </>
  );
}
