import { useNavigate } from 'react-router-dom';
import { SearchX } from 'lucide-react';

/**
 * The page of a workload that does not exist (docs/specs/UI.md, View Switching):
 * deleted elsewhere, or never there. It says so and offers the way back; it never
 * spins and never leaves on its own.
 */
export default function WorkloadGone({ what, name }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <SearchX size={28} className="text-text-muted" aria-hidden />
      <p className="text-sm font-medium text-text-primary">
        No {what} named <span className="font-mono">{name}</span>
      </p>
      <button
        type="button"
        onClick={() => navigate('/host/overview')}
        className="rounded-md border border-surface-border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface transition-colors duration-150"
      >
        Go to Host overview
      </button>
    </div>
  );
}
