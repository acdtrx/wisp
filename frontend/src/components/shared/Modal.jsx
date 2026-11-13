import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useLayer, focusIntoLayer } from '../../lib/layers.js';

const SIZE_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
};

const HEIGHT_CLASS = {
  auto: '',
  tall: 'h-[80vh]',
  cap: 'max-h-[85vh]',
};

const BODY_PADDING_CLASS = {
  default: 'px-4 py-4',
  compact: 'px-4 py-3',
  none: '',
};

/**
 * Shared modal shell. Owns the backdrop, the layer (lib/layers.js: Escape
 * closes only the top layer, Tab stays inside, the page under it is inert,
 * focus returns to the opener on close), and an optional title/X header +
 * footer. Rendered in a portal on `document.body`, so the app root can be made
 * inert under it. Standardized on a `bg-black/40` backdrop (deepened to /60 in
 * dark, where 40% over an already-dark canvas barely separates the dialog from
 * the page) and a `bg-surface-card` body. A click beside the modal closes
 * nothing: Escape, the X and Cancel do.
 *
 * @param {boolean} open
 * @param {() => void} onClose - called on the X and on Escape
 * @param {React.ReactNode} [title]
 * @param {React.ReactNode} [subtitle] - small muted text under title
 * @param {string} [ariaLabel] - the dialog's accessible name when there is no `title`
 * @param {React.ReactNode} [headerExtra] - rendered to the left of the close X
 * @param {React.ReactNode} [footer] - rendered in a bottom-bordered footer bar
 * @param {'sm'|'md'|'lg'|'xl'|'2xl'|'3xl'|'4xl'} [size]
 * @param {'auto'|'tall'|'cap'} [height]
 * @param {'default'|'compact'|'none'} [bodyPadding]
 * @param {boolean} [closeOnEscape] - false while a save runs: Escape then does nothing
 * @param {string} [className] - extra classes on the modal card
 */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  ariaLabel,
  headerExtra,
  footer,
  size = 'md',
  height = 'auto',
  bodyPadding = 'default',
  closeOnEscape = true,
  className = '',
  children,
}) {
  const layerRef = useRef(null);
  const cardRef = useRef(null);
  const titleId = useId();

  useLayer(open, {
    kind: 'modal',
    ref: layerRef,
    onEscape: closeOnEscape ? () => onClose?.() : undefined,
  });

  /* Into the dialog once it is on screen — after its fields' own touch-aware
   * autofocus, which this leaves alone. */
  useEffect(() => {
    if (open) focusIntoLayer(cardRef.current);
  }, [open]);

  if (!open) return null;

  const widthCls = SIZE_CLASS[size] || SIZE_CLASS.md;
  const heightCls = HEIGHT_CLASS[height] || '';
  const bodyPadCls = BODY_PADDING_CLASS[bodyPadding] ?? BODY_PADDING_CLASS.default;
  const showHeader = title != null || headerExtra != null;

  return createPortal(
    <div
      ref={layerRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4"
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? ariaLabel : undefined}
        tabIndex={-1}
        className={`relative flex w-full ${widthCls} ${heightCls} flex-col overflow-hidden rounded-card border border-surface-border bg-surface-card shadow-popover outline-hidden ${className}`}
      >
        {showHeader && (
          <div className="flex items-start justify-between gap-3 border-b border-surface-border px-4 py-3 shrink-0">
            <div className="min-w-0 flex-1">
              {title != null && (
                <h3 id={titleId} className="truncate text-sm font-semibold text-text-primary">{title}</h3>
              )}
              {subtitle != null && (
                <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {headerExtra}
              <button
                type="button"
                onClick={() => onClose?.()}
                className="rounded-lg p-2 lg:p-1 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
                aria-label="Close"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
          </div>
        )}
        <div className={`min-h-0 flex-1 overflow-y-auto ${bodyPadCls}`}>
          {children}
        </div>
        {footer != null && (
          <div className="flex justify-end gap-2 border-t border-surface-border px-4 py-3 text-xs shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
