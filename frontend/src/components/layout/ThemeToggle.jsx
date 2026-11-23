import { Sun, Moon, Monitor } from 'lucide-react';

import { useThemeStore } from '../../store/themeStore.js';
import IconButton from '../shared/IconButton.jsx';

const MODES = {
  light: { Icon: Sun, label: 'Theme: light' },
  dark: { Icon: Moon, label: 'Theme: dark' },
  system: { Icon: Monitor, label: 'Theme: system (following OS)' },
};

/** Icon-only three-state theme control (FRONTEND-RULES.md, Design), cycling on tap. */
export default function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const cyclePreference = useThemeStore((s) => s.cyclePreference);

  const { Icon, label } = MODES[preference] ?? MODES.system;

  return (
    <IconButton icon={Icon} label={label} variant="neutral" size="lg" onClick={cyclePreference} />
  );
}
