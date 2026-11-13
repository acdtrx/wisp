import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, CloudDownload } from 'lucide-react';
import { usePopover } from '../../lib/popover.js';

import { getVmIcon } from '../shared/vmIcons.jsx';

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
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center gap-0.5 rounded-md border border-surface-border px-1.5 py-1.5 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
        title="Download preset image"
        aria-label="Download preset image"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <CloudDownload size={14} aria-hidden />
        <ChevronDown size={12} className="text-text-muted" aria-hidden />
      </button>
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
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-primary hover:bg-surface"
                onClick={() => {
                  onSelectPreset(p.id);
                  close();
                }}
              >
                <span className="shrink-0 text-text-secondary" aria-hidden>
                  <Icon size={16} />
                </span>
                {p.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
