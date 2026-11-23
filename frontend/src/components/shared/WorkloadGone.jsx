import { SearchX } from 'lucide-react';

import { ButtonLink } from './Button.jsx';

/**
 * The page of a workload that does not exist (docs/specs/UI.md, View Switching):
 * deleted elsewhere, or never there. It says so and offers the way back; it never
 * spins and never leaves on its own.
 */
export default function WorkloadGone({ what, name }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <SearchX size={28} className="text-text-muted" aria-hidden />
      <p className="text-sm font-medium text-text-primary">
        No {what} named <span className="font-mono">{name}</span>
      </p>
      <ButtonLink to="/host/overview">Go to Host overview</ButtonLink>
    </div>
  );
}
