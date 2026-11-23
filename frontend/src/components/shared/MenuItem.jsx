/**
 * One item of a popover menu or picker list: an icon, its label, and an optional
 * trailing node. A menu gives its items `role="menuitem"`; a picker list gives none. `danger` for a destructive item; `current` for the
 * item that already is the state (muted, off); `accent` for an item that makes a new
 * one (its label turns accent on hover); `reason` turns it off and says why. `size` sm
 * (a picker's compact list) or md (a menu). `href` makes it a link to that address (its
 * `target` and `rel` passed on): it navigates and is never off.
 */
export default function MenuItem({
  icon: Icon, trail, label, onClick, reason, disabled = false, danger = false, current = false, accent = false,
  size = 'md', href, ...rest
}) {
  const pad = size === 'sm' ? 'gap-2 px-3 py-1.5 text-xs' : 'gap-2.5 px-3 py-2.5 text-sm lg:py-2';
  const tone = danger
    ? 'text-status-stopped hoverable:hover:bg-status-stopped-soft'
    : current
      ? 'text-text-muted'
      : accent
        ? 'text-text-secondary hoverable:hover:bg-surface hoverable:hover:text-accent-text'
        : 'text-text-primary hoverable:hover:bg-surface';
  const iconTone = danger || accent || size === 'sm' ? '' : ' text-text-secondary';
  const look = `flex w-full items-center text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${pad} ${tone}`;
  const content = (
    <>
      {/* Hidden by its wrapper, so an SVG that ignores aria-hidden is hidden too. */}
      {Icon && (
        <span aria-hidden className={`inline-flex shrink-0${iconTone}`}>
          <Icon size={size === 'sm' ? 12 : 15} />
        </span>
      )}
      <span className={`min-w-0 flex-1${typeof label === 'string' ? ' truncate' : ''}`}>{label}</span>
      {trail}
    </>
  );
  if (href !== undefined) {
    return <a href={href} onClick={onClick} className={look} {...rest}>{content}</a>;
  }
  return (
    <button
      type="button"
      disabled={disabled || current || !!reason}
      title={reason}
      onClick={onClick}
      className={`${look} disabled:cursor-not-allowed ${current ? '' : 'disabled:opacity-40'}`}
      {...rest}
    >
      {content}
    </button>
  );
}
