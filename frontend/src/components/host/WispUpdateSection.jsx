import { useState, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Loader2,
  RefreshCw,
  ArrowUpCircle,
  Rocket,
  AlertCircle,
  Clock,
  ExternalLink,
} from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import { useStatsStore } from '../../store/statsStore.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { getHostInfo } from '../../api/host.js';
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

const POLL_INTERVAL_MS = 5_000;
const SLOW_AFTER_FAILED_POLLS = 12; // 12 × 5s = 1 min of "backend not responding"
const MAX_TOTAL_POLLS = 60;          // 60 × 5s = 5 min hard cap

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
  const [installTarget, setInstallTarget] = useState(null);
  const [installSlow, setInstallSlow] = useState(false);
  const [installStuck, setInstallStuck] = useState(false);
  const [error, setError] = useState(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);

  const jobs = useBackgroundJobsStore((s) => s.jobs);
  const runningOtherJobs = Object.values(jobs).filter((j) => j.status === 'running');

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
    setError(null);
    setInstallSlow(false);
    setInstallStuck(false);
    setInstalling(true);
    setInstallTarget(latest);
    try {
      /* Backend blocks during download (~5–15s) then triggers
       * wisp-updater.service and returns 202. After that the backend dies
       * as the updater runs systemctl stop wisp-backend; we detect completion
       * below by polling /api/host wispVersion === target. */
      await installWispUpdate({ force: confirmForce });
    } catch (err) {
      setInstalling(false);
      setInstallTarget(null);
      setError(err.detail || err.message || 'Install failed to start');
    }
  }, [confirmForce, latest]);

  /* Poll /api/host every 5s. Stop when wispVersion matches the target (then
   * reload the page to pick up the new frontend bundle). Show a "may be slow"
   * note after 12 failed polls (1 min); give up after 60 total polls (5 min).
   * Failures are EXPECTED while the backend is restarting — we count them
   * against `consecutiveFailures` only, and reset on every successful poll. */
  const pollIntervalRef = useRef(null);
  useEffect(() => {
    if (!installing || !installTarget) return undefined;

    let consecutiveFailures = 0;
    let totalPolls = 0;

    async function tick() {
      totalPolls++;
      try {
        const info = await getHostInfo();
        consecutiveFailures = 0;
        if (info?.wispVersion === installTarget) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          /* Brief pause so the success badge actually renders before reload */
          setTimeout(() => window.location.reload(), 1500);
        }
        /* else: backend up, version not yet swapped — could be pre-stop, or
         * post-rollback. We can't reliably tell, so just keep polling until
         * the hard cap. */
      } catch {
        consecutiveFailures++;
        if (consecutiveFailures >= SLOW_AFTER_FAILED_POLLS) {
          setInstallSlow(true);
        }
      }
      if (totalPolls >= MAX_TOTAL_POLLS) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
        setInstallStuck(true);
      }
    }

    pollIntervalRef.current = setInterval(tick, POLL_INTERVAL_MS);
    /* fire one immediately so we don't wait the first 5 s */
    tick();
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [installing, installTarget]);

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

      {installing && (
        <div className="mt-3 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
            <span className="text-text-secondary">
              Installing v{installTarget}… backend will restart and the page will reload automatically.
            </span>
          </div>
          {installSlow && !installStuck && (
            <div className="mt-1 flex items-start gap-2 text-amber-700">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>
                Backend hasn't come back yet — install may be slow. Still trying.
              </span>
            </div>
          )}
          {installStuck && (
            <div className="mt-1 flex items-start gap-2 text-status-stopped">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>
                Install hasn't completed after 5 minutes. Check{' '}
                <code className="rounded bg-surface-card px-1">sudo journalctl -u wisp-updater.service</code>{' '}
                on the server for details.
              </span>
            </div>
          )}
        </div>
      )}

      {(error || lastCheckedLabel) && !installing && (
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
          briefly disconnect; the page will reload automatically once the new version is up.
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
