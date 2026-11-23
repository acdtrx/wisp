import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

/*
 * The one icon-only button (docs/FRONTEND-RULES.md, Design: action buttons are
 * icon-only, named by `title` and `aria-label`). Its look comes from `variant`,
 * `size` and `tone`; the caller's classes only place it.
 */
const BASE = 'relative inline-flex shrink-0 items-center justify-center transition-colors duration-150 '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent '
  + 'disabled:cursor-not-allowed disabled:opacity-40';

const SIZE = {
  xs: 'rounded-sm p-2 lg:p-0.5',
  sm: 'rounded-md p-2 lg:p-1.5',
  md: 'h-9 min-w-9 rounded-md px-2 lg:h-8 lg:min-w-8 lg:px-1.5',
  lg: 'h-9 w-9 rounded-md lg:h-8 lg:w-8',
};
const ICON_SIZE = { xs: 11, sm: 14, md: 15, lg: 17 };

const VARIANT = {
  plain: 'text-text-muted hoverable:hover:bg-accent-soft hoverable:hover:text-accent-text disabled:hover:bg-transparent',
  danger: 'text-text-muted hoverable:hover:bg-status-stopped-soft hoverable:hover:text-status-stopped disabled:hover:bg-transparent',
  positive: 'text-text-muted hoverable:hover:bg-status-running-soft hoverable:hover:text-status-running disabled:hover:bg-transparent',
  neutral: 'border border-surface-border text-text-secondary hoverable:hover:bg-surface hoverable:hover:text-text-primary',
  'neutral-danger': 'border border-surface-border text-text-secondary hoverable:hover:bg-status-stopped-soft hoverable:hover:text-status-stopped',
  primary: 'bg-accent text-white hoverable:hover:bg-accent-hover',
  /* Beside a text field, as tall as it. */
  field: 'self-stretch rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary hoverable:hover:bg-surface-sidebar',
  /* No chrome: the content (`children`) is the look. */
  bare: 'rounded-md',
};

/* A state the button shows in its own background (a mount mounted, a check passed). */
const TONE = {
  running: 'border border-status-running/30 bg-status-running-soft text-status-running',
  stopped: 'border border-status-stopped/30 bg-status-stopped-soft text-status-stopped',
};

/** An icon (or an Add's `Plus` with the kind it adds) at the size's icon size. */
function Glyph({ icon: Icon, kindIcon: KindIcon, size, pressed }) {
  const iconSize = ICON_SIZE[size];
  return (
    <span className="inline-flex items-center">
      <Icon size={KindIcon ? Math.max(iconSize - 3, 10) : iconSize} fill={pressed ? 'currentColor' : 'none'} aria-hidden />
      {KindIcon && <KindIcon size={iconSize} aria-hidden />}
    </span>
  );
}

/**
 * A link that only navigates, with an icon button's look (`variant`, `size`): named by
 * `label` on hover and to a screen reader.
 */
export function IconLink({ to, icon, kindIcon, label, variant = 'plain', size = 'md', className = '' }) {
  return (
    <Link
      to={to}
      title={label}
      aria-label={label}
      className={`${BASE} ${SIZE[size]} ${VARIANT[variant]}${className ? ` ${className}` : ''}`}
    >
      <Glyph icon={icon} kindIcon={kindIcon} size={size} />
    </Link>
  );
}

/**
 * An icon-only button: `icon` (an Add pairs a `Plus` with the kind it adds, `kindIcon`),
 * named by `label` on hover and to a screen reader. A disabled action says why in
 * `reason`, shown in its place; `busy` while its command runs (a spinner, off).
 * `pressed` (true or false) makes it a toggle: its icon filled while on. `variant`
 * plain | danger | positive | neutral | neutral-danger | primary | field | bare;
 * `size` xs | sm | md | lg; `tone` running | stopped; `badge` is drawn at its corner;
 * `children` replace the icon (the `bare` variant's content). `title` overrides the
 * hover text when it says more than the name.
 */
export default function IconButton({
  icon: Icon, kindIcon: KindIcon, label, reason, title, busy = false, pressed, variant = 'plain', size = 'md',
  tone, badge, disabled = false, type = 'button', className = '', children, ...rest
}) {
  const off = disabled || !!reason || busy;
  const name = reason ? `${label}: ${reason}` : label;
  const iconSize = ICON_SIZE[size];
  /* A tone replaces the variant's colours: it is the state the button shows. */
  const look = variant === 'field' || variant === 'bare' ? VARIANT[variant] : `${SIZE[size]} ${tone ? TONE[tone] : VARIANT[variant]}`;
  const content = busy
    ? <Loader2 size={iconSize} className="animate-spin" aria-hidden />
    : children ?? <Glyph icon={Icon} kindIcon={KindIcon} size={size} pressed={pressed} />;
  return (
    <button
      type={type}
      disabled={off}
      title={reason ? name : title ?? label}
      aria-label={name}
      aria-pressed={pressed}
      className={`${BASE} ${look}${pressed ? ' text-accent-text' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {content}
      {badge}
    </button>
  );
}
