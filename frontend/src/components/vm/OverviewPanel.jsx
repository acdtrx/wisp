import { useState, useEffect, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Play, Square, Zap, RotateCcw, Pause, PlayCircle,
  Trash2, Loader2, Code2, X, Archive,
} from 'lucide-react';

import { useVmStore, runVMCommand } from '../../store/vmStore.js';
import { getVmIcon, getDefaultIconId } from '../shared/vmIcons.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import { updateVM } from '../../api/vms.js';
import { getSettings } from '../../api/settings.js';
import {
  useBackgroundJobsStore, useWorkloadBusy, useWorkloadBackup, workloadBusyReason,
} from '../../store/backgroundJobsStore.js';
import { startBackup } from '../../api/backups.js';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import XMLModal from './XMLModal.jsx';
import BackupModal from '../shared/BackupModal.jsx';
import GeneralSection from '../sections/GeneralSection.jsx';
import DisksSection from '../sections/DisksSection.jsx';
import USBSection from '../sections/USBSection.jsx';
import AdvancedSection from '../sections/AdvancedSection.jsx';
import VmNetworkInterfacesSection from '../sections/VmNetworkInterfacesSection.jsx';
import CloudInitSection from '../sections/CloudInitSection.jsx';
import { errorText } from '../../api/errors.js';

const ConsolePanel = lazy(() => import('../console/ConsolePanel.jsx'));

function SectionSkeleton({ count = 3 }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className="rounded-xl border border-surface-border bg-surface-card p-4 space-y-3 animate-pulse">
      <div className="h-4 w-32 rounded-sm bg-surface" />
      <div className="space-y-2">
        <div className="h-3 w-full rounded-sm bg-surface" />
        <div className="h-3 w-2/3 rounded-sm bg-surface" />
      </div>
    </div>
  ));
}

/** Icon color by VM state (used on the VM icon in the title bar). */
const STATE_ICON_COLOR = {
  running: 'text-status-running',
  blocked: 'text-status-running',
  paused: 'text-status-warning',
  pmsuspended: 'text-status-warning',
  shutdown: 'text-status-transition',
  shutoff: 'text-text-secondary',
  crashed: 'text-status-stopped',
  nostate: 'text-text-secondary',
};

function ActionButton({ icon: Icon, label, onClick, disabled, variant = 'default', loading, hint, badge }) {
  const base = 'relative flex shrink-0 items-center justify-center rounded-md p-2 text-sm font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed';
  const variants = {
    default: 'border border-surface-border text-text-secondary hover:bg-surface hover:text-text-primary',
    danger: 'border border-status-stopped/30 text-status-stopped hover:bg-status-stopped-soft',
    primary: 'bg-accent text-white hover:bg-accent-hover',
  };
  const tip = hint ?? label;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      title={tip}
      aria-label={tip}
      className={`${base} ${variants[variant]}`}
    >
      {loading ? <Loader2 size={18} className="animate-spin" /> : <Icon size={18} />}
      {badge && (
        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-status-warning" />
      )}
    </button>
  );
}

