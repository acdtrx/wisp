import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { createContainer } from '../../api/containers.js';
import { getAppList } from '../../apps/appRegistry.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useJobProgress } from '../../hooks/useJobProgress.js';
import { autoFocusField } from '../../lib/focus.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import RadioPills from '../shared/RadioPills.jsx';
import ContainerImageField from './ContainerImageField.jsx';
import { containerDraftProblems, createContainerBody, defaultContainerDraft, draftWithApp } from './containerDraft.js';
import PageBody from '../shared/PageBody.jsx';
import Button, { ButtonLink } from '../shared/Button.jsx';
import { IconLink } from '../shared/IconButton.jsx';

const STEP_LABELS = {
  validating: 'Checking…',
  'using-local': 'Using the local image…',
  pulling: 'Pulling the image…',
  pulled: 'Image pulled',
  creating: 'Creating the container…',
  created: 'Finishing…',
};

const PLAIN = 'plain';

/**
 * New container (docs/specs/UI-CONTAINER.md, New container): a name, and either an
 * image or one of the apps, which fills in its image. The container is created
 * stopped; its page opens if the user is still here when the create ends.
 */
export default function CreateContainerPanel() {
  const navigate = useNavigate();
  const apps = getAppList();
  const [draft, setDraft] = useState(defaultContainerDraft);

  /* The create: a job, busy until it ended; its progress shows by Create. */
  const create = useCommand();
  const creating = create.busy;
  const [jobId, setJobId] = useState(null);
  const progress = useJobProgress(jobId);

  /* The create outlives this page (it stays in the jobs tray): its end opens the new
   * container only while the user is still here. */
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const problems = containerDraftProblems(draft);
  const blocked = Object.values(problems)[0] ?? null;
  const app = apps.find((a) => a.id === draft.app) ?? null;
  const imageEditable = !app || app.allowCustomImage;

  const options = [{ value: PLAIN, label: 'An image' }, ...apps.map((a) => ({ value: a.id, label: a.label }))];

  const submit = (e) => {
    e.preventDefault();
    if (blocked || creating) return;
    const body = createContainerBody(draft);
    create.run(() => createContainer(body), {
      job: true,
      onAck: (ack) => setJobId(ack.jobId),
      onDone: () => {
        if (mountedRef.current) navigate(`/container/${encodeURIComponent(body.name)}/overview`);
      },
    }).then(() => setJobId(null));
  };

  const step = progress?.step ?? (creating ? 'validating' : null);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-surface-border bg-surface-card px-4">
        <IconLink to="/host/overview" icon={ArrowLeft} label="Back" size="lg" />
        <h1 className="text-sm font-semibold text-text-primary">New container</h1>
      </div>

      <PageBody>
        <form onSubmit={submit} className="mx-auto max-w-xl space-y-4 rounded-card border border-surface-border bg-surface-card p-4 shadow-card">
          <FormField label="Name" htmlFor="new-container-name">
            <input
              id="new-container-name"
              ref={autoFocusField}
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              disabled={creating}
              maxLength={63}
              autoComplete="off"
              spellCheck={false}
              placeholder="web"
              className="input-field"
            />
          </FormField>

          <FormField label="Runs">
            <RadioPills
              options={options}
              value={draft.app ?? PLAIN}
              disabled={creating}
              onChange={(v) => setDraft((d) => draftWithApp(d, v === PLAIN ? null : v, apps))}
            />
          </FormField>

          <FormField
            label="Image"
            htmlFor="new-container-image"
            hint={app ? `${app.description}. The app sets up its own configuration.` : 'It stays stopped after it is created, so you can set it up before its first start.'}
          >
            <ContainerImageField
              id="new-container-image"
              value={draft.image}
              onChange={(image) => setDraft((d) => ({ ...d, image }))}
              disabled={creating || !imageEditable}
            />
          </FormField>

          <ErrorBanner error={create.error} onDismiss={create.dismiss} />

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-surface-border pt-3">
            {creating && step && (
              <span className="mr-auto flex min-w-0 items-center gap-2 text-xs text-text-muted" role="status">
                <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden />
                <span className="truncate" title={progress?.detail ?? undefined}>
                  {STEP_LABELS[step] ?? step}{progress?.detail ? ` ${progress.detail}` : ''}
                </span>
              </span>
            )}
            <ButtonLink to="/host/overview">Cancel</ButtonLink>
            <Button variant="primary" type="submit" busy={creating} disabled={!!blocked} title={blocked ?? undefined}>Create</Button>
          </div>
        </form>
      </PageBody>
    </div>
  );
}
