import { Lock } from 'lucide-react';

import CommandErrors from './CommandErrors.jsx';
import HelpIcon from './HelpIcon.jsx';

/**
 * The one card a page's content sits in (docs/FRONTEND-RULES.md, Cards): a title,
 * with an optional icon and help, and the card's actions (`actions`) at the right of
 * its header. `lockReason` puts a small lock by the title that says why the card's
 * Edit and Add are off. The card's errors (its command hooks', `commands`), one
 * banner per failed key, show below the header, each dismissed on its own.
 */
export default function Card({
  title,
  icon,
  help,
  lockReason,
  actions,
  commands = [],
  errorPrefix,
  showsError,
  children,
}) {
  return (
    <section className="rounded-card border border-surface-border bg-surface-card shadow-card">
      <header className="flex min-h-11 items-center gap-1 py-1.5 pl-4 pr-2">
        <h2 className="mr-auto flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {icon && (
            <span className="inline-flex shrink-0" aria-hidden>
              {icon}
            </span>
          )}
          <span className="truncate">{title}</span>
          {help && <HelpIcon text={help} />}
          {lockReason && (
            <span className="inline-flex shrink-0" title={lockReason} aria-label={lockReason} role="img">
              <Lock size={11} aria-hidden />
            </span>
          )}
        </h2>
        {actions}
      </header>
      <CommandErrors className="mx-4 mb-2" commands={commands} prefix={errorPrefix} shows={showsError} />
      <div className="px-4 pb-3">{children}</div>
    </section>
  );
}
