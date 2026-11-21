import { useState, useCallback } from 'react';
import { Package, AlertCircle, RotateCcw, RefreshCw, Loader2 } from 'lucide-react';
import UpdateCard from './UpdateCard.jsx';
import UpdateDetailsModal from './UpdateDetailsModal.jsx';
import { useStatsStore } from '../../store/statsStore.js';
import { checkForUpdates, performUpgrade } from '../../api/host.js';
import { awaitJob } from '../../store/backgroundJobsStore.js';
import { errorText } from '../../api/errors.js';
import { formatRelativeTime } from '../../utils/formatters.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useBusyCommand } from '../../hooks/useBusyCommand.js';
import RecordGate from '../shared/RecordGate.jsx';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import RecordError from '../shared/RecordError.jsx';

function formatBytes(b) {
  if (!b || b <= 0) return null;
  if (b < 1000) return `${b} B`;
  if (b < 1_000_000) return `${(b / 1000).toFixed(1)} kB`;
  if (b < 1_000_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  return `${(b / 1_000_000_000).toFixed(2)} GB`;
}

/**
 * UPDATE_BUSY — apt held by another process, or our own in-flight op blocking
 * a different op type — arrives as a 409 or as a job's error. The UI treats
 * it as a soft "try again later" status, not a red error.
 */
function isBusyError(err) {
  return err?.code === 'UPDATE_BUSY';
}

const BUSY_MESSAGE = 'Another package manager operation is running on the host. Try again in a moment.';

/** Run the package check (or join the one running) and resolve with its result, `{ count }`, or
 *  with nothing when it was cancelled (cut at shutdown). */
async function runPackageCheck() {
  return awaitJob((await checkForUpdates()).jobId);
}

export default function OsUpdateSection({ onRequestRestart }) {
  const stats = useStatsStore((s) => s.data);
  const pendingUpdates = stats?.pendingUpdates ?? 0;
  const updatesLastChecked = stats?.updatesLastChecked ?? null;
  const updateOpInProgress = !!stats?.updateOperationInProgress;
  const rebootRequired = !!stats?.rebootRequired;
  const rebootReasons = stats?.rebootReasons ?? [];

  const [checking, setChecking] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [manualCount, setManualCount] = useState(null);
  const [updateError, setUpdateError] = useState(null);
  const [busyMessage, setBusyMessage] = useState(null);
  const [upgradeSuccess, setUpgradeSuccess] = useState(false);
  const [upgradeError, setUpgradeError] = useState(null);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [refreshingPackages, runRefresh] = useBusyCommand();
  const [refreshError, setRefreshError] = useState(null);

  const handleCheckUpdates = useCallback(async () => {
    setUpdateError(null);
    setBusyMessage(null);
    setUpgradeSuccess(false);
    setChecking(true);
    try {
      const result = await runPackageCheck();
      if (!result) return;
      setManualCount(result.count);
    } catch (err) {
      if (isBusyError(err)) {
        setBusyMessage(`${BUSY_MESSAGE} (${errorText(err)})`);
      } else {
        setUpdateError(errorText(err));
      }
    } finally {
      setChecking(false);
    }
  }, []);

  const handleUpgrade = useCallback(async () => {
    setUpgradeError(null);
    setBusyMessage(null);
    setUpgradeSuccess(false);
    setUpgrading(true);
    try {
      await awaitJob((await performUpgrade()).jobId);
      setUpgradeSuccess(true);
      setManualCount(0);
    } catch (err) {
      if (isBusyError(err)) {
        setBusyMessage(`${BUSY_MESSAGE} (${errorText(err)})`);
      } else {
        setUpgradeError(errorText(err));
      }
    } finally {
      setUpgrading(false);
    }
  }, []);

  const openDetails = useCallback(() => {
    setRefreshError(null);
    setDetailsOpen(true);
  }, []);

  /* Run the check: the list is read again when the stats say the check ran. */
  const handleRefreshPackages = useCallback(() => {
    setRefreshError(null);
    runRefresh(async () => {
      try {
        await runPackageCheck();
      } catch (err) {
        setRefreshError(isBusyError(err) ? BUSY_MESSAGE : errorText(err));
      }
    });
  }, [runRefresh]);

  const count = manualCount ?? (pendingUpdates > 0 ? pendingUpdates : 0);
  const available = count > 0;

  /* Status precedence: error > busy > success > pending count > up-to-date.
   * Busy is rendered with the warn style (amber) — informational, not red. */
  let status = null;
  if (upgradeError) {
    status = { type: 'error', message: upgradeError };
  } else if (updateError) {
    status = { type: 'error', message: updateError };
  } else if (busyMessage) {
    status = { type: 'warn', message: busyMessage };
  } else if (upgradeSuccess) {
    status = { type: 'success', message: 'Upgrade completed successfully.' };
  } else if (!checking) {
    if (count > 0) {
      const fromBackground = manualCount === null && pendingUpdates > 0;
      status = {
        type: 'warn',
        message: `${count} package${count !== 1 ? 's' : ''} can be upgraded`,
        suffix: fromBackground ? '(background)' : undefined,
      };
    } else if (updatesLastChecked) {
      status = { type: 'success', message: 'Up to date' };
    }
  }

  const description = 'Install pending OS package updates.';

  return (
    <>
      <UpdateCard
        title="OS Update"
        titleIcon={<Package size={14} strokeWidth={2} />}
        description={description}
        available={available}
        count={count > 0 ? count : null}
        onCheck={handleCheckUpdates}
        onUpdate={handleUpgrade}
        checking={checking || (updateOpInProgress && !upgrading)}
        updating={upgrading}
        updateBusyLabel="Upgrading…"
        details={available ? { label: 'View packages', onClick: openDetails } : null}
        status={status}
        lastChecked={updatesLastChecked}
        autoCheckLabel="Checked hourly"
      >
        {rebootRequired && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning-soft px-2.5 py-1.5 text-xs text-status-warning">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">Reboot required to finish previous upgrade</span>
                {onRequestRestart && (
                  <button
                    type="button"
                    onClick={onRequestRestart}
                    className="inline-flex items-center gap-1 rounded-md border border-status-warning/30 bg-surface-card px-2 py-0.5 text-[11px] font-medium text-status-warning hover:bg-status-warning-soft transition-colors duration-150"
                  >
                    <RotateCcw size={11} />
                    Restart now
                  </button>
                )}
              </div>
              {rebootReasons.length > 0 && (
                <div className="mt-0.5 wrap-break-word text-status-warning/90">
                  {rebootReasons.slice(0, 6).join(', ')}
                  {rebootReasons.length > 6 && ` +${rebootReasons.length - 6} more`}
                </div>
              )}
            </div>
          </div>
        )}
      </UpdateCard>

      {detailsOpen && (
        <PackagesDialog
          onClose={() => setDetailsOpen(false)}
          onRefresh={handleRefreshPackages}
          refreshing={refreshingPackages}
          refreshError={refreshError}
        />
      )}
    </>
  );
}

