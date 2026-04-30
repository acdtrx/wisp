import { useState, useCallback, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Loader2,
  RefreshCw,
  ArrowUpCircle,
  Rocket,
  CheckCircle,
  AlertCircle,
  Clock,
  ExternalLink,
} from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import { useStatsStore } from '../../store/statsStore.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { JOB_KIND } from '../../api/jobProgress.js';
import {
  getUpdateStatus,
  checkForWispUpdate,
  installWispUpdate,
} from '../../api/updates.js';

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

const STEP_LABELS = {
  start: 'Starting…',
  download: 'Downloading…',
  verify: 'Verifying checksum…',
  extract: 'Extracting…',
  apply: 'Applying update…',
  'stop-services': 'Stopping services…',
  snapshot: 'Snapshotting current install…',
  swap: 'Swapping in new version…',
  'install-deps': 'Installing dependencies…',
  'install-helpers': 'Refreshing privileged helpers…',
  'install-units': 'Reinstalling systemd units…',
  'start-services': 'Starting services…',
  rollback: 'Rolling back…',
  done: 'Update complete — backend restarting',
};

export default function WispUpdateSection() {
  /* SSE-driven badge data (current/latest/available/lastChecked); hydrate on
   * first mount via /updates/status because the SSE may not have ticked yet. */
  const wispUpdate = useStatsStore((s) => s.stats?.wispUpdate ?? null);
  const [hydrated, setHydrated] = useState(null);
  const [notes, setNotes] = useState(null);
  const [publishedAt, setPublishedAt] = useState(null);
  const [repo, setRepo] = useState(null);

  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);

  const [activeJob, setActiveJob] = useState(null); // { jobId }

  const jobs = useBackgroundJobsStore((s) => s.jobs);
  const registerJob = useBackgroundJobsStore((s) => s.registerJob);
  const runningOtherJobs = useMemo(
    () =>
      Object.values(jobs).filter(
        (j) => j.status === 'running' && j.kind !== JOB_KIND.WISP_UPDATE,
      ),
    [jobs],
  );
  const liveJob = activeJob ? jobs[activeJob.jobId] : null;

  const refreshFromServer = useCallback(async () => {
    try {
      const s = await getUpdateStatus();
      setHydrated(s);
      setNotes(s.notes ?? null);
      setPublishedAt(s.publishedAt ?? null);
      setRepo(s.repo ?? null);
    } catch (err) {
      setError(err.detail || err.message || 'Failed to load status');
    }
  }, []);

  useEffect(() => {
    refreshFromServer();
  }, [refreshFromServer]);

  const current = wispUpdate?.current ?? hydrated?.current ?? null;
  const latest = wispUpdate?.latest ?? hydrated?.latest ?? null;
  const available = (wispUpdate?.available ?? hydrated?.available) === true;
  const lastChecked = wispUpdate?.lastChecked ?? hydrated?.lastChecked ?? null;

  const handleCheck = useCallback(async () => {
    setError(null);
    setChecking(true);
    try {
      const s = await checkForWispUpdate();
      setHydrated(s);
      setNotes(s.notes ?? null);
      setPublishedAt(s.publishedAt ?? null);
      setRepo(s.repo ?? null);
    } catch (err) {
      setError(err.detail || err.message || 'Check failed');
    } finally {
      setChecking(false);
    }
  }, []);

  const beginInstall = useCallback(() => {
    setError(null);
    setConfirmForce(runningOtherJobs.length > 0);
    setConfirmOpen(true);
  }, [runningOtherJobs.length]);

  const doInstall = useCallback(async () => {
    setConfirmOpen(false);
    setInstalling(true);
    try {
      const { jobId } = await installWispUpdate({ force: confirmForce });
      setActiveJob({ jobId });
      registerJob({
        jobId,
        kind: JOB_KIND.WISP_UPDATE,
        title: `Update to v${latest}`,
      });
    } catch (err) {
      setInstalling(false);
      setError(err.detail || err.message || 'Install failed to start');
    }
  }, [confirmForce, latest, registerJob]);

  /* When the update job reaches a terminal state, schedule a short delay
   * (services restart) and then reload — the page reload yanks fresh assets
   * from the new frontend. */
  useEffect(() => {
    if (!liveJob) return;
    if (liveJob.status === 'done') {
      const t = setTimeout(() => window.location.reload(), 5000);
      return () => clearTimeout(t);
    }
    if (liveJob.status === 'error') {
      setInstalling(false);
      setError(liveJob.error || 'Update failed');
    }
  }, [liveJob]);

  const stepLabel = liveJob?.step ? STEP_LABELS[liveJob.step] || liveJob.step : null;
  const downloadPercent =
    liveJob?.step === 'download' && liveJob?.percent != null
      ? Math.round(liveJob.percent)
      : null;
  const releaseUrl = repo && latest ? `https://github.com/${repo}/releases/tag/v${latest}` : null;
  const lastCheckedLabel = formatRelativeTime(lastChecked);
  const publishedLabel = formatRelativeTime(publishedAt);

  return (
    <SectionCard title="Wisp Update" titleIcon={<Rocket size={14} strokeWidth={2} />}>
      <div className="flex items-center justify-between gap-4">
        <p className="flex-1 text-sm text-text-secondary">
          {current ? (
            <>
              Currently running <span className="font-medium text-text-primary">v{current}</span>
              {available && latest && (
                <>
                  {' '}— update <span className="font-medium text-text-primary">v{latest}</span> available
                </>
              )}
              .
            </>
          ) : (
            'Check for newer Wisp releases on GitHub.'
          )}
        </p>
        <div className="shrink-0 flex items-center gap-2">
          <button
            type="button"
            onClick={handleCheck}
            disabled={checking || installing}
            className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface-card px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface transition-colors duration-150 disabled:opacity-50"
          >
            {checking ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {checking ? 'Checking…' : 'Check'}
          </button>
          <button
            type="button"
            onClick={beginInstall}
            disabled={!available || checking || installing}
            className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface-card px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface transition-colors duration-150 disabled:opacity-50"
          >
            {installing ? <Loader2 size={16} className="animate-spin" /> : <ArrowUpCircle size={16} />}
            {installing ? 'Installing…' : 'Install update'}
          </button>
        </div>
      </div>

      {available && notes && !installing && (
        <details className="mt-3 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs">
          <summary className="cursor-pointer select-none text-text-secondary">
            Release notes
            {publishedLabel && <span className="ml-2 text-text-muted">(published {publishedLabel})</span>}
            {releaseUrl && (
              <a
                href={releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="ml-2 inline-flex items-center gap-1 text-accent hover:underline"
              >
                <ExternalLink size={11} />
                view on GitHub
              </a>
            )}
          </summary>
          <div className="prose prose-sm prose-slate mt-2 max-h-64 max-w-none overflow-auto break-words text-text-secondary prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:text-text-primary prose-p:my-1.5 prose-li:my-0.5 prose-code:rounded prose-code:bg-surface prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none prose-a:text-accent">
            <ReactMarkdown
              components={{
                a: ({ node, ...props }) => (
                  <a {...props} target="_blank" rel="noopener noreferrer" />
                ),
              }}
            >
              {notes}
            </ReactMarkdown>
          </div>
        </details>
      )}

      {liveJob && (
        <div className="mt-3 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            {liveJob.status === 'running' && <Loader2 size={13} className="shrink-0 animate-spin text-accent" />}
            {liveJob.status === 'done' && <CheckCircle size={13} className="shrink-0 text-status-running" />}
            {liveJob.status === 'error' && <AlertCircle size={13} className="shrink-0 text-status-stopped" />}
            <span className="text-text-secondary">{stepLabel || 'Working…'}</span>
            {downloadPercent != null && <span className="ml-auto text-text-muted">{downloadPercent}%</span>}
          </div>
          {liveJob.status === 'error' && liveJob.error && (
            <div className="mt-1 break-words text-status-stopped">{liveJob.error}</div>
          )}
          {liveJob.status === 'done' && (
            <div className="mt-1 text-text-muted">Backend is restarting — page will refresh in a moment.</div>
          )}
        </div>
      )}

      {(error || lastCheckedLabel) && !liveJob && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {error && (
            <>
              <AlertCircle size={13} className="shrink-0 text-status-stopped" />
              <span className="text-status-stopped">{error}</span>
            </>
          )}
          {lastCheckedLabel && (
            <span className={`flex items-center gap-1 text-text-muted${error ? ' ml-auto' : ''}`}>
              <Clock size={11} className="shrink-0" />
              {lastCheckedLabel}
            </span>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={`Install Wisp v${latest}?`}
        confirmLabel="Install"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={doInstall}
      >
        <p>
          Wisp will download v{latest}, swap it in, and restart its services. The web UI will
          briefly disconnect and reload automatically.
        </p>
        {confirmForce && (
          <p className="mt-2 text-amber-700">
            <span className="font-medium">{runningOtherJobs.length} background job(s) are still running.</span>{' '}
            They will be interrupted by the restart.
          </p>
        )}
      </ConfirmDialog>
    </SectionCard>
  );
}
