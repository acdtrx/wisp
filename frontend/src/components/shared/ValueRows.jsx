/**
 * A group's values as text: a label and its value per row (`rows`: `{ label, value,
 * mono? }`; a row with a null value is left out).
 */
export default function ValueRows({ rows }) {
  const shown = rows.filter((r) => r.value != null && r.value !== false);
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-4 gap-y-1.5 py-1 text-sm sm:grid-cols-[9rem_1fr]">
      {shown.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-text-muted">{r.label}</dt>
          <dd className={`min-w-0 break-words text-text-primary ${r.mono ? 'font-mono text-[13px]' : ''}`}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
