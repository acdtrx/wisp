import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

/*
 * The one icon-only button (docs/FRONTEND-RULES.md, Design: action buttons are
 * icon-only, named by `title` and `aria-label`). Its look comes from `variant`, `size`,
 * `tone` and `pressed`, never from the caller's classes. `className` is placement only
 * (position, margin, flex or grid self-placement), and the primitive sets none of those
 * itself: two classes for one property resolve by their order in the CSS, not in the
 * string, so a primitive's own `relative` could beat a caller's `absolute`. Only a
 * button that draws a `badge` is `relative`, for the badge.
 */
const BASE = 'inline-flex shrink-0 items-center justify-center transition-colors duration-150 '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent '
  + 'disabled:cursor-not-allowed disabled:opacity-40';

/* Padding and radius per size; the field and bare variants have their own shape. */
const SIZE = {
  xs: 'rounded-sm p-2 lg:p-0.5',
  sm: 'rounded-md p-2 lg:p-1.5',
  md: 'h-9 min-w-9 rounded-md px-2 lg:h-8 lg:min-w-8 lg:px-1.5',
  lg: 'h-9 w-9 rounded-md lg:h-8 lg:w-8',
};
const ICON_SIZE = { xs: 11, sm: 14, md: 15, lg: 17 };
const SHAPE = {
  /* Beside a text field, as tall as the row it sits in. */
  field: 'rounded-md border px-2.5',
  /* No chrome: the content (`children`) is the look. */
  bare: 'rounded-md',
};

/* The colours of each variant at rest and on hover. */
const COLOURS = {
  plain: 'text-text-muted hoverable:hover:bg-accent-soft hoverable:hover:text-accent-text disabled:hover:bg-transparent',
  danger: 'text-text-muted hoverable:hover:bg-status-stopped-soft hoverable:hover:text-status-stopped disabled:hover:bg-transparent',
  positive: 'text-text-muted hoverable:hover:bg-status-running-soft hoverable:hover:text-status-running disabled:hover:bg-transparent',
  neutral: 'border border-surface-border text-text-secondary hoverable:hover:bg-surface hoverable:hover:text-text-primary',
  'neutral-danger': 'border border-surface-border text-text-secondary hoverable:hover:bg-status-stopped-soft hoverable:hover:text-status-stopped',
  primary: 'bg-accent text-white hoverable:hover:bg-accent-hover',
  field: 'border-surface-border bg-surface text-text-secondary hoverable:hover:bg-surface-sidebar',
  bare: '',
};

/* A state the button shows in its own colours (a mount mounted, a check passed, a
   copy done). It replaces the variant's colours rather than adding to them. */
const TONE = {
  running: 'border border-status-running/30 bg-status-running-soft text-status-running',
  stopped: 'border border-status-stopped/30 bg-status-stopped-soft text-status-stopped',
};
/* A toggle that is on: also in place of the variant's colours. */
const PRESSED = 'bg-accent-soft text-accent-text';

/** The icon (or an Add's `Plus` with the kind it adds), hidden from a screen reader by
 *  its wrapper, so an SVG that ignores `aria-hidden` (the brand icons) is hidden too. */
function Glyph({ icon: Icon, kindIcon: KindIcon, size, pressed, spin = false }) {
  const iconSize = ICON_SIZE[size];
  return (
    <span aria-hidden className="inline-flex items-center">
      <Icon
        size={KindIcon ? Math.max(iconSize - 3, 10) : iconSize}
        fill={pressed ? 'currentColor' : 'none'}
        className={spin ? 'animate-spin' : undefined}
      />
      {KindIcon && <KindIcon size={iconSize} />}
    </span>
  );
}

/**
 * A link that only navigates, with an icon button's look (`variant`, `size`): named by
 * `label` on hover and to a screen reader. `to` is a route of the app; `href` is any
 * other address (a download, another site), with `download`, `target` and `rel` passed on.
 */
export function IconLink({ to, href, icon, kindIcon, label, variant = 'plain', size = 'md', className = '', ...rest }) {
  const props = {
    title: label,
    'aria-label': label,
    className: `${BASE} ${SIZE[size]} ${COLOURS[variant]}${className ? ` ${className}` : ''}`,
    ...rest,
  };
  const glyph = <Glyph icon={icon} kindIcon={kindIcon} size={size} />;
  return href !== undefined ? <a href={href} {...props}>{glyph}</a> : <Link to={to} {...props}>{glyph}</Link>;
}

/**
 * An icon-only button: `icon` (an Add pairs a `Plus` with the kind it adds, `kindIcon`),
 * named by `label` on hover and to a screen reader. A disabled action says why in
 * `reason`, shown in its place; `busy` while its command runs (a spinner, off).
 * `pressed` (true or false) makes it a toggle: while on, its icon is filled and it takes
 * the accent wash. `variant` plain | danger | positive | neutral | neutral-danger |
 * primary | field | bare; `size` xs | sm | md | lg; `tone` running | stopped; `badge` is
 * drawn at its corner; `children` replace the icon (the `bare` variant's content).
 * `title` overrides the hover text when it says more than the name.
 */
export default function IconButton({
  icon, kindIcon, label, reason, title, busy = false, pressed, variant = 'plain', size = 'md',
  tone, badge, disabled = false, type = 'button', className = '', children, ...rest
}) {
  const off = disabled || !!reason || busy;
  const name = reason ? `${label}: ${reason}` : label;
  const shape = SHAPE[variant] ?? SIZE[size];
  const colours = tone ? TONE[tone] : pressed ? PRESSED : COLOURS[variant];
  const content = busy
    ? <Glyph icon={Loader2} size={size} spin />
    : children ?? <Glyph icon={icon} kindIcon={kindIcon} size={size} pressed={pressed} />;
  return (
    <button
      type={type}
      disabled={off}
      title={reason ? name : title ?? label}
      aria-label={name}
      aria-pressed={pressed}
      className={`${BASE} ${shape} ${colours}${badge ? ' relative' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {content}
      {badge}
    </button>
  );
}
