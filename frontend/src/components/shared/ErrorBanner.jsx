import { RefreshCw, X } from 'lucide-react';

import { errorText } from '../../api/errors.js';

/**
 * The one way an error is shown inline: a tinted line with the error's text, a
 * dismiss when the error may be put away (`onDismiss`), and a Retry when asking again
 * may help (`onRetry`; `retrying` shows the retry on its way). `error` is an ApiError,
 * an Error or a text; a message of the view's own (with markup, e.g. a command to
 * run) is given as the children instead.
 */
export default function ErrorBanner({ error, prefix, onDismiss, onRetry, retrying = false, className = '', children }) {
  if (!error && !children) return null;
  const text = children ?? (typeof error === 'string' ? error : errorText(error));
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-md border border-status-stopped/30 bg-status-stopped-soft px-3 py-1.5 text-xs text-status-stopped ${className}`}
    >
      <span className="min-w-0 flex-1 break-words">{prefix ? <>{prefix}: {text}</> : text}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium hover:underline disabled:opacity-60 disabled:no-underline"
        >
          <RefreshCw size={12} className={retrying ? 'animate-spin' : ''} aria-hidden /> {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-sm p-2 lg:p-0.5 hover:bg-status-stopped/10 transition-colors duration-150"
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
