import { useState } from 'react';

import { FormField } from '../shared/FormModalChrome.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import { getVmIcon } from '../shared/vmIcons.jsx';
import { useHomeStore } from '../../store/homeStore.js';
import { autoFocusField } from '../../lib/focus.js';
import { useCommand } from '../../hooks/useCommand.js';
import FormModal from '../shared/FormModal.jsx';

const DEFAULT_ICON_ID = 'globe';

/**
 * Modal for adding a manual Home link (docs/FRONTEND-RULES.md § Modal form editor):
 * its values are the add command's input, its own state. The parent only opens and
 * closes it — the store owns persistence.
 */
export default function ManualLinkModal(props) {
  return props.open ? <ManualLinkEditor {...props} /> : null;
}

function ManualLinkEditor({ onClose }) {
  const addManualTile = useHomeStore((s) => s.addManualTile);
  const [link, setLink] = useState({ name: '', url: '', iconId: DEFAULT_ICON_ID });
  const setField = (key, value) => setLink((l) => ({ ...l, [key]: value }));
  const { name, url, iconId } = link;
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const save = useCommand();

  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  const valid = trimmedName.length > 0 && /^https?:\/\/\S+$/i.test(trimmedUrl);

  const Icon = getVmIcon(iconId).component;

  return (
    <>
      <FormModal
        title="Add link"
        subtitle="A tile for anything with a URL — on this host or elsewhere."
        saveLabel="Add"
        save={save}
        blocked={valid ? null : 'Set a name and a URL that starts with http:// or https://.'}
        onSubmit={() => save.run(() => addManualTile({ name: trimmedName, url: trimmedUrl, iconId }), { onDone: onClose })}
        onClose={onClose}
      >
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
      </FormModal>
      <IconPickerModal
        open={iconPickerOpen}
        currentIconId={iconId}
        onSelect={(next) => setField('iconId', next)}
        onClose={() => setIconPickerOpen(false)}
      />
    </>
  );
}