/** The upgradable packages, as the last check found them: read while this dialog is
 *  open, and again whenever a check ran (the stats say when). */
function PackagesDialog({ onClose, onRefresh, refreshing, refreshError }) {
  const record = useRecord(RECORD.OS_UPDATE_PACKAGES);
  const data = record.data;
  const packages = data?.packages ?? null;

  /* The subtitle: package count + size, and when the check the list comes from ran,
   * so the user knows when to refresh. */
  let subtitle = null;
  if (packages != null) {
    const parts = [`${packages.length} package${packages.length !== 1 ? 's' : ''}`];
    if (data.downloadBytes > 0) parts.push(`${formatBytes(data.downloadBytes)} to download`);
    parts.push(data.checkedAt ? `checked ${formatRelativeTime(data.checkedAt)}` : 'not checked yet');
    subtitle = parts.join(' · ');
  }

  return (
    <UpdateDetailsModal
      open
      title="Upgradable packages"
      subtitle={subtitle}
      onClose={onClose}
      headerAction={
        packages != null && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh package list"
            aria-label="Refresh package list"
            className="rounded-md border border-surface-border bg-surface-card p-1.5 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-50"
          >
            {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        )
      }
    >
      <ErrorBanner className="mb-2" error={refreshError} />
      {record.data != null && <RecordError record={record} what="package list" className="mb-2" />}
      <RecordGate record={record} what="package list">
        {(found) => (found.packages.length === 0 ? (
          <p className="text-xs text-text-muted">No upgradable packages.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-card text-left text-text-muted">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Package</th>
                <th className="py-1.5 pr-3 font-medium">From</th>
                <th className="py-1.5 font-medium">To</th>
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              {found.packages.map((p) => (
                <tr key={p.name} className="border-t border-surface-border">
                  <td className="py-1 pr-3 font-mono text-text-primary">{p.name}</td>
                  <td className="py-1 pr-3 font-mono text-text-muted">{p.from || '—'}</td>
                  <td className="py-1 font-mono">{p.to}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </RecordGate>
    </UpdateDetailsModal>
  );
}