export default function OverviewPanel() {
  const vmConfig = useVmStore((s) => s.vmConfig);
  const vmStats = useVmStore((s) => s.vmStats);
  const configLoading = useVmStore((s) => s.configLoading);
  const actionLoading = useVmStore((s) => s.actions[s.selectedVM] ?? null);
  const selectedVM = useVmStore((s) => s.selectedVM);
  const errors = useVmStore((s) => s.errors);
  const dismissError = useVmStore((s) => s.dismissError);
  const reportActionError = useVmStore((s) => s.reportActionError);
  const startVM = useVmStore((s) => s.startVM);
  const stopVM = useVmStore((s) => s.stopVM);
  const forceStopVM = useVmStore((s) => s.forceStopVM);
  const rebootVM = useVmStore((s) => s.rebootVM);
  const suspendVM = useVmStore((s) => s.suspendVM);
  const resumeVM = useVmStore((s) => s.resumeVM);
  const deleteVM = useVmStore((s) => s.deleteVM);
  const bgJobs = useBackgroundJobsStore((s) => s.jobs);

  const vmName = vmConfig?.name ?? '';
  // A job on this VM holds the backend's per-VM operation lock (start, delete and
  // every edit of the definition or disks → 409 VM_BUSY), so it blocks the
  // conflicting actions here and in every section editor below.
  const vmOperationJob = useWorkloadBusy({ type: 'vm', name: vmName });
  const busyHint = workloadBusyReason(vmOperationJob);
  const backupJob = useWorkloadBackup({ type: 'vm', name: vmName });

  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab === 'console' ? 'console' : 'overview';

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteDisks, setDeleteDisks] = useState(true);
  const [xmlModalOpen, setXmlModalOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [backupDestinations, setBackupDestinations] = useState([]);
  const [backupSelectedIds, setBackupSelectedIds] = useState(['local']);
  const [backupJobId, setBackupJobId] = useState(null);
  const [backupError, setBackupError] = useState(null);

  // Auto-clear backupJobId once the job ends, but ONLY while the modal is
  // closed. Clearing while it is open would blank `progress` and revert the
  // dialog to its initial Cancel/Start state — the user would never see the
  // "Backup complete." confirmation. With the gate, jobId is cleared at the
  // earliest of: modal close (handled in onClose), or this effect firing
  // after the modal is already gone.
  useEffect(() => {
    if (backupModalOpen) return;
    if (!backupJobId) return;
    const row = bgJobs[backupJobId];
    if (row && row.status !== 'running') {
      setBackupJobId(null);
    }
  }, [backupJobId, bgJobs, backupModalOpen]);

  useEffect(() => {
    setBackupJobId(null);
    setBackupError(null);
    setBackupModalOpen(false);
  }, [vmName]);

  /* The error page: the select read left no config. */
  const selectError = selectedVM ? errors[`select:${selectedVM}`] : null;
  if (!vmConfig && selectError && !configLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium text-status-stopped">{selectError.message}</p>
        <button
          type="button"
          onClick={() => { dismissError('select', selectedVM); navigate('/host/overview'); }}
          className="text-xs text-text-muted hover:text-text-secondary"
        >
          Go to Host overview
        </button>
      </div>
    );
  }

  if (!vmConfig) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-text-muted" />
      </div>
    );
  }

  const state = vmConfig.state;
  const isRunning = state === 'running' || state === 'blocked';
  const isStopped = state === 'shutoff' || state === 'nostate';
  const isPaused = state === 'paused' || state === 'pmsuspended';
  const iconColorClass = STATE_ICON_COLOR[state] || STATE_ICON_COLOR.nostate;
  const name = vmConfig.name;

  /* The banner: this VM's action and refresh errors, and the list's. */
  const bannerErrors = Object.values(errors).filter(
    (e) => (e.vm === name && (e.owner === 'action' || e.owner === 'refresh')) || e.owner === 'list',
  );

  const handleDelete = async () => {
    setDeleteDialogOpen(false);
    if (await deleteVM(name, deleteDisks)) navigate('/host/overview');
    // Do not reset deleteDisks here so the checkbox stays selected if delete fails and user retries
  };

  const handleOpenBackup = () => {
    setBackupModalOpen(true);
    setBackupError(null);
    setBackupJobId(backupJob ? backupJob.jobId : null);
    setBackupSelectedIds(['local']);
    getSettings().then((s) => {
      const dests = [{ id: 'local', label: 'Local', path: s.backupLocalPath || '/var/lib/wisp/backups' }];
      if (s.backupMountId) {
        const m = (s.mounts || []).find((x) => x.id === s.backupMountId);
        const p = m && m.mountPath;
        if (m && p) dests.push({ id: m.id, label: m.label || 'Network', path: p });
      }
      setBackupDestinations(dests);
    }).catch(() => setBackupDestinations([{ id: 'local', label: 'Local', path: '/var/lib/wisp/backups', fallback: true }]));
  };

  /* A rename is followed from the request: the server takes the name exactly as
   * sent, and announces the change under it. */
  const handleSectionSave = async (changes) => {
    const renamed = typeof changes.name === 'string' && changes.name !== name;
    const target = renamed ? changes.name : name;
    await runVMCommand(target, () => updateVM(name, changes));
    if (!renamed) return;
    useVmStore.getState().followRename(name, target);
    navigate(`/vm/${encodeURIComponent(target)}/${activeTab}`, { replace: true });
  };

  const iconId = vmConfig.iconId || getDefaultIconId(vmConfig.osCategory);
  const IconComp = getVmIcon(iconId).component;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header row: VM name + status | tabs | actions. Below lg it wraps to
          two rows (title+tabs / actions) instead of clipping in a fixed h-11. */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-surface-border bg-surface-card px-4 py-1 lg:h-11 lg:flex-nowrap lg:py-0">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => setIconPickerOpen(true)}
            disabled={!!vmOperationJob}
            className={`shrink-0 rounded-lg p-1 transition-colors duration-150 hover:bg-surface hover:opacity-90 disabled:cursor-not-allowed disabled:hover:bg-transparent ${iconColorClass}`}
            title={busyHint ?? 'Change icon'}
          >
            <IconComp size={18} className={isRunning ? 'wisp-lit-glyph' : undefined} />
          </button>
          <span className="truncate text-sm font-semibold text-text-primary">{name}</span>
          <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-text-muted shrink-0">vm</span>
          {/* Overview is the only tab once Console is hidden on mobile — drop the strip below lg */}
          <div className="hidden border-l border-surface-border pl-3 lg:flex">
            <button
              type="button"
              onClick={() => navigate(`/vm/${encodeURIComponent(name)}/overview`)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'overview' ? 'border-accent text-accent-text font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Overview
            </button>
            {/* VNC console is desktop-only — hidden below lg */}
            <button
              type="button"
              onClick={() => navigate(`/vm/${encodeURIComponent(name)}/console`)}
              className={`hidden lg:block border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'console' ? 'border-accent text-accent-text font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Console
            </button>
          </div>
        </div>
        {/* Below lg the actions become a full-width horizontally-scrollable row
            (primary actions leftmost); at lg+ they wrap right-aligned as before. */}
        <div className="flex w-full shrink-0 items-center justify-start gap-1 overflow-x-auto lg:w-auto lg:flex-wrap lg:justify-end lg:overflow-visible">
          {vmConfig.pendingRestart && (
            <span
              className="shrink-0 rounded-full bg-status-warning-soft px-2 py-0.5 text-[10px] font-medium text-status-warning mr-1"
              title="Saved changes apply when the VM is stopped and started again — a guest reboot keeps the running configuration"
            >
              Restart required
            </span>
          )}
          <ActionButton
            icon={Play} label="Start"
            onClick={() => startVM(name)}
            disabled={!isStopped || !!vmOperationJob}
            hint={busyHint}
            loading={actionLoading === 'start'}
            variant="primary"
          />
          <ActionButton
            icon={Square} label="Stop"
            onClick={() => stopVM(name)}
            disabled={isStopped || !!vmOperationJob}
            hint={busyHint}
            loading={actionLoading === 'stop'}
          />
          <ActionButton
            icon={Zap} label="Force Stop"
            onClick={() => forceStopVM(name)}
            disabled={isStopped || !!vmOperationJob}
            hint={busyHint}
            loading={actionLoading === 'force-stop'}
            variant="danger"
          />
          <ActionButton
            icon={RotateCcw} label="Reboot"
            onClick={() => rebootVM(name)}
            disabled={!isRunning || !!vmOperationJob}
            loading={actionLoading === 'reboot'}
            badge={!!vmStats?.staleBinary}
            hint={busyHint ?? (vmStats?.staleBinary ? 'Reboot (qemu binary updated since VM started)' : undefined)}
          />
          <ActionButton
            icon={Pause} label="Suspend"
            onClick={() => suspendVM(name)}
            disabled={!isRunning || !!vmOperationJob}
            hint={busyHint}
            loading={actionLoading === 'suspend'}
          />
          <ActionButton
            icon={PlayCircle} label="Resume"
            onClick={() => resumeVM(name)}
            disabled={!isPaused || !!vmOperationJob}
            hint={busyHint}
            loading={actionLoading === 'resume'}
          />
          <div className="mx-0.5 h-4 w-px shrink-0 bg-surface-border" />
          <ActionButton
            icon={Archive} label="Backup"
            onClick={handleOpenBackup}
            disabled={!isStopped || !!vmOperationJob}
            hint={busyHint}
          />
          <ActionButton
            icon={Trash2} label="Delete"
            onClick={() => setDeleteDialogOpen(true)}
            disabled={!!vmOperationJob}
            hint={busyHint}
            variant="danger"
            loading={actionLoading === 'delete'}
          />
          {/* View XML is a debug affordance — desktop only */}
          <span className="hidden lg:contents">
            <ActionButton
              icon={Code2} label="View XML"
              onClick={() => setXmlModalOpen(true)}
            />
          </span>
        </div>
      </div>

      {/* Error display - visible in both tabs; each error stays until dismissed */}
      {bannerErrors.map((e) => (
        <div key={`${e.owner}:${e.vm ?? ''}`} className="shrink-0 flex items-center justify-between gap-2 rounded-none border-b border-status-stopped/30 bg-status-stopped-soft px-4 py-2 text-xs text-status-stopped">
          <span className="min-w-0 flex-1">{e.message}</span>
          <button
            type="button"
            onClick={() => dismissError(e.owner, e.vm)}
            className="shrink-0 rounded-sm p-1 hover:bg-status-stopped/20 transition-colors duration-150"
            title="Dismiss"
            aria-label="Dismiss error"
          >
            <X size={14} />
          </button>
        </div>
      ))}

      {activeTab === 'console' ? (
        <Suspense fallback={
          <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        }>
          <ConsolePanel vmName={name} />
        </Suspense>
      ) : (
      /* Overview content */
      <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5 space-y-5">
        {vmOperationJob && (
          <p className="flex items-center gap-1.5 rounded-md border border-status-warning/30 bg-status-warning-soft px-3 py-2 text-xs text-status-warning">
            <Loader2 size={13} aria-hidden className="shrink-0 animate-spin" />
            “{vmOperationJob.title}” is running — changes to this VM&rsquo;s configuration, disks and cloud-init are unavailable until it finishes.
          </p>
        )}

        {/* Sections */}
        <GeneralSection
          vmConfig={vmConfig}
          isCreating={false}
          onSave={handleSectionSave}
          busyReason={busyHint}
        />

        {configLoading ? (
          <SectionSkeleton count={4} />
        ) : (
          <>
            <DisksSection
              vmConfig={vmConfig}
              busyReason={busyHint}
            />

            <USBSection vmConfig={vmConfig} busyReason={busyHint} />

            <VmNetworkInterfacesSection
              vmConfig={vmConfig}
              isCreating={false}
              onSave={handleSectionSave}
              busyReason={busyHint}
            />

            <AdvancedSection
              vmConfig={vmConfig}
              isCreating={false}
              onSave={handleSectionSave}
              busyReason={busyHint}
            />

            {vmConfig.osCategory !== 'windows' && (
              <CloudInitSection
                vmConfig={vmConfig}
                isCreating={false}
                busyReason={busyHint}
              />
            )}
          </>
        )}
      </div>
      )}

      {/* Delete dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete VM"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => { setDeleteDialogOpen(false); setDeleteDisks(true); }}
      >
        <p>Are you sure you want to delete &ldquo;{name}&rdquo;? This cannot be undone.</p>
        <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={deleteDisks}
            onChange={(e) => setDeleteDisks(e.target.checked)}
            className="rounded-sm border-surface-border"
          />
          Also delete disk images
        </label>
      </ConfirmDialog>

      {/* XML modal */}
      <XMLModal
        open={xmlModalOpen}
        vmName={name}
        onClose={() => setXmlModalOpen(false)}
      />

      {/* Backup modal */}
      {backupModalOpen && (
        <BackupModal
          name={name}
          subjectLabel="VM"
          backupStarted={!!backupJobId}
          destinations={backupDestinations}
          selectedIds={backupSelectedIds}
          onToggleDestination={(id) => {
            setBackupSelectedIds((prev) =>
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
            );
          }}
          progress={
            backupJobId
              ? {
                  step: bgJobs[backupJobId]?.step || 'starting',
                  percent: bgJobs[backupJobId]?.percent ?? null,
                  currentFile: bgJobs[backupJobId]?.detail ?? null,
                }
              : null
          }
          error={
            backupJobId && bgJobs[backupJobId]?.error
              ? errorText(bgJobs[backupJobId].error)
              : backupError
          }
          onStart={async () => {
            setBackupError(null);
            try {
              const { jobId } = await startBackup(name, { destinationIds: backupSelectedIds });
              setBackupJobId(jobId);
            } catch (err) {
              setBackupError(errorText(err));
              setBackupJobId(null);
            }
          }}
          onClose={() => {
            setBackupModalOpen(false);
            const row = backupJobId ? bgJobs[backupJobId] : null;
            if (!row || row.status !== 'running') {
              setBackupJobId(null);
              setBackupError(null);
            }
          }}
        />
      )}

      {/* Icon picker */}
      <IconPickerModal
        open={iconPickerOpen}
        currentIconId={vmConfig.iconId || getDefaultIconId(vmConfig.osCategory)}
        onSelect={async (selectedIconId) => {
          try {
            await runVMCommand(name, () => updateVM(name, { iconId: selectedIconId }));
          } catch (err) {
            reportActionError(name, errorText(err));
          }
        }}
        onClose={() => setIconPickerOpen(false)}
      />
    </div>
  );
}
