/**
 * A running workload's figures, in one row (docs/specs/UI-VM.md and UI-CONTAINER.md,
 * Figures). `identity`, what does not move, is one line without labels, a middle dot
 * between its items: `{ label, value, mono?, name?, prefix? }`, `label` its accessible
 * name, `name` the one item that may be cut (its whole text on hover), `prefix` a word
 * shown before the value ("up"). An item without a value is left out with its dot.
 * `live`, what moves, follows with a label before each value: `{ label, value, unit?,
 * percent?, narrowMeter? }`, `unit` written small after the value, `percent` a meter
 * beside it (`narrowMeter` on a phone). On a desktop the two share one row, the live
 * figures at the right, and move to a second line when they do not fit; on a phone they
 * are two lines, the live figures spread under a hairline. Not running, the row is
 * `stoppedText` alone.
 */
export default function FiguresRow({ identity = [], live = [], stoppedText }) {
  if (stoppedText) {
    return <p className="px-0.5 text-center text-sm text-text-muted sm:text-left">{stoppedText}</p>;
  }
  const known = identity.filter((item) => item.value);
  const figures = live.filter((f) => f.value);
  return (
    <div className="flex flex-col gap-2 px-0.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-6">
      {known.length > 0 && (
        <p className="flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap text-[13.5px] text-text-secondary">
          {known.map((item, i) => (
            <span key={item.label} className={`flex items-baseline gap-2 ${item.name ? 'min-w-0' : 'shrink-0'}`}>
              {i > 0 && <span aria-hidden className="text-text-muted">·</span>}
              <span
                className={`tabular-nums ${item.name ? 'min-w-0 truncate' : ''} ${item.mono ? 'font-mono text-[13px] font-semibold text-text-primary' : ''}`}
                title={item.name ? item.value : undefined}
              >
                <span className="sr-only">{item.label} </span>
                {item.prefix && <span aria-hidden>{item.prefix} </span>}
                {item.value}
              </span>
            </span>
          ))}
        </p>
      )}
      {figures.length > 0 && (
        <dl className="flex flex-wrap items-baseline justify-between gap-x-2.5 gap-y-1.5 whitespace-nowrap border-t border-surface-border pt-2 sm:shrink-0 sm:flex-nowrap sm:justify-start sm:gap-5 sm:border-0 sm:pt-0">
          {figures.map((f) => (
            <div key={f.label} className="flex items-baseline gap-1.5">
              <dt className="text-xs text-text-muted">{f.label}</dt>
              <dd className="text-[13.5px] font-semibold tabular-nums text-text-primary sm:text-sm">
                {f.value}
                {f.unit && <span className="ml-1 text-[11px] font-medium text-text-muted">{f.unit}</span>}
              </dd>
              {f.percent != null && (
                <span
                  aria-hidden
                  className={`h-1.5 self-center overflow-hidden rounded-full bg-surface-border sm:w-10 ${f.narrowMeter ? 'w-7' : 'w-10'}`}
                >
                  <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, f.percent))}%` }} />
                </span>
              )}
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
