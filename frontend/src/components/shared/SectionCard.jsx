import { ChevronDown, ChevronRight, Lock, Loader2, Save } from 'lucide-react';
import HelpIcon from './HelpIcon.jsx';

export default function SectionCard({
  title,
  titleIcon,
  helpText,
  children,
  onSave,
  saving,
  isDirty,
  requiresRestart,
  collapsible,
  collapsed,
  onToggleCollapse,
  locked,
  lockedMessage,
  error,
  headerAction,
}) {
  return (
    <div className="rounded-card border border-surface-border bg-surface-card">
      <div
        className={`flex items-center justify-between px-5 py-3 ${collapsible ? 'cursor-pointer select-none' : ''}`}
        onClick={collapsible ? onToggleCollapse : undefined}
      >
        <div className="flex items-center gap-2">
          {collapsible && (
            collapsed
              ? <ChevronRight size={14} className="text-text-muted" />
              : <ChevronDown size={14} className="text-text-muted" />
          )}
          {titleIcon && (
            <span className="inline-flex shrink-0 text-text-muted" aria-hidden>
              {titleIcon}
            </span>
          )}
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {title}
          </h3>
          {helpText && <HelpIcon text={helpText} />}
          {locked && (
            <span className="flex items-center gap-1 text-[10px] text-text-muted">
              <Lock size={11} />
              {lockedMessage || 'Offline only'}
            </span>
          )}
        </div>

        <div
          className="flex items-center gap-2"
          onClick={collapsible ? (e) => e.stopPropagation() : undefined}
        >
          {requiresRestart && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-status-warning">
              Restart required
            </span>
          )}
          {isDirty && onSave && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSave(); }}
              disabled={saving}
              className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors duration-150"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save
            </button>
          )}
          {headerAction}
        </div>
      </div>

      {error && (
        <div className="mx-5 mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-status-stopped">
          {error}
        </div>
      )}

      {(!collapsible || !collapsed) && (
        <div className="border-t border-surface-border px-5 py-4">
          {children}
        </div>
      )}
    </div>
  );
}
