import { Sun, Moon, Monitor } from 'lucide-react';

import { useThemeStore } from '../../store/themeStore.js';

const MODES = {
  light: { Icon: Sun, label: 'Theme: light' },
  dark: { Icon: Moon, label: 'Theme: dark' },
  system: { Icon: Monitor, label: 'Theme: system (following OS)' },
};

/** Icon-only three-state theme control (CODING-RULES §8), cycling on tap. */
export default function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const cyclePreference = useThemeStore((s) => s.cyclePreference);

  const { Icon, label } = MODES[preference] ?? MODES.system;

  return (
    <button
      type="button"
      onClick={cyclePreference}
      className="flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
      title={label}
      aria-label={label}
    >
      <Icon size={18} aria-hidden />
    </button>
  );
}
