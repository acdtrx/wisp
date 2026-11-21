/**
 * One row of a group's list: what it is (`title`, and `detail` under it) and its
 * actions as icons, always visible. Rows are separated by a rule.
 */
export default function GroupItem({ title, detail, mono = false, actions }) {
  return (
    <div className="flex items-center gap-3 border-t border-surface-border py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className={`break-words font-medium text-text-primary ${mono ? 'font-mono text-[13px]' : 'text-sm'}`}>{title}</div>
        {detail && <div className="mt-0.5 break-words text-xs text-text-muted">{detail}</div>}
      </div>
      {actions && <div className="-mr-1 flex shrink-0 flex-wrap items-center justify-end">{actions}</div>}
    </div>
  );
}
