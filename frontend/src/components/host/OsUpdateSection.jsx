import { useState, useCallback } from 'react';
import { Package, AlertCircle, RotateCcw, RefreshCw, Loader2 } from 'lucide-react';
import UpdateCard from './UpdateCard.jsx';
import UpdateDetailsModal from './UpdateDetailsModal.jsx';
import { useStatsStore } from '../../store/statsStore.js';
import { checkForUpdates, performUpgrade, listUpgradablePackages } from '../../api/host.js';
import { JOB_KIND } from '../../api/jobs.js';
import { awaitJob, useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { errorText } from '../../api/errors.js';
import { formatRelativeTime } from '../../utils/formatters.js';

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

/** Run the package check (or join the one running) and resolve with its result, `{ count }`. */
async function runPackageCheck() {
  return awaitJob(useBackgroundJobsStore.getState().addJob({ ...await checkForUpdates(), kind: JOB_KIND.OS_UPDATE_CHECK }));
}

export default function OsUpdateSection({ onRequestRestart }) {
  const stats = useStatsStore((s) => s.stats);
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
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [packagesError, setPackagesError] = useState(null);
  const [packages, setPackages] = useState(null);
  const [downloadBytes, setDownloadBytes] = useState(0);
  const [packagesAt, setPackagesAt] = useState(null);

  const handleCheckUpdates = useCallback(async () => {
    setUpdateError(null);
    setBusyMessage(null);
    setUpgradeSuccess(false);
    setChecking(true);
    try {
      const { count: newCount } = await runPackageCheck();
      /* Invalidate the locally-rendered package list only if the count
       * actually changed — otherwise the cached list is still accurate and
       * the modal can keep opening instantly. The backend cache is updated
       * regardless (the same apt invocation produces both count + list). */
      if (manualCount != null && newCount !== manualCount) {
        setPackages(null);
        setPackagesError(null);
      }
      setManualCount(newCount);
    } catch (err) {
      if (isBusyError(err)) {
        setBusyMessage(`${BUSY_MESSAGE} (${errorText(err)})`);
      } else {
        setUpdateError(errorText(err));
      }
    } finally {
      setChecking(false);
    }
  }, [manualCount]);

  const handleUpgrade = useCallback(async () => {
    setUpgradeError(null);
    setBusyMessage(null);
    setUpgradeSuccess(false);
    setUpgrading(true);
    try {
      await awaitJob(useBackgroundJobsStore.getState().addJob({ ...await performUpgrade(), kind: JOB_KIND.OS_UPGRADE }));
      setUpgradeSuccess(true);
      setManualCount(0);
      setPackages([]);
      setDownloadBytes(0);
      setPackagesAt(null);
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

  const fetchPackages = useCallback(async ({ refresh = false } = {}) => {
    setPackagesError(null);
    setPackagesLoading(true);
    try {
      if (refresh) await runPackageCheck();
      const data = await listUpgradablePackages();
      setPackages(data.packages);
      setDownloadBytes(data.downloadBytes);
      setPackagesAt(data.checkedAt);
    } catch (err) {
      if (isBusyError(err)) {
        setPackagesError(BUSY_MESSAGE);
      } else {
        setPackagesError(errorText(err));
      }
    } finally {
      setPackagesLoading(false);
    }
  }, []);

  const openDetails = useCallback(() => {
    setDetailsOpen(true);
    /* Lazy-load on first open or after upgrade clears the list: the backend
     * answers with what the last check (hourly, or any trigger) found. */
    if (packages == null && !packagesLoading) fetchPackages();
  }, [packages, packagesLoading, fetchPackages]);

  const handleRefreshPackages = useCallback(() => {
    fetchPackages({ refresh: true });
  }, [fetchPackages]);

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

  /* Compose the modal subtitle: package count + size, and when the check
   * the list comes from ran, so the user knows when to refresh. */
  let modalSubtitle = null;
  if (packages != null) {
    const parts = [`${packages.length} package${packages.length !== 1 ? 's' : ''}`];
    if (downloadBytes > 0) parts.push(`${formatBytes(downloadBytes)} to download`);
    parts.push(packagesAt ? `checked ${formatRelativeTime(packagesAt)}` : 'not checked yet');
    modalSubtitle = parts.join(' · ');
  }

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

      <UpdateDetailsModal
        open={detailsOpen}
        title="Upgradable packages"
        subtitle={modalSubtitle}
        onClose={() => setDetailsOpen(false)}
        headerAction={
          packages != null && !packagesLoading && (
            <button
              type="button"
              onClick={handleRefreshPackages}
              disabled={packagesLoading}
              title="Refresh package list"
              aria-label="Refresh package list"
              className="rounded-md border border-surface-border bg-surface-card p-1.5 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-50"
            >
              {packagesLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            </button>
          )
        }
      >
        {packagesLoading && (
          <p className="text-xs text-text-muted">Loading…</p>
        )}
        {packagesError && (
          <p className="text-xs text-status-stopped">{packagesError}</p>
        )}
        {!packagesLoading && !packagesError && packages != null && packages.length === 0 && (
          <p className="text-xs text-text-muted">No upgradable packages.</p>
        )}
        {!packagesLoading && !packagesError && packages != null && packages.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-card text-left text-text-muted">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Package</th>
                <th className="py-1.5 pr-3 font-medium">From</th>
                <th className="py-1.5 font-medium">To</th>
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              {packages.map((p) => (
                <tr key={p.name} className="border-t border-surface-border">
                  <td className="py-1 pr-3 font-mono text-text-primary">{p.name}</td>
                  <td className="py-1 pr-3 font-mono text-text-muted">{p.from || '—'}</td>
                  <td className="py-1 font-mono">{p.to}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </UpdateDetailsModal>
    </>
  );
}
