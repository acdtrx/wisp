/**
 * Checkbox-style toggle switch. Use for boolean options.
 */
export default function Toggle({ checked, onChange, disabled = false }) {
  return (
    <label className={`relative inline-flex items-center ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => !disabled && onChange(e.target.checked)}
        disabled={disabled}
        className="peer sr-only"
      />
      <div className="h-5 w-9 rounded-full bg-surface-border peer-checked:bg-accent peer-focus:ring-2 peer-focus:ring-accent/25 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform after:duration-150 peer-checked:after:translate-x-full" />
    </label>
  );
}
