import { useState } from 'react';
import { Package, AlertCircle, RotateCcw, RefreshCw, Loader2 } from 'lucide-react';

import UpdateCard from './UpdateCard.jsx';
import UpdateDetailsModal from './UpdateDetailsModal.jsx';
import { useStatsStore } from '../../store/statsStore.js';
import { checkForUpdates, performUpgrade } from '../../api/host.js';
import { errorText } from '../../api/errors.js';
import { formatBytes, formatRelativeTime } from '../../utils/formatters.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useCommand } from '../../hooks/useCommand.js';
import RecordGate from '../shared/RecordGate.jsx';
import {
  DataTable, DataTableScroll, DataTableTd, DataTableTh, dataTableBodyRowClass, dataTableHeadRowClass,
} from '../shared/DataTableChrome.jsx';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import RecordError from '../shared/RecordError.jsx';

/**
 * UPDATE_BUSY — apt held by another process, or our own in-flight op blocking
 * a different op type — arrives as a 409 or as a job's error. The UI treats
 * it as a soft "try again later" status, not a red error.
 */
function isBusyError(err) {
  return err?.code === 'UPDATE_BUSY';
}

const BUSY_MESSAGE = 'Another package manager operation is running on the host. Try again in a moment.';

/* The package check and the upgrade are jobs that change the package list: each is
 * busy until its job ended and the list, read again after it, has landed. */
const PACKAGE_JOB = { job: true };

export default function OsUpdateSection({ onRequestRestart }) {
  const stats = useStatsStore((s) => s.data);
  const pendingUpdates = stats?.pendingUpdates ?? 0;
  const updatesLastChecked = stats?.updatesLastChecked ?? null;
  const updateOpInProgress = !!stats?.updateOperationInProgress;
  const rebootRequired = !!stats?.rebootRequired;
  const rebootReasons = stats?.rebootReasons ?? [];

  /* Check and upgrade: two commands, each with its error; apt runs one at a time, so
   * the card disables both while either runs. An UPDATE_BUSY failure (apt held
   * elsewhere) shows as a soft "try again" status, not as an error. */
  const op = useCommand();
  const checking = op.isBusy('check');
  const upgrading = op.isBusy('upgrade');
  const [manualCount, setManualCount] = useState(null);
  const [upgradeSuccess, setUpgradeSuccess] = useState(false);
  const busyFailure = op.errors.find(({ error }) => isBusyError(error))?.error ?? null;
  const busyMessage = busyFailure ? `${BUSY_MESSAGE} (${errorText(busyFailure)})` : null;
  const hardFailure = op.errors.some(({ error }) => !isBusyError(error));

  const [detailsOpen, setDetailsOpen] = useState(false);
  const refresh = useCommand();

  const handleCheckUpdates = () => {
    setUpgradeSuccess(false);
    op.run(checkForUpdates, {
      ...PACKAGE_JOB,
      key: 'check',
      onDone: (result) => setManualCount(result.count),
    });
  };

  const handleUpgrade = () => {
    setUpgradeSuccess(false);
    op.run(performUpgrade, {
      ...PACKAGE_JOB,
      key: 'upgrade',
      onDone: () => {
        setUpgradeSuccess(true);
        setManualCount(0);
      },
    });
  };

  const openDetails = () => setDetailsOpen(true);

  const handleRefreshPackages = () => refresh.run(checkForUpdates, PACKAGE_JOB);

  const count = manualCount ?? (pendingUpdates > 0 ? pendingUpdates : 0);
  const available = count > 0;

  /* Status precedence: busy > success > pending count > up-to-date (an error shows in
   * the card's error slot). Busy is rendered with the warn style (amber) —
   * informational, not red. */
  let status = null;
  if (hardFailure) {
    status = null;
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
        title="OS update"
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
        commands={[op]}
        showsError={(error) => !isBusyError(error)}
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
          refresh={refresh}
        />
      )}
    </>
  );
}

/** The upgradable packages, as the last check found them: read while this dialog is
 *  open, and again whenever a check ran (the stats say when). */
function PackagesDialog({ onClose, onRefresh, refresh }) {
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
            disabled={refresh.busy}
            title="Refresh package list"
            aria-label="Refresh package list"
            className="rounded-md border border-surface-border bg-surface-card p-1.5 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-50"
          >
            {refresh.busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        )
      }
    >
      <ErrorBanner
        className="mb-2"
        error={isBusyError(refresh.error) ? BUSY_MESSAGE : refresh.error}
        onDismiss={refresh.dismiss}
      />
      {record.data != null && <RecordError record={record} what="package list" className="mb-2" />}
      <RecordGate record={record} what="package list">
        {(found) => (found.packages.length === 0 ? (
          <p className="text-xs text-text-muted">No upgradable packages.</p>
        ) : (
          <DataTableScroll>
            <DataTable>
              <thead className="sticky top-0 bg-surface-card">
                <tr className={dataTableHeadRowClass}>
                  <DataTableTh dense>Package</DataTableTh>
                  <DataTableTh dense>From</DataTableTh>
                  <DataTableTh dense>To</DataTableTh>
                </tr>
              </thead>
              <tbody>
                {found.packages.map((p) => (
                  <tr key={p.name} className={dataTableBodyRowClass}>
                    <DataTableTd dense className="font-mono text-xs text-text-primary">{p.name}</DataTableTd>
                    <DataTableTd dense className="font-mono text-xs text-text-muted">{p.from || '—'}</DataTableTd>
                    <DataTableTd dense className="font-mono text-xs">{p.to}</DataTableTd>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </DataTableScroll>
        ))}
      </RecordGate>
    </UpdateDetailsModal>
  );
}
