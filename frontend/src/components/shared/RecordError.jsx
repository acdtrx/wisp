import ErrorBanner from './ErrorBanner.jsx';

/**
 * A record's read error, as every view shows it (docs/FRONTEND-RULES.md, Errors): with
 * no data shown, it is the view's error state, with a Retry; over data already shown,
 * the data stays and the error can be dismissed. It goes when a read succeeds.
 *
 * @param {{ record: ReturnType<import('../../hooks/useRecord.js').useRecord>, what: string, className?: string }} props
 */
export default function RecordError({ record, what, className }) {
  if (!record.error) return null;
  const hasData = record.data != null;
  return (
    <ErrorBanner
      className={className}
      error={record.error}
      prefix={hasData ? `Couldn't refresh the ${what}` : `Couldn't load the ${what}`}
      onRetry={hasData ? undefined : record.reload}
      onDismiss={hasData ? record.dismiss : undefined}
    />
  );
}
