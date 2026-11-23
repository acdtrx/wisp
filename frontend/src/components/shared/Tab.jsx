import { Link } from 'react-router-dom';

/**
 * One tab of a page's tab row: a link to the tab's own URL (the URL is the active
 * tab, docs/ARCHITECTURE.md, The client), underlined while `active`. `dot` puts a
 * warning dot before the label, its `dotTitle` saying why. `from="lg"` shows the tab
 * only from that breakpoint.
 */
const FROM = { lg: 'hidden lg:flex' };

export default function Tab({ to, active, dot, dotTitle, from, children, ...rest }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`${from ? FROM[from] : 'flex'} shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        active ? 'border-accent font-semibold text-accent-text' : 'border-transparent text-text-muted hoverable:hover:text-text-primary'
      }`}
      {...rest}
    >
      {/* Dot before the label so a partially scrolled tab clips its text, not the dot. */}
      {dot && <span className="flex h-2 w-2 shrink-0 rounded-full bg-status-warning" title={dotTitle} />}
      <span>{children}</span>
    </Link>
  );
}
