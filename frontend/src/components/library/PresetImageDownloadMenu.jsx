import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, CloudDownload } from 'lucide-react';

import { usePopover } from '../../lib/popover.js';
import { getVmIcon } from '../shared/vmIcons.jsx';
import IconButton from '../shared/IconButton.jsx';
import MenuItem from '../shared/MenuItem.jsx';

const PRESETS = [
  { id: 'ubuntu', label: 'Ubuntu Server (cloud)', iconId: 'ubuntu' },
  { id: 'arch', label: 'Arch Linux (cloud)', iconId: 'arch' },
  { id: 'haos', label: 'Home Assistant OS', iconId: 'homeassistant' },
];

/** Icon-only trigger opens a custom menu (not a native select) with preset image downloads. */
export default function PresetImageDownloadMenu({ onSelectPreset }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const popRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);
  const popStyle = usePopover(open, { anchorRef, popRef, onClose: close, align: 'end' });

  return (
    <div className="relative">
      <IconButton
        ref={anchorRef}
        label="Download preset image"
        variant="neutral"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="inline-flex items-center gap-0.5">
          <CloudDownload size={14} aria-hidden />
          <ChevronDown size={12} className="text-text-muted" aria-hidden />
        </span>
      </IconButton>
      {open && createPortal(
        <div
          ref={popRef}
          role="menu"
          tabIndex={-1}
          style={popStyle}
          className="z-[60] min-w-56 overflow-y-auto rounded-md border border-surface-border bg-surface-card py-1 shadow-popover outline-hidden"
        >
          {PRESETS.map((p) => {
            const Icon = getVmIcon(p.iconId).component;
            return (
              <MenuItem
                key={p.id}
                icon={Icon}
                label={p.label}
                onClick={() => {
                  onSelectPreset(p.id);
                  close();
                }}
              />
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
