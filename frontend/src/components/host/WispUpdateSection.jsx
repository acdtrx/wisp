import { useState, useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Loader2, Rocket, AlertCircle, ExternalLink } from 'lucide-react';
import UpdateCard from './UpdateCard.jsx';
import UpdateDetailsModal from './UpdateDetailsModal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import { useStatsStore } from '../../store/statsStore.js';
import { awaitJob, useRunningJobCount } from '../../store/backgroundJobsStore.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useJobProgress } from '../../hooks/useJobProgress.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import RecordError from '../shared/RecordError.jsx';
import { getHostInfo } from '../../api/host.js';
import { updateSettings } from '../../api/settings.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import {
  checkForWispUpdate,
  installWispUpdate,
} from '../../api/updates.js';
import { CLIENT_CODES } from '../../api/errors.js';

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
// For as long as the updater may run: systemd/linux/wisp-updater.service's
// TimeoutStartSec and the TimeoutStopSec its rollback gets after it. A long
// state migration runs inside that window.
const UPDATER_LIMIT_MS = (1800 + 2000) * 1000;
const MAX_TOTAL_POLLS = Math.ceil(UPDATER_LIMIT_MS / POLL_INTERVAL_MS);

// Force every rendered <a> in release notes to open in a new tab. DOMPurify
// strips javascript: URLs and dangerous tags before this hook runs, so we only
// have to worry about presentation here. Module-load runs once, and DOMPurify
// is used nowhere else in the app — no risk of leaking the rewrite.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function NotesHtml({ markdown }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(markdown, { gfm: true, breaks: false })),
    [markdown],
  );
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function WispUpdateSection() {
  /* SSE-driven badge data (current/latest/available/lastChecked); hydrate on
   * first mount via /updates/status because the SSE may not have ticked yet. */
  const wispUpdate = useStatsStore((s) => s.data?.wispUpdate ?? null);
  /* The full status (notes, repo, …), read again on every check from any tab, the
   * hourly poll included. */
  const statusRecord = useRecord(RECORD.WISP_UPDATE);
  const hydrated = statusRecord.data;
  const notes = hydrated?.notes ?? null;
  const publishedAt = hydrated?.publishedAt ?? null;
  const repo = hydrated?.repo ?? null;

  /* The check, and the channel change (which checks again on the new channel): two
   * commands of one hook (`channel` the latter's key), each with its error. The
   * install's start is its own command; its wait through the backend's restart is the
   * `installing` / `restarting` flags below (the self-update's, not a command's). */
  const check = useCommand();
  const install = useCommand();
  const checking = check.busy;
  const [installing, setInstalling] = useState(false);
  const [installTarget, setInstallTarget] = useState(null);
  /* Set once the install job hands over to the updater: from then on the
   * backend restarts, and the version poll below waits for it. */
  const [restarting, setRestarting] = useState(false);
  const [installJobId, setInstallJobId] = useState(null);
  /* Once the install job's stream brought a `restarting` event, the handover happened
   * (read from its progress, which the wait follows whether or not the topic lists the job). */
  const handedOver = !!useJobProgress(installJobId)?.events.restarting;
  const handedOverRef = useRef(false);
  useEffect(() => {
    if (handedOver) handedOverRef.current = true;
  }, [handedOver]);
  const [installSlow, setInstallSlow] = useState(false);
  const [installStuck, setInstallStuck] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const runningJobCount = useRunningJobCount();

  /* The configured update channel lives in settings; the check result never
   * echoes it back (see spec/UPDATES.md). */
  const settingsRecord = useRecord(RECORD.SETTINGS);
  const channel = settingsRecord.data?.updateChannel ?? 'stable';
  /* The channel just chosen, shown until the settings reload carries it. */
  const [pendingChannel, setPendingChannel] = useState(null);
  useEffect(() => {
    setPendingChannel(null);
  }, [channel]);

  const current = wispUpdate?.current ?? hydrated?.current ?? null;
  const latest = wispUpdate?.latest ?? hydrated?.latest ?? null;
  const available = (wispUpdate?.available ?? hydrated?.available) === true;
  const lastChecked = wispUpdate?.lastChecked ?? hydrated?.lastChecked ?? null;

  const handleCheck = () => check.run(checkForWispUpdate);

  /* Save the channel, then check on it right away: the backend reads the
   * setting at check time, so the card would otherwise keep showing the
   * previous channel's result until the next hourly poll. */
  const handleChannelChange = (event) => {
    const next = event.target.value;
    setPendingChannel(next);
    check.run(async () => {
      try {
        await updateSettings({ updateChannel: next });
      } catch (err) {
        setPendingChannel(null);
        throw err;
      }
      await checkForWispUpdate();
    }, { key: 'channel' });
  };

  const beginInstall = () => {
    setConfirmForce(runningJobCount > 0);
    setConfirmOpen(true);
  };

  const doInstall = async () => {
    setConfirmOpen(false);
    setInstallSlow(false);
    setInstallStuck(false);
    setInstalling(true);
    setRestarting(false);
    setInstallTarget(latest);
    handedOverRef.current = false;
    /* The install is a job: it downloads and stages the release (progress in
     * the jobs tray), reports `restarting`, starts wisp-updater.service and
     * ends. The updater then stops this backend, so the job's stream may drop
     * before its result arrives; it reconnects, and the restarted backend no
     * longer knows the job: after `restarting`, JOB_GONE means the handover
     * happened. Before it, JOB_GONE is a failure to show.
     * Completion is detected below by polling /api/host wispVersion === target. */
    const started = await install.run(async () => {
      const { jobId } = await installWispUpdate({ force: confirmForce });
      setInstallJobId(jobId);
      try {
        await awaitJob(jobId);
      } catch (err) {
        if (!(err.code === CLIENT_CODES.JOB_GONE && handedOverRef.current)) throw err;
      }
    });
    if (started) {
      setRestarting(true);
    } else {
      setInstalling(false);
      setInstallTarget(null);
    }
  };

  /* Poll /api/host every 5s. Stop when wispVersion matches the target (then
   * reload the page to pick up the new frontend bundle). Show a "may be slow"
   * note after 12 failed polls (1 min); give up once the updater's own limit
   * (UPDATER_LIMIT_MS) has passed.
   * Failures are EXPECTED while the backend is restarting — we count them
   * against `consecutiveFailures` only, and reset on every successful poll. */
  const pollIntervalRef = useRef(null);
  useEffect(() => {
    if (!installing || !restarting || !installTarget) return undefined;

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
  }, [installing, restarting, installTarget]);

  const releaseUrl = repo && latest ? `https://github.com/${repo}/releases/tag/v${latest}` : null;
  const publishedLabel = formatRelativeTime(publishedAt);

  /* A command's error shows in the card's error slot, a failed read of the status as
   * the status record's error (a failed read of the settings is the page's notice). */
  let status = null;
  if ((check.errors.length > 0 || install.error) && !installing) {
    status = null;
  } else if (available && latest && !installing) {
    status = { type: 'warn', message: `v${latest} available` };
  } else if (lastChecked && !available && !installing && !checking) {
    status = { type: 'success', message: 'Up to date' };
  }

  const description = (
    <>
      {current ? (
        <>
          Currently running <span className="font-medium text-text-primary">v{current}</span>
          {available && latest && (
            <>
              {' '}· update <span className="font-medium text-text-primary">v{latest}</span> available
            </>
          )}
          .
        </>
      ) : (
        'Check for newer Wisp releases on GitHub.'
      )}
      {(pendingChannel ?? channel) === 'beta' && (
        <span className="block text-text-muted">Beta channel — pre-releases included.</span>
      )}
    </>
  );

  return (
    <>
      <UpdateCard
        title="Wisp update"
        titleIcon={<Rocket size={14} strokeWidth={2} />}
        description={description}
        available={available && !installing}
        onCheck={handleCheck}
        onUpdate={beginInstall}
        checking={checking}
        updating={installing}
        updateBusyLabel="Installing…"
        details={available && notes && !installing ? { label: 'Release notes', onClick: () => setDetailsOpen(true) } : null}
        status={status}
        commands={[check, install]}
        errorPrefix={(key, command) => (command === install ? 'Install' : key === 'channel' ? 'Channel change' : 'Check')}
        lastChecked={lastChecked}
        autoCheckLabel="Checked hourly"
      >
        <RecordError record={statusRecord} what="update status" className="mt-2" />
        <div className="mt-2 flex items-center gap-2 text-xs">
          <label htmlFor="wisp-update-channel" className="text-text-muted">
            Channel
          </label>
          <select
            id="wisp-update-channel"
            value={pendingChannel ?? channel}
            onChange={handleChannelChange}
            disabled={checking || installing}
            className="input-field h-7 w-auto py-0 text-xs"
          >
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </select>
        </div>

        {installing && (
          <div className="mt-3 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
              <span className="text-text-secondary">
                Installing v{installTarget}… backend will restart and the page will reload automatically.
              </span>
            </div>
            {installSlow && !installStuck && (
              <div className="mt-1 flex items-start gap-2 text-status-warning">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span>
                  Backend hasn't come back yet — install may be slow. Still trying.
                </span>
              </div>
            )}
            {/* Dismissing it stops waiting for the backend to come back. */}
            {installStuck && (
              <ErrorBanner
                className="mt-1"
                onDismiss={() => {
                  setInstallStuck(false);
                  setInstalling(false);
                  setRestarting(false);
                  setInstallTarget(null);
                }}
              >
                Install hasn't completed after 5 minutes. Check{' '}
                <code className="rounded-sm bg-surface-card px-1">sudo journalctl -u wisp-updater.service</code>{' '}
                on the server for details.
              </ErrorBanner>
            )}
          </div>
        )}
      </UpdateCard>

      <UpdateDetailsModal
        open={detailsOpen}
        title={`Release notes — v${latest ?? ''}`}
        subtitle={publishedLabel ? `Published ${publishedLabel}` : null}
        onClose={() => setDetailsOpen(false)}
        footer={releaseUrl && (
          <a
            href={releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-accent-text hover:underline"
          >
            <ExternalLink size={11} />
            View on GitHub
          </a>
        )}
      >
        {/* `dark:prose-invert`: the typography plugin's own colours are baked
            light greys (bold text near-black, bullets and rules pale) and none of
            them are tokens, so only the plugin's inverted set makes release notes
            readable on a dark card. */}
        <div className="prose prose-sm prose-slate dark:prose-invert max-w-none wrap-break-word text-text-secondary prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:text-text-primary prose-p:my-1.5 prose-li:my-0.5 prose-code:rounded-sm prose-code:bg-surface prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none prose-a:text-accent-text">
          {notes ? (
            <NotesHtml markdown={notes} />
          ) : (
            <p className="text-text-muted">No release notes.</p>
          )}
        </div>
      </UpdateDetailsModal>

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
          <p className="mt-2 text-status-warning">
            <span className="font-medium">{runningJobCount} background job(s) are still running.</span>{' '}
            They will be interrupted by the restart.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
