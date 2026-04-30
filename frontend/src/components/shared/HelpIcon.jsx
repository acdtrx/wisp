import { HelpCircle } from 'lucide-react';

export default function HelpIcon({ text, size = 13, className = '' }) {
  if (!text) return null;
  return (
    <span
      tabIndex={0}
      role="img"
      aria-label={text}
      title={text}
      className={`inline-flex shrink-0 cursor-help text-text-muted hover:text-text-primary focus:text-text-primary focus:outline-none ${className}`}
    >
      <HelpCircle size={size} strokeWidth={2} aria-hidden />
    </span>
  );
}
