import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Play, Square, Zap, RotateCcw, Pause, PlayCircle,
  Copy, Trash2, Loader2, Code2, X, Archive,
} from 'lucide-react';

import { useVmStore } from '../../store/vmStore.js';
import { getVmIcon, getDefaultIconId } from '../shared/vmIcons.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import { updateVM, cloneVM as cloneVmApi } from '../../api/vms.js';
import { getSettings } from '../../api/settings.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { JOB_KIND } from '../../api/jobProgress.js';
import { startBackup } from '../../api/backups.js';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import CloneDialog from './CloneDialog.jsx';
import XMLModal from './XMLModal.jsx';
import BackupModal from '../shared/BackupModal.jsx';
import GeneralSection from '../sections/GeneralSection.jsx';
import DisksSection from '../sections/DisksSection.jsx';
import USBSection from '../sections/USBSection.jsx';
import AdvancedSection from '../sections/AdvancedSection.jsx';
import VmNetworkInterfacesSection from '../sections/VmNetworkInterfacesSection.jsx';
import CloudInitSection from '../sections/CloudInitSection.jsx';
import SnapshotsSection from '../sections/SnapshotsSection.jsx';

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
  const actionLoading = useVmStore((s) => s.actionLoading);
  const error = useVmStore((s) => s.error);
  const clearError = useVmStore((s) => s.clearError);
  const startVM = useVmStore((s) => s.startVM);
  const stopVM = useVmStore((s) => s.stopVM);
  const forceStopVM = useVmStore((s) => s.forceStopVM);
  const rebootVM = useVmStore((s) => s.rebootVM);
  const suspendVM = useVmStore((s) => s.suspendVM);
  const resumeVM = useVmStore((s) => s.resumeVM);
  const deleteVM = useVmStore((s) => s.deleteVM);
  const refreshSelectedVM = useVmStore((s) => s.refreshSelectedVM);
  const registerJob = useBackgroundJobsStore((s) => s.registerJob);
  const bgJobs = useBackgroundJobsStore((s) => s.jobs);

  const vmName = vmConfig?.name ?? '';
  const backupTitleForVm = useMemo(() => (vmName ? `Backup ${vmName}` : ''), [vmName]);
  const backupRunningJob = useMemo(
    () =>
      backupTitleForVm
        ? Object.values(bgJobs).find(
            (j) =>
              j.kind === JOB_KIND.BACKUP &&
              j.title === backupTitleForVm &&
              j.status === 'running',
          )
        : undefined,
    [bgJobs, backupTitleForVm],
  );
  const backupInProgress = !!backupRunningJob;

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
  // Clone runs as a background job (parallels backup). cloneDialogOpen reflects
  // whether the dialog is mounted; cloneJobId is set after `onConfirm` succeeds.
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [cloneJobId, setCloneJobId] = useState(null);
  const [cloneError, setCloneError] = useState(null);

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
    if (row && (row.status === 'done' || row.status === 'error')) {
      setBackupJobId(null);
    }
  }, [backupJobId, bgJobs, backupModalOpen]);

  // Same gated cleanup for clone (mirrors the backup pattern).
  useEffect(() => {
    if (cloneDialogOpen) return;
    if (!cloneJobId) return;
    const row = bgJobs[cloneJobId];
    if (row && (row.status === 'done' || row.status === 'error')) {
      setCloneJobId(null);
    }
  }, [cloneJobId, bgJobs, cloneDialogOpen]);

  useEffect(() => {
    setBackupJobId(null);
    setBackupError(null);
    setBackupModalOpen(false);
    setCloneJobId(null);
    setCloneError(null);
    setCloneDialogOpen(false);
  }, [vmName]);

  if (!vmConfig && error && !configLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium text-status-stopped">{error}</p>
        <button
          type="button"
          onClick={() => { clearError(); navigate('/host/overview'); }}
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

  const handleClone = async (newName) => {
    setCloneError(null);
    try {
      const { jobId, title } = await cloneVmApi(name, newName);
      setCloneJobId(jobId);
      registerJob({ jobId, kind: JOB_KIND.VM_CLONE, title });
    } catch (err) {
      setCloneError(err.message || 'Failed to start clone');
      setCloneJobId(null);
    }
  };

  const handleDelete = async () => {
    setDeleteDialogOpen(false);
    await deleteVM(name, deleteDisks);
    if (!useVmStore.getState().error) navigate('/host/overview');
    // Do not reset deleteDisks here so the checkbox stays selected if delete fails and user retries
  };

  const handleOpenBackup = () => {
    setBackupModalOpen(true);
    setBackupError(null);
    const existing = Object.values(bgJobs).find(
      (j) =>
        j.kind === JOB_KIND.BACKUP &&
        j.title === backupTitleForVm &&
        j.status === 'running',
    );
    setBackupJobId(existing ? existing.jobId : null);
    setBackupSelectedIds(['local']);
    getSettings().then((s) => {
      const dests = [{ id: 'local', label: 'Local', path: s.backupLocalPath || '/var/lib/wisp/backups' }];
      if (s.backupMountId) {
        const m = (s.mounts || []).find((x) => x.id === s.backupMountId);
        const p = m && m.mountPath;
        if (m && p) dests.push({ id: m.id, label: m.label || 'Network', path: p });
      }
      setBackupDestinations(dests);
    }).catch(() => setBackupDestinations([{ id: 'local', label: 'Local', path: '/var/lib/wisp/backups' }]));
  };

  const handleSectionSave = async (changes) => {
    const result = await updateVM(name, changes);
    const newName =
      typeof changes.name === 'string' ? changes.name.trim() : '';
    const renamed = newName !== '' && newName !== name;
    await refreshSelectedVM(renamed ? newName : undefined);
    if (renamed) navigate(`/vm/${encodeURIComponent(newName)}/${activeTab}`);
    return result;
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
            className={`shrink-0 rounded-lg p-1 transition-colors duration-150 hover:bg-surface hover:opacity-90 ${iconColorClass}`}
            title="Change icon"
          >
            <IconComp size={18} />
          </button>
          <span className="truncate text-sm font-semibold text-text-primary">{name}</span>
          <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-text-muted shrink-0">vm</span>
          {/* Overview is the only tab once Console is hidden on mobile — drop the strip below lg */}
          <div className="hidden border-l border-surface-border pl-3 lg:flex">
            <button
              type="button"
              onClick={() => navigate(`/vm/${encodeURIComponent(name)}/overview`)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'overview' ? 'border-accent text-accent font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Overview
            </button>
            {/* VNC console is desktop-only — hidden below lg */}
            <button
              type="button"
              onClick={() => navigate(`/vm/${encodeURIComponent(name)}/console`)}
              className={`hidden lg:block border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'console' ? 'border-accent text-accent font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Console
            </button>
          </div>
        </div>
        {/* Below lg the actions become a full-width horizontally-scrollable row
            (primary actions leftmost); at lg+ they wrap right-aligned as before. */}
        <div className="flex w-full shrink-0 items-center justify-start gap-1 overflow-x-auto lg:w-auto lg:flex-wrap lg:justify-end lg:overflow-visible">
          <ActionButton
            icon={Play} label="Start"
            onClick={() => startVM(name)}
            disabled={!isStopped || backupInProgress}
            hint={backupInProgress ? 'Cannot start while a backup is in progress' : undefined}
            loading={actionLoading === 'start'}
            variant="primary"
          />
          <ActionButton
            icon={Square} label="Stop"
            onClick={() => stopVM(name)}
            disabled={isStopped}
            loading={actionLoading === 'stop'}
          />
          <ActionButton
            icon={Zap} label="Force Stop"
            onClick={() => forceStopVM(name)}
            disabled={isStopped}
            loading={actionLoading === 'force-stop'}
            variant="danger"
          />
          <ActionButton
            icon={RotateCcw} label="Reboot"
            onClick={() => rebootVM(name)}
            disabled={!isRunning}
            loading={actionLoading === 'reboot'}
            badge={!!vmStats?.staleBinary}
            hint={vmStats?.staleBinary ? 'Reboot (qemu binary updated since VM started)' : undefined}
          />
          <ActionButton
            icon={Pause} label="Suspend"
            onClick={() => suspendVM(name)}
            disabled={!isRunning}
            loading={actionLoading === 'suspend'}
          />
          <ActionButton
            icon={PlayCircle} label="Resume"
            onClick={() => resumeVM(name)}
            disabled={!isPaused}
            loading={actionLoading === 'resume'}
          />
          <div className="mx-0.5 h-4 w-px shrink-0 bg-surface-border" />
          <ActionButton
            icon={Archive} label="Backup"
            onClick={handleOpenBackup}
            disabled={!isStopped}
          />
          <CloneDialog
            open={cloneDialogOpen}
            onOpen={() => {
              setCloneError(null);
              setCloneJobId(null);
              setCloneDialogOpen(true);
            }}
            cloneStarted={!!cloneJobId}
            progress={
              cloneJobId && bgJobs[cloneJobId]
                ? {
                    step: bgJobs[cloneJobId].step || 'starting',
                    percent: bgJobs[cloneJobId].percent,
                    currentFile: bgJobs[cloneJobId].detail,
                  }
                : null
            }
            error={
              cloneJobId && bgJobs[cloneJobId]?.status === 'error'
                ? bgJobs[cloneJobId].error
                : cloneError
            }
            onConfirm={handleClone}
            onClose={() => {
              setCloneDialogOpen(false);
              const row = cloneJobId ? bgJobs[cloneJobId] : null;
              if (!row || row.status !== 'running') {
                setCloneJobId(null);
                setCloneError(null);
              }
            }}
            trigger={(onOpen) => (
              <ActionButton icon={Copy} label="Clone" onClick={onOpen} disabled={isRunning} />
            )}
          />
          <ActionButton
            icon={Trash2} label="Delete"
            onClick={() => setDeleteDialogOpen(true)}
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

      {/* Error display - visible in both tabs */}
      {error && (
        <div className="shrink-0 flex items-center justify-between gap-2 rounded-none border-b border-status-stopped/30 bg-status-stopped-soft px-4 py-2 text-xs text-status-stopped">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="shrink-0 rounded-sm p-1 hover:bg-status-stopped/20 transition-colors duration-150"
            title="Dismiss"
            aria-label="Dismiss error"
          >
            <X size={14} />
          </button>
        </div>
      )}

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
        {/* Sections */}
        <GeneralSection
          vmConfig={vmConfig}
          isCreating={false}
          onSave={handleSectionSave}
        />

        {configLoading ? (
          <SectionSkeleton count={4} />
        ) : (
          <>
            <DisksSection
              vmConfig={vmConfig}
              onRefresh={refreshSelectedVM}
            />

            <USBSection vmConfig={vmConfig} />

            <VmNetworkInterfacesSection
              vmConfig={vmConfig}
              isCreating={false}
              onSave={handleSectionSave}
            />

            <AdvancedSection
              vmConfig={vmConfig}
              isCreating={false}
              onSave={handleSectionSave}
            />

            {vmConfig.osCategory !== 'windows' && (
              <CloudInitSection
                vmConfig={vmConfig}
                isCreating={false}
                onRefresh={refreshSelectedVM}
              />
            )}

            <SnapshotsSection vmConfig={vmConfig} />
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
            backupJobId && bgJobs[backupJobId]
              ? {
                  step: bgJobs[backupJobId].step || 'starting',
                  percent: bgJobs[backupJobId].percent,
                  currentFile: bgJobs[backupJobId].detail,
                }
              : null
          }
          error={
            backupJobId && bgJobs[backupJobId]?.status === 'error'
              ? bgJobs[backupJobId].error
              : backupError
          }
          onStart={async () => {
            setBackupError(null);
            try {
              const { jobId, title } = await startBackup(name, { destinationIds: backupSelectedIds });
              setBackupJobId(jobId);
              registerJob({
                jobId,
                kind: JOB_KIND.BACKUP,
                title,
              });
            } catch (err) {
              setBackupError(err.message || 'Failed to start backup');
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
          await updateVM(name, { iconId: selectedIconId });
          await refreshSelectedVM();
        }}
        onClose={() => setIconPickerOpen(false)}
      />
    </div>
  );
}
