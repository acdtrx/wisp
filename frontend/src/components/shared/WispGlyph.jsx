import { useId } from 'react';

/**
 * The Wisp brand glyph — lucide's Wind strokes with the identity gradient
 * (accent teal → bright cyan). The cyan endpoint is a brand constant that
 * exists only here; everything else derives from the accent token.
 */
export default function WispGlyph({ size = 22, className = '' }) {
  const id = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={`url(#${id})`}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <defs>
        <linearGradient id={id} x1="2" y1="4" x2="22" y2="20" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: 'var(--color-accent)' }} />
          <stop offset="1" stopColor="#3ec3d5" />
        </linearGradient>
      </defs>
      <path d="M12.8 19.6A2 2 0 1 0 14 16H2" />
      <path d="M17.5 8a2.5 2.5 0 1 1 2 4H2" />
      <path d="M9.8 4.4A2 2 0 1 1 11 8H2" />
    </svg>
  );
}
