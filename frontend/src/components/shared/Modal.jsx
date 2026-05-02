import { useCallback } from 'react';
import { X } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';

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
 * Shared modal shell. Owns backdrop, escape, modal-root marker, and an
 * optional title/X header + footer. Standardized on `bg-black/40` backdrop
 * and `bg-surface-card` body.
 *
 * @param {boolean} open
 * @param {() => void} onClose - called on backdrop click, X, and Escape
 * @param {React.ReactNode} [title]
 * @param {React.ReactNode} [subtitle] - small muted text under title
 * @param {React.ReactNode} [headerExtra] - rendered to the left of the close X
 * @param {React.ReactNode} [footer] - rendered in a bottom-bordered footer bar
 * @param {'sm'|'md'|'lg'|'xl'|'2xl'|'3xl'|'4xl'} [size]
 * @param {'auto'|'tall'|'cap'} [height]
 * @param {'default'|'compact'|'none'} [bodyPadding]
 * @param {boolean} [closeOnBackdrop]
 * @param {boolean} [closeOnEscape]
 * @param {string} [className] - extra classes on the modal card
 */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  headerExtra,
  footer,
  size = 'md',
  height = 'auto',
  bodyPadding = 'default',
  closeOnBackdrop = true,
  closeOnEscape = true,
  className = '',
  children,
}) {
  const handleEscape = useCallback(() => {
    if (closeOnEscape) onClose?.();
  }, [closeOnEscape, onClose]);

  useEscapeKey(open, handleEscape);

  if (!open) return null;

  const handleBackdrop = () => {
    if (closeOnBackdrop) onClose?.();
  };

  const widthCls = SIZE_CLASS[size] || SIZE_CLASS.md;
  const heightCls = HEIGHT_CLASS[height] || '';
  const bodyPadCls = BODY_PADDING_CLASS[bodyPadding] ?? BODY_PADDING_CLASS.default;
  const showHeader = title != null || headerExtra != null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleBackdrop}
    >
      <div
        className={`relative flex w-full ${widthCls} ${heightCls} flex-col overflow-hidden rounded-card border border-surface-border bg-surface-card shadow-lg ${className}`}
        data-wisp-modal-root
        onClick={(e) => e.stopPropagation()}
      >
        {showHeader && (
          <div className="flex items-start justify-between gap-3 border-b border-surface-border px-4 py-3 shrink-0">
            <div className="min-w-0 flex-1">
              {title != null && (
                <h3 className="truncate text-sm font-semibold text-text-primary">{title}</h3>
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
                className="rounded-lg p-1 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
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
    </div>
  );
}
