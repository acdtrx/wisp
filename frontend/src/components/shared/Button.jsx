import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

/*
 * The one text button (docs/FRONTEND-RULES.md, Design): its look comes from `variant`
 * and `size`, never from the caller's classes, which place it only (margin, flex or
 * grid position, width).
 */
const BASE = 'relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-150 '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent '
  + 'disabled:cursor-not-allowed disabled:opacity-50';

/* Padding, radius and text size of the action variants. */
const SIZE = {
  xs: 'rounded-sm px-2 py-0.5 text-[11px]',
  sm: 'rounded-md px-3 py-1.5 text-xs',
  md: 'rounded-md px-4 py-2 text-sm',
};
const ICON_SIZE = { xs: 12, sm: 14, md: 16 };
/* Literal class strings: a computed class name generates no CSS. */
const LABEL_FROM = { lg: 'hidden lg:inline' };
/* A label shown only from `lg`: an icon button below it, a compact text button from it. */
const LABEL_FROM_SIZE = { lg: 'rounded-md p-2 text-sm lg:px-2.5 lg:py-1' };

const ACTION = {
  primary: 'justify-center bg-accent text-white hoverable:hover:bg-accent-hover',
  neutral: 'justify-center border border-surface-border bg-surface-card text-text-secondary hoverable:hover:bg-surface hoverable:hover:text-text-primary',
  danger: 'justify-center bg-status-stopped text-white dark:text-surface hoverable:hover:bg-status-stopped/90',
  ghost: 'justify-center text-text-muted hoverable:hover:bg-surface hoverable:hover:text-text-secondary',
};

/*
 * The choice variants: one option of a pick-one or a toggle set, `selected` when it
 * is the one picked (or pressed). Their own sizes.
 */
const CHOICE = {
  pill: (on) => `rounded-md border px-2.5 py-1 text-xs ${on
    ? 'border-accent bg-accent-soft text-accent-text'
    : 'border-surface-border text-text-muted hoverable:hover:text-text-secondary'}`,
  segment: (on, size) => `rounded-md ${size === 'xs' ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs'} ${on
    ? 'bg-surface-card text-text-primary shadow-xs'
    : 'text-text-muted hoverable:hover:text-text-secondary'}`,
  card: (on) => `min-w-0 flex-col items-start! whitespace-normal! rounded-md border px-2.5 py-2 text-left ${on
    ? 'border-accent bg-accent-soft text-accent-text'
    : 'border-surface-border text-text-secondary hoverable:hover:bg-surface'}`,
};

/** The classes of a button's look. */
function buttonClasses({ variant = 'neutral', size = 'sm', selected = false, fullWidth = false, labelFrom } = {}) {
  const look = labelFrom
    ? `${LABEL_FROM_SIZE[labelFrom]} ${ACTION[variant]}`
    : CHOICE[variant]
    ? CHOICE[variant](selected, size)
    : variant === 'link'
      ? `p-0 ${size === 'xs' ? 'text-[11px]' : 'text-xs'} text-accent-text hoverable:hover:underline`
      : `${SIZE[size]} ${ACTION[variant]}`;
  return `${BASE} ${look}${fullWidth ? ' w-full justify-center' : ''}`;
}

/** A link that only navigates, with a text button's look (`variant`, `size`, `icon`). */
export function ButtonLink({ to, variant = 'neutral', size = 'sm', icon: Icon, className = '', children }) {
  return (
    <Link to={to} className={`${buttonClasses({ variant, size })}${className ? ` ${className}` : ''}`}>
      {Icon && <Icon size={ICON_SIZE[size] ?? 14} aria-hidden />}
      {children}
    </Link>
  );
}

/**
 * A button with a text label: `variant` primary | neutral | danger | ghost |
 * link, or a choice look (pill | segment | card, with `selected`); `size` xs | sm | md.
 * `icon` (and `iconEnd`) are lucide components; `busy` shows a spinner in the icon's
 * place and turns the button off. `labelFrom="lg"` shows the label only from that
 * breakpoint (the icon alone below it, the label then its accessible name). `badge` is
 * drawn at the top right corner. A button never submits a form unless `type="submit"`.
 */
export default function Button({
  variant = 'neutral', size = 'sm', icon: Icon, iconEnd: IconEnd, busy = false, selected = false,
  fullWidth = false, labelFrom, badge, type = 'button', disabled = false, className = '', children, ...rest
}) {
  const iconSize = labelFrom ? 18 : CHOICE[variant] ? 11 : ICON_SIZE[size] ?? 14;
  const label = labelFrom ? <span className={LABEL_FROM[labelFrom]}>{children}</span> : children;
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-label={labelFrom && typeof children === 'string' ? children : undefined}
      className={`${buttonClasses({ variant, size, selected, fullWidth, labelFrom })}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {busy ? <Loader2 size={iconSize} className="animate-spin" aria-hidden /> : Icon && <Icon size={iconSize} aria-hidden />}
      {label}
      {IconEnd && <IconEnd size={iconSize - 2} aria-hidden />}
      {badge}
    </button>
  );
}
