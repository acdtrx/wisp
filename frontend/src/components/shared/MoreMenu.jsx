import { Fragment, useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis } from 'lucide-react';

import { usePopover } from '../../lib/popover.js';

/**
 * The "More" menu of a page's header: the actions that do not earn a button of their
 * own. `items` is a list of sections, each a list of `{ icon, label, onClick, reason?,
 * danger? }`; an item with a `reason` is shown disabled with it. Picking an item
 * closes the menu.
 */
export default function MoreMenu({ items, triggerClassName }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const popRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  const popStyle = usePopover(open, { anchorRef, popRef, onClose: close, align: 'end' });
  const sections = items.filter((section) => section.length > 0);

  /* The menu by keyboard: the arrows move between the enabled items (wrapping), Home and
   * End go to the first and the last; Enter and Space are the items' own (buttons), and
   * Escape and Tab close it through the layer stack (lib/popover.js). */
  const onKeyDown = (e) => {
    const enabled = [...(popRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') ?? [])];
    if (enabled.length === 0) return;
    const at = enabled.indexOf(document.activeElement);
    const next = {
      ArrowDown: (at + 1) % enabled.length,
      ArrowUp: (at - 1 + enabled.length) % enabled.length,
      Home: 0,
      End: enabled.length - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    enabled[next].focus();
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClassName}
      >
        <Ellipsis size={18} aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          role="menu"
          tabIndex={-1}
          style={popStyle}
          onKeyDown={onKeyDown}
          className="z-[60] min-w-52 overflow-y-auto rounded-md border border-surface-border bg-surface-card py-1 shadow-popover outline-hidden"
        >
          {sections.map((section, i) => (
            <Fragment key={section.map((item) => item.label).join('|')}>
              {i > 0 && <div className="my-1 border-t border-surface-border" role="separator" />}
              {section.map(({ icon: Icon, label, onClick, reason, danger }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  disabled={!!reason}
                  title={reason}
                  onClick={() => {
                    /* Back on the trigger first: a dialog the item opens returns focus there. */
                    anchorRef.current?.focus();
                    close();
                    onClick();
                  }}
                  className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 lg:py-2 ${danger ? 'text-status-stopped hoverable:hover:bg-status-stopped-soft' : 'text-text-primary hoverable:hover:bg-surface'}`}
                >
                  <Icon size={15} aria-hidden className={danger ? '' : 'text-text-secondary'} />
                  <span className="min-w-0">
                    <span className="block">{label}</span>
                    {reason && <span className="block text-[11px] text-text-muted">{reason}</span>}
                  </span>
                </button>
              ))}
            </Fragment>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
