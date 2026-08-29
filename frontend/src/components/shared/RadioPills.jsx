/**
 * Content-sized radio pills — the app-wide single-choice control (selected =
 * accent wash, same idiom as the Boot Order chips). Replaces the full-width
 * segmented bars: pills size to their labels and wrap instead of stretching.
 * `icons` optionally maps option values to icon components rendered before the
 * label.
 */
export default function RadioPills({ options, value, onChange, disabled, icons }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {options.map((opt) => {
        const Icon = icons?.[opt.value];
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => !disabled && onChange(opt.value)}
            disabled={disabled}
            aria-checked={value === opt.value}
            role="radio"
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors duration-150 ${
              value === opt.value
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-surface-border text-text-muted hover:text-text-secondary'
            } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            {Icon && <Icon size={11} />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
