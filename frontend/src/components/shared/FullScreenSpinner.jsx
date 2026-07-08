import { Loader2 } from 'lucide-react';

/** Centered spinner for full-page gates (login SSO check, boot probe). */
export default function FullScreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface">
      <Loader2 size={24} className="animate-spin text-text-muted" />
    </div>
  );
}
