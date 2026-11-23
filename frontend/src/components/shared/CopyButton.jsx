import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

import IconButton from './IconButton.jsx';

const SHOWN_MS = 1500;

/**
 * Copies `text` to the clipboard: for a moment it shows a Check in the running tone and
 * says "Copied". A browser that refuses the clipboard (an insecure context) copies
 * nothing and says nothing: the text beside it is selectable. The feedback belongs to
 * the text copied, so a new text shows the Copy icon again. `variant` and `size` are
 * IconButton's; `className` places it.
 */
export default function CopyButton({ text, label, variant = 'plain', size = 'sm', className }) {
  const [copiedText, setCopiedText] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // clipboard refused (an insecure context): the text is selectable instead
    }
    setCopiedText(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopiedText(null), SHOWN_MS);
  };

  const copied = copiedText !== null && copiedText === text;
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={copied ? 'Copied' : label}
      variant={variant}
      size={size}
      tone={copied ? 'running' : undefined}
      className={className}
      onClick={copy}
    />
  );
}
