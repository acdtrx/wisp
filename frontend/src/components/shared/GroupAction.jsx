import { Loader2 } from 'lucide-react';

const BASE = 'inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed h-9 min-w-9 px-2 lg:h-8 lg:min-w-8 lg:px-1.5';

const VARIANT = {
  plain: 'text-text-muted hoverable:hover:bg-accent-soft hoverable:hover:text-accent-text disabled:hover:bg-transparent',
  danger: 'text-text-muted hoverable:hover:bg-status-stopped-soft hoverable:hover:text-status-stopped disabled:hover:bg-transparent',
  add: 'bg-accent text-white hoverable:hover:bg-accent-hover',
};

/**
 * An action of a group or of one of its rows: an icon (an Add pairs a `Plus` with the
 * kind it adds, `kindIcon`), named by `label` on hover and to a screen reader. A
 * disabled action says why in `reason`, shown in its place; `busy` while its command
 * runs.
 */
export default function GroupAction({
  icon: Icon, kindIcon: KindIcon, label, onClick, disabled = false, reason, busy = false, variant = 'plain',
}) {
  const off = disabled || !!reason || busy;
  const name = reason ? `${label}: ${reason}` : label;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      title={name}
      aria-label={name}
      className={`${BASE} ${VARIANT[variant]}`}
    >
      {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : (
        <span className="inline-flex items-center">
          <Icon size={KindIcon ? 12 : 15} aria-hidden />
          {KindIcon && <KindIcon size={15} aria-hidden />}
        </span>
      )}
    </button>
  );
}
