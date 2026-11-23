import { Loader2 } from 'lucide-react';

/** A tab's loading state: a spinner centred in the space the tab fills. */
export default function TabSpinner() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-text-muted" />
    </div>
  );
}
