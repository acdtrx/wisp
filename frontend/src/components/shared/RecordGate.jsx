import { Loader2 } from 'lucide-react';

import RecordError from './RecordError.jsx';

/**
 * A view's states before its record has data (`useRecord`): a loading line until it
 * first answers, its failure with a Retry, "gone"; then the children. A form never
 * renders before its record, so a Save cannot write defaults back. The error of a
 * later read, over data shown, is the view's to place (`RecordError`).
 *
 * @param {{ record: ReturnType<import('../../hooks/useRecord.js').useRecord>, what: string,
 *   loading?: import('react').ReactNode, children: (data: any) => import('react').ReactNode }} props
 */
export default function RecordGate({ record, what, loading, children }) {
  if (record.status === 'idle') return null;
  if (record.data != null) return children(record.data);
  if (record.status === 'error') return <RecordError record={record} what={what} />;
  if (record.status === 'gone') return <p className="text-xs text-text-muted">No {what}.</p>;
  return loading ?? (
    <p className="flex items-center gap-2 text-xs text-text-muted">
      <Loader2 size={14} className="animate-spin" aria-hidden /> Loading {what}…
    </p>
  );
}
