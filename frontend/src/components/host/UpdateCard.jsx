import { Loader2, RefreshCw, ArrowUpCircle, AlertCircle, CheckCircle, Clock } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';

function formatRelativeTime(isoString) {
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

const BTN_BASE =
  'flex items-center gap-2 rounded-lg border border-surface-border bg-surface-card px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface transition-colors duration-150 disabled:opacity-50';

export default function UpdateCard({
  title,
  titleIcon,
  description,
  available = false,
  count = null,
  onCheck,
  onUpdate,
  checking = false,
  updating = false,
  updateBusyLabel = 'Updating…',
  details = null,
  status = null,
  lastChecked = null,
  autoCheckLabel = null,
  children = null,
}) {
  const lastCheckedLabel = formatRelativeTime(lastChecked);

  let updateLabel;
  if (updating) updateLabel = updateBusyLabel;
  else if (count != null && count > 1) updateLabel = `Update · ${count}`;
  else updateLabel = 'Update';

  const showFooter = status || lastCheckedLabel || autoCheckLabel;

  return (
    <SectionCard title={title} titleIcon={titleIcon}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 text-sm text-text-secondary">{description}</div>
        <div className="shrink-0 flex items-center gap-2">
          <button
            type="button"
            onClick={onCheck}
            disabled={checking || updating}
            className={BTN_BASE}
          >
            {checking ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {checking ? 'Checking…' : 'Check'}
          </button>
          <button
            type="button"
            onClick={onUpdate}
            disabled={!available || checking || updating}
            className={BTN_BASE}
          >
            {updating ? <Loader2 size={16} className="animate-spin" /> : <ArrowUpCircle size={16} />}
            {updateLabel}
          </button>
        </div>
      </div>

      {details && (
        <div className="mt-2">
          <button
            type="button"
            onClick={details.onClick}
            className="text-xs text-accent hover:underline"
          >
            {details.label}
          </button>
        </div>
      )}

      {children}

      {showFooter && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {status?.type === 'error' && (
            <>
              <AlertCircle size={13} className="shrink-0 text-status-stopped" />
              <span className="text-status-stopped">{status.message}</span>
            </>
          )}
          {status?.type === 'success' && (
            <>
              <CheckCircle size={13} className="shrink-0 text-status-running" />
              <span className="text-status-running">{status.message}</span>
            </>
          )}
          {status?.type === 'warn' && (
            <>
              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500" />
              <span className="text-amber-600">
                {status.message}
                {status.suffix && <span className="ml-1 text-text-muted">{status.suffix}</span>}
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-3 text-text-muted">
            {autoCheckLabel && <span className="hidden sm:inline">{autoCheckLabel}</span>}
            {lastCheckedLabel && (
              <span className="flex items-center gap-1">
                <Clock size={11} className="shrink-0" />
                {lastCheckedLabel}
              </span>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
