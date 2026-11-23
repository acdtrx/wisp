import { RefreshCw, X } from 'lucide-react';

import { errorText } from '../../api/errors.js';
import Button from './Button.jsx';
import IconButton from './IconButton.jsx';

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
        <Button variant="link" size="xs" icon={RefreshCw} busy={retrying} onClick={onRetry}>
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      )}
      {onDismiss && (
        <IconButton icon={X} label="Dismiss" variant="danger" size="xs" onClick={onDismiss} />
      )}
    </div>
  );
}
