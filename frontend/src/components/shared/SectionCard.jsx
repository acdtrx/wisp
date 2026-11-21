import HelpIcon from './HelpIcon.jsx';
import CommandErrors from './CommandErrors.jsx';

/**
 * A card of a Host page (docs/specs/UI.md, SectionCard), the same look as a workload
 * page's group (GroupCard): its title, with an optional icon and help, and its actions
 * (`headerAction`) on the right. A section's errors — its command hooks' (`commands`),
 * one banner per failed key — show below the header, each dismissed on its own.
 */
export default function SectionCard({
  title,
  titleIcon,
  helpText,
  children,
  commands = [],
  errorPrefix,
  showsError,
  headerAction,
}) {
  return (
    <section className="rounded-card border border-surface-border bg-surface-card shadow-card">
      <header className="flex min-h-11 items-center gap-1 py-1.5 pl-4 pr-2">
        <h2 className="mr-auto flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {titleIcon && (
            <span className="inline-flex shrink-0" aria-hidden>
              {titleIcon}
            </span>
          )}
          <span className="truncate">{title}</span>
          {helpText && <HelpIcon text={helpText} />}
        </h2>
        {headerAction}
      </header>
      <CommandErrors className="mx-4 mb-2" commands={commands} prefix={errorPrefix} shows={showsError} />
      <div className="px-4 pb-3">{children}</div>
    </section>
  );
}
