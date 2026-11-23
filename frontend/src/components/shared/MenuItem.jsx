/**
 * One item of a popover menu or picker list: an icon (or any leading node), its label,
 * and an optional trailing node. `danger` for a destructive item; `current` for the
 * item that already is the state (muted, off); `accent` for an item that makes a new
 * one (its label turns accent on hover); `reason` turns it off and says why. `size` sm
 * (a picker's compact list) or md (a menu).
 */
export default function MenuItem({
  icon: Icon, lead, trail, label, onClick, reason, disabled = false, danger = false, current = false, accent = false,
  size = 'md', role = 'menuitem', ...rest
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
  return (
    <button
      type="button"
      role={role}
      disabled={disabled || current || !!reason}
      title={reason}
      onClick={onClick}
      className={`flex w-full items-center text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${current ? '' : 'disabled:opacity-40 '}${pad} ${tone}`}
      {...rest}
    >
      {Icon ? <Icon size={size === 'sm' ? 12 : 15} aria-hidden className={`shrink-0${iconTone}`} /> : lead}
      <span className={`min-w-0 flex-1${typeof label === 'string' ? ' truncate' : ''}`}>{label}</span>
      {trail}
    </button>
  );
}
