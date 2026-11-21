/**
 * A running workload's figures in a row of cells of fixed width, so a changing number
 * moves nothing (`facts`, then `meters`: `{ label, value, mono?, percent? }`, a
 * `percent` drawing a small bar). On a phone the two sets are two centred rows.
 * Not running, the row is `stoppedText` alone.
 */
export default function FiguresRow({ facts = [], meters = [], stoppedText }) {
  if (stoppedText) {
    return <p className="px-0.5 text-center text-sm text-text-muted sm:text-left">{stoppedText}</p>;
  }
  return (
    <dl className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-0">
      <Cells cells={facts} />
      <Cells cells={meters} />
    </dl>
  );
}

function Cells({ cells }) {
  if (cells.length === 0) return null;
  return (
    <div className="grid grid-flow-col auto-cols-fr text-center sm:auto-cols-[9.25rem] sm:text-left">
      {cells.map((c) => (
        <div key={c.label} className="min-w-0 px-0.5">
          <dt className="text-xs text-text-muted">{c.label}</dt>
          <dd className={`truncate font-semibold tabular-nums text-text-primary ${c.mono ? 'font-mono text-[13px]' : 'text-sm'}`} title={typeof c.value === 'string' ? c.value : undefined}>
            {c.value}
            {c.percent != null && (
              <span className="ml-1.5 inline-block h-1.5 w-10 overflow-hidden rounded-full bg-surface-border align-middle" aria-hidden>
                <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, c.percent))}%` }} />
              </span>
            )}
          </dd>
        </div>
      ))}
    </div>
  );
}
