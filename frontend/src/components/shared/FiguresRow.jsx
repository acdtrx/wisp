/**
 * A running workload's figures in a row of cells (`facts`, then `meters`:
 * `{ label, value, mono?, percent?, wide? }`, a `percent` drawing a small bar under the
 * value). From `sm` each cell has a fixed width, so a changing number moves nothing; a
 * `wide` cell is for a value as long as two amounts. On a phone the two sets are two
 * centred rows whose cells take their value's width and wrap, so no figure is cut.
 * Only a name, which has no longest value, is cut, its whole text on hover.
 * Not running, the row is `stoppedText` alone.
 */
export default function FiguresRow({ facts = [], meters = [], stoppedText }) {
  if (stoppedText) {
    return <p className="px-0.5 text-center text-sm text-text-muted sm:text-left">{stoppedText}</p>;
  }
  return (
    <dl className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-y-3">
      <Cells cells={facts} />
      <Cells cells={meters} />
    </dl>
  );
}

function Cells({ cells }) {
  if (cells.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-center gap-x-6 gap-y-3 text-center sm:flex-nowrap sm:justify-start sm:gap-0 sm:text-left">
      {cells.map((c) => (
        <div key={c.label} className={`min-w-0 max-w-full px-0.5 sm:shrink-0 ${c.wide ? 'sm:w-[12.5rem]' : 'sm:w-[9.25rem]'}`}>
          <dt className="text-xs text-text-muted">{c.label}</dt>
          <dd className={`truncate font-semibold tabular-nums text-text-primary ${c.mono ? 'font-mono text-[13px]' : 'text-sm'}`} title={typeof c.value === 'string' ? c.value : undefined}>
            {c.value}
          </dd>
          {c.percent != null && (
            <div className="mx-auto mt-1 h-1.5 w-16 overflow-hidden rounded-full bg-surface-border sm:mx-0" aria-hidden>
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, c.percent))}%` }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
