import { Lock } from 'lucide-react';

/**
 * One group of a workload's settings (docs/specs/UI-CONTAINER.md, The page): a title,
 * its values as text, its actions as icons on the right of the title. `lockReason`
 * puts a small lock by the title that says why the group's Edit and Add are off.
 */
export default function GroupCard({ title, lockReason, actions, children }) {
  return (
    <section className="rounded-card border border-surface-border bg-surface-card shadow-card">
      <header className="flex min-h-11 items-center gap-1 py-1.5 pl-4 pr-2">
        <h2 className="mr-auto flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          <span className="truncate">{title}</span>
          {lockReason && (
            <span className="inline-flex shrink-0" title={lockReason} aria-label={lockReason} role="img">
              <Lock size={11} aria-hidden />
            </span>
          )}
        </h2>
        {actions}
      </header>
      <div className="px-4 pb-3">{children}</div>
    </section>
  );
}
