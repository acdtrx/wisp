import { useEffect, useState } from 'react';

/**
 * Countdown pill for a restart the container's restart policy has scheduled
 * (`scheduledRestart: { attempt, at }` from the container list / detail).
 * The one-second tick only re-renders the label; the badge disappears when
 * the list push clears `scheduledRestart`.
 */
export default function ScheduledRestartBadge({ scheduledRestart, className = '' }) {
  const at = scheduledRestart?.at ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (at == null) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [at]);

  if (at == null) return null;

  const seconds = Math.ceil((at - now) / 1000);
  const label = seconds > 0 ? `Restarting in ${seconds} s` : 'Restarting…';
  const attempt = scheduledRestart.attempt;
  const title = `The container exited; its restart policy restarts it${
    attempt > 1 ? ` (attempt ${attempt})` : ''
  }. Stop cancels the restart.`;

  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded-full bg-status-warning-soft px-2 py-0.5 text-[10px] font-medium text-status-warning ${className}`}
      title={title}
    >
      {label}
    </span>
  );
}
