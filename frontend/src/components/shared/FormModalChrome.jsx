/**
 * Shared layout tokens for modal form editors — see docs/UI-PATTERNS.md
 * § Modal form editor. Mirrors DataTableChrome.jsx: one file owning the
 * classes and small building blocks so every editor modal looks the same.
 */

/** Neutral footer button (Cancel, secondary actions like Test connection). */
export const formModalNeutralBtn =
  'inline-flex items-center gap-1.5 rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none';

/** Primary footer button (Save / Create) — filled accent. */
export const formModalPrimaryBtn =
  'inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none';

/**
 * Stacked labeled control: label above the input/select, optional hint below.
 * @param {object} props
 * @param {string} props.label
 * @param {string} [props.htmlFor]
 * @param {import('react').ReactNode} [props.hint]
 * @param {string} [props.className]
 * @param {import('react').ReactNode} props.children - the control itself
 */
export function FormField({ label, htmlFor, hint, className = '', children }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-text-secondary">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-text-muted">{hint}</p>}
    </div>
  );
}

/**
 * Checkbox with label right of the box and optional hint underneath the label.
 * @param {object} props
 * @param {string} props.label
 * @param {import('react').ReactNode} [props.hint]
 * @param {boolean} props.checked
 * @param {(e: Event) => void} props.onChange
 * @param {boolean} [props.disabled]
 * @param {string} [props.title]
 */
export function FormCheckbox({ label, hint, checked, onChange, disabled = false, title }) {
  return (
    <label className={`flex items-start gap-2 ${disabled ? 'opacity-60' : 'cursor-pointer'}`} title={title}>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="mt-0.5" />
      <span>
        <span className="block text-xs font-medium text-text-secondary">{label}</span>
        {hint && <span className="block text-[11px] text-text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Sticky error line for the bottom of a form-modal body. */
export function FormModalError({ error }) {
  if (!error) return null;
  return <p className="mt-3 text-xs text-status-stopped">{error}</p>;
}
