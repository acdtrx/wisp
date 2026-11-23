import Button from './Button.jsx';

/* The group around the options, per look. */
const GROUP = {
  pill: 'flex flex-wrap gap-1.5',
  segment: 'flex rounded-md border border-surface-border bg-surface p-0.5',
  card: 'grid gap-2',
};

/**
 * The one pick-one control: a radio group of `options` (`{ value, label, detail? }`).
 * `variant` pill (content-sized pills that wrap), segment (a segmented bar; `size` xs
 * or sm) or card (a grid of choices, each with its `detail` under the label; the
 * caller's `className` sets the grid's columns). `icons` maps option values to icon
 * components drawn before the label. `label` names the group to a screen reader.
 */
export default function RadioPills({
  options, value, onChange, disabled, icons, variant = 'pill', size = 'sm', label, className = '',
}) {
  return (
    <div className={`${GROUP[variant]}${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={label}>
      {options.map((opt) => {
        const Icon = icons?.[opt.value];
        const on = value === opt.value;
        return (
          <Button
            key={opt.value}
            variant={variant}
            size={size}
            selected={on}
            role="radio"
            aria-checked={on}
            disabled={disabled}
            icon={variant === 'card' ? undefined : Icon}
            onClick={() => { if (!disabled) onChange(opt.value); }}
          >
            {variant === 'card' ? (
              <>
                <span className="flex items-center gap-1.5 text-sm font-medium">{Icon && <Icon size={16} aria-hidden />}{opt.label}</span>
                {opt.detail && <span className="text-[11px] text-text-muted">{opt.detail}</span>}
              </>
            ) : opt.label}
          </Button>
        );
      })}
    </div>
  );
}
