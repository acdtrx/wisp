import { useState, useCallback } from 'react';
import { Package, AlertCircle, RotateCcw } from 'lucide-react';
import UpdateCard from './UpdateCard.jsx';
import UpdateDetailsModal from './UpdateDetailsModal.jsx';
import { useStatsStore } from '../../store/statsStore.js';
import { checkForUpdates, performUpgrade, listUpgradablePackages } from '../../api/host.js';

function formatBytes(b) {
  if (!b || b <= 0) return null;
  if (b < 1000) return `${b} B`;
  if (b < 1_000_000) return `${(b / 1000).toFixed(1)} kB`;
  if (b < 1_000_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  return `${(b / 1_000_000_000).toFixed(2)} GB`;
}

export default function OsUpdateSection({ onRequestRestart }) {
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

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [packagesError, setPackagesError] = useState(null);
  const [packages, setPackages] = useState(null);
  const [downloadBytes, setDownloadBytes] = useState(0);

  const handleCheckUpdates = useCallback(async () => {
    setUpdateError(null);
    setUpgradeSuccess(false);
    setManualCount(null);
    setChecking(true);
    /* Stale package list — reset so the modal refetches if reopened. */
    setPackages(null);
    setPackagesError(null);
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
      setPackages([]);
      setDownloadBytes(0);
    } catch (err) {
      setUpgradeError(err.detail || err.message || 'Upgrade failed');
    } finally {
      setUpgrading(false);
    }
  }, []);

  const fetchPackages = useCallback(async () => {
    setPackagesError(null);
    setPackagesLoading(true);
    try {
      const data = await listUpgradablePackages();
      setPackages(data.packages ?? []);
      setDownloadBytes(data.downloadBytes ?? 0);
    } catch (err) {
      setPackagesError(err.detail || err.message || 'Failed to load package list');
    } finally {
      setPackagesLoading(false);
    }
  }, []);

  const openDetails = useCallback(() => {
    setDetailsOpen(true);
    /* Lazy-load the first time, or after a fresh check / completed upgrade
     * (both of which clear `packages`). Fetching only on click avoids an
     * effect-driven retry loop when the request errors. */
    if (packages == null && !packagesLoading) fetchPackages();
  }, [packages, packagesLoading, fetchPackages]);

  const count = manualCount ?? (pendingUpdates > 0 ? pendingUpdates : 0);
  const available = count > 0;

  /* Derive status from `count` + `updatesLastChecked` (both backed by SSE so
   * they survive tab unmount) rather than from `manualCount` alone, which is
   * local state and would drop "Up to date" the moment the user navigates
   * away and back. */
  let status = null;
  if (upgradeError) {
    status = { type: 'error', message: upgradeError };
  } else if (updateError) {
    status = { type: 'error', message: updateError };
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

  const description = 'Apply available package updates to keep the host OS up to date.';

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
        checking={checking}
        updating={upgrading}
        updateBusyLabel="Upgrading…"
        details={available ? { label: 'View packages', onClick: openDetails } : null}
        status={status}
        lastChecked={updatesLastChecked}
        autoCheckLabel="Checked hourly"
      >
        {rebootRequired && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">Reboot required to finish previous upgrade</span>
                {onRequestRestart && (
                  <button
                    type="button"
                    onClick={onRequestRestart}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100 transition-colors duration-150"
                  >
                    <RotateCcw size={11} />
                    Restart now
                  </button>
                )}
              </div>
              {rebootReasons.length > 0 && (
                <div className="mt-0.5 break-words text-amber-600/90">
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
        subtitle={
          packages != null
            ? `${packages.length} package${packages.length !== 1 ? 's' : ''}${downloadBytes > 0 ? ` · ${formatBytes(downloadBytes)} to download` : ''}`
            : null
        }
        onClose={() => setDetailsOpen(false)}
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
