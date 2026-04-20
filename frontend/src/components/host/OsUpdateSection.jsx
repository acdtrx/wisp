import { useState, useCallback } from 'react';
import { Loader2, RefreshCw, ArrowUpCircle, Package, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import { useStatsStore } from '../../store/statsStore.js';
import { checkForUpdates, performUpgrade } from '../../api/host.js';

function formatRelativeTime(isoString) {
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export default function OsUpdateSection() {
  const stats = useStatsStore((s) => s.stats);
  const pendingUpdates = stats?.pendingUpdates ?? 0;
  const updatesLastChecked = stats?.updatesLastChecked ?? null;
  const rebootRequired = !!stats?.rebootRequired;
  const rebootReasons = stats?.rebootReasons ?? [];

  const [checking, setChecking] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [manualCount, setManualCount] = useState(null);
  const [updateError, setUpdateError] = useState(null);
  const [upgradeSuccess, setUpgradeSuccess] = useState(false);
  const [upgradeError, setUpgradeError] = useState(null);

  const handleCheckUpdates = useCallback(async () => {
    setUpdateError(null);
    setUpgradeSuccess(false);
    setManualCount(null);
    setChecking(true);
    try {
      const data = await checkForUpdates();
      setManualCount(data.count ?? 0);
    } catch (err) {
      setUpdateError(err.detail || err.message || 'Update check failed');
    } finally {
      setChecking(false);
    }
  }, []);

  const handleUpgrade = useCallback(async () => {
    setUpgradeError(null);
    setUpgradeSuccess(false);
    setUpgrading(true);
    try {
      await performUpgrade();
      setUpgradeSuccess(true);
      setManualCount(0);
    } catch (err) {
      setUpgradeError(err.detail || err.message || 'Upgrade failed');
    } finally {
      setUpgrading(false);
    }
  }, []);

  let status = null;
  if (upgradeError) {
    status = { type: 'error', message: upgradeError };
  } else if (updateError) {
    status = { type: 'error', message: updateError };
  } else if (upgradeSuccess) {
    status = { type: 'success', message: 'Upgrade completed successfully.' };
  } else if (manualCount !== null && !checking) {
    if (manualCount === 0) {
      status = { type: 'success', message: 'System is up to date.' };
    } else {
      status = { type: 'warn', message: `${manualCount} package${manualCount !== 1 ? 's' : ''} can be upgraded.` };
    }
  } else if (pendingUpdates > 0 && manualCount === null) {
    status = {
      type: 'warn',
      message: `${pendingUpdates} package${pendingUpdates !== 1 ? 's' : ''} available`,
      suffix: '(background)',
    };
  }

  const lastCheckedLabel = formatRelativeTime(updatesLastChecked);

  return (
    <SectionCard title="OS Update" titleIcon={<Package size={14} strokeWidth={2} />}>
      <div className="flex items-center justify-between gap-4">
        <p className="flex-1 text-sm text-text-secondary">
          Apply available package updates to keep the host OS up to date.
        </p>
        <div className="shrink-0 flex items-center gap-2">
          <button
            type="button"
            onClick={handleCheckUpdates}
            disabled={checking || upgrading}
            className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface-card px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface transition-colors duration-150 disabled:opacity-50"
          >
            {checking ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {checking ? 'Checking…' : 'Check'}
          </button>
          <button
            type="button"
            onClick={handleUpgrade}
            disabled={checking || upgrading}
            className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface-card px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface transition-colors duration-150 disabled:opacity-50"
          >
            {upgrading ? <Loader2 size={16} className="animate-spin" /> : <ArrowUpCircle size={16} />}
            {upgrading ? 'Upgrading…' : 'Upgrade'}
          </button>
        </div>
      </div>

      {rebootRequired && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Reboot required</div>
            {rebootReasons.length > 0 && (
              <div className="mt-0.5 break-words text-amber-600/90">
                {rebootReasons.slice(0, 6).join(', ')}
                {rebootReasons.length > 6 && ` +${rebootReasons.length - 6} more`}
              </div>
            )}
          </div>
        </div>
      )}

      {(status || lastCheckedLabel) && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {status?.type === 'error' && (
            <>
              <AlertCircle size={13} className="shrink-0 text-status-stopped" />
              <span className="text-status-stopped">{status.message}</span>
            </>
          )}
          {status?.type === 'success' && (
            <>
              <CheckCircle size={13} className="shrink-0 text-status-running" />
              <span className="text-status-running">{status.message}</span>
            </>
          )}
          {status?.type === 'warn' && (
            <>
              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500" />
              <span className="text-amber-600">
                {status.message}
                {status.suffix && <span className="ml-1 text-text-muted">{status.suffix}</span>}
              </span>
            </>
          )}
          {lastCheckedLabel && (
            <span className={`flex items-center gap-1 text-text-muted${status ? ' ml-auto' : ''}`}>
              <Clock size={11} className="shrink-0" />
              {lastCheckedLabel}
            </span>
          )}
        </div>
      )}
    </SectionCard>
  );
}
