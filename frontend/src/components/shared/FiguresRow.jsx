/** A percent's usual range; "100.0%" grows its slot. */
export const PERCENT_SLOT = '99.9%';

/**
 * A running workload's figures, in one row (docs/specs/UI-VM.md and UI-CONTAINER.md,
 * Figures). No line break and no label's position depends on a live value.
 *
 * `identity`, what does not move, is one line without labels, a middle dot between its
 * items, `{ label, value, mono?, keep?, prefix? }`: `label` its accessible name, `prefix`
 * a word before the value ("up"). An item without a value is left out with its dot. The
 * items that are not `keep` come first and share one run that is cut at its end when the
 * line is full: the last of them (the name) gives way first, then the one before (the
 * address), each with its whole text as its title; a `keep` item (the uptime) is never cut.
 *
 * `live`, what moves, follows: `{ label, value, slot, unit?, percent?, phone? }`, a
 * small label before each value. The value sits at the end of a slot as wide as
 * `slot`, the widest text of its usual range, so a change of digits moves nothing and the
 * value stays by its unit and meter; a longer value grows the slot and is never cut.
 * `unit` is written small after it, and `percent` draws a meter beside it. `phone`, a
 * shorter `{ value, slot }`, takes the value's place below `sm`; the form not shown is
 * not displayed, so a screen reader hears only the one seen.
 *
 * On a desktop the two share one row that never wraps: the live figures keep their width
 * at the right, the identity line takes what is left. On a phone they are two lines, the
 * live figures under a hairline, spread across it; there a meter takes only the room the
 * line has left, down to none, and the line wraps only when its words alone do not fit.
 * Not running, the row is `stoppedText` alone.
 */
export default function FiguresRow({ identity = [], live = [], stoppedText }) {
  if (stoppedText) {
    return <p className="px-0.5 text-center text-sm text-text-muted sm:text-left">{stoppedText}</p>;
  }
  const known = identity.filter((item) => item.value);
  const cut = known.filter((item) => !item.keep);
  const kept = known.filter((item) => item.keep);
  const figures = live.filter((f) => f.value != null);
  return (
    <div className="flex flex-col gap-2 px-0.5 sm:flex-row sm:items-baseline sm:gap-6">
      {known.length > 0 && (
        <p className="flex min-w-0 items-baseline whitespace-nowrap text-[13.5px] text-text-secondary sm:flex-1">
          {cut.length > 0 && (
            <span className="min-w-0 truncate">
              {cut.map((item, i) => (
                <span key={item.label}>
                  {i > 0 && <Dot />}
                  <IdentityValue item={item} title />
                </span>
              ))}
            </span>
          )}
          {kept.map((item, i) => (
            <span key={item.label} className="shrink-0">
              {(cut.length > 0 || i > 0) && <Dot />}
              <IdentityValue item={item} />
            </span>
          ))}
        </p>
      )}
      {figures.length > 0 && (
        <dl className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 whitespace-nowrap border-t border-surface-border pt-2 sm:shrink-0 sm:flex-nowrap sm:gap-x-5 sm:border-0 sm:pt-0">
          {figures.map((f, i) => (
            <div
              key={f.label}
              className={`flex grow basis-[min-content] items-baseline gap-1.5 sm:grow-0 sm:basis-auto ${i > 0 ? 'justify-end sm:justify-start' : ''}`}
            >
              <dt className="text-xs text-text-muted">{f.label}</dt>
              <dd className={`flex items-baseline text-[13.5px] font-semibold tabular-nums text-text-primary sm:text-sm ${f.percent != null ? 'grow sm:grow-0' : ''}`}>
                <Slot slot={f.slot} value={f.value} className={f.phone ? 'hidden sm:inline-grid' : 'inline-grid'} />
                {f.phone && <Slot slot={f.phone.slot} value={f.phone.value} className="inline-grid sm:hidden" />}
                {f.unit && <span className="ml-1 text-[11px] font-medium text-text-muted">{f.unit}</span>}
                {f.percent != null && (
                  /* The space before the bar is the meter's own, so a meter given no
                     room leaves none. */
                  <span aria-hidden className="flex min-w-0 max-w-[46px] grow basis-0 self-center sm:w-[46px] sm:grow-0 sm:basis-auto">
                    <span className="ml-[min(6px,13%)] h-1.5 min-w-0 max-w-10 grow overflow-hidden rounded-full bg-surface-border">
                      <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, f.percent))}%` }} />
                    </span>
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** A value at the end of a slot as wide as `slot`'s text, which is never seen or read. */
function Slot({ slot, value, className }) {
  return (
    <span className={`${className} justify-items-end`}>
      <span aria-hidden className="invisible col-start-1 row-start-1">{slot}</span>
      <span className="col-start-1 row-start-1">{value}</span>
    </span>
  );
}

function Dot() {
  return <span aria-hidden className="mx-2 text-text-muted">·</span>;
}

function IdentityValue({ item, title = false }) {
  return (
    <span
      className={`tabular-nums ${item.mono ? 'font-mono text-[13px] font-semibold text-text-primary' : ''}`}
      title={title ? item.value : undefined}
    >
      <span className="sr-only">{item.label} </span>
      {item.prefix && <span aria-hidden>{item.prefix} </span>}
      {item.value}
    </span>
  );
}
