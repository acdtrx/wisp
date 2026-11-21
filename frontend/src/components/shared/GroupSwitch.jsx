import { Loader2 } from 'lucide-react';

import Toggle from './Toggle.jsx';

/**
 * A switch in a group: it acts at once (`onChange` runs the command). `busy` while
 * that command runs; a switch that cannot act says why in `reason`.
 */
export default function GroupSwitch({ label, hint, checked, onChange, busy = false, reason }) {
  return (
    <div className="flex items-center gap-3 border-t border-surface-border py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-text-primary">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-text-muted">{hint}</div>}
      </div>
      {busy && <Loader2 size={14} className="animate-spin text-text-muted" aria-hidden />}
      <Toggle
        checked={checked}
        onChange={onChange}
        disabled={busy || !!reason}
        label={label}
        title={reason}
      />
    </div>
  );
}
