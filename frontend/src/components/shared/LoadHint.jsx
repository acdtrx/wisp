/**
 * A muted inline note that a supporting lookup failed and the control beside
 * it works from a fallback (an empty list, Local only, …).
 */
export default function LoadHint({ what, className = '' }) {
  return (
    <p className={`text-[11px] text-text-muted ${className}`} role="status">
      Couldn't load {what}.
    </p>
  );
}
