import { useState } from 'react';
import { Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';

import { removeCertificate, renewCertificate, saveCertificate } from '../../api/settings.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useRunningJob } from '../../hooks/useFollowJob.js';
import { useJobProgress } from '../../hooks/useJobProgress.js';
import { useRecord } from '../../hooks/useRecord.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import { formatDay, formatRelativeTime } from '../../utils/formatters.js';
import SettingsEditor from '../host/SettingsEditor.jsx';
import { certificateBody, certificateForm, certificateProblem, certificateSent } from '../host/settingsForms.js';
import Card from '../shared/Card.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import IconButton from '../shared/IconButton.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import { JOB_KIND } from '../../../../shared/wireNames.js';

const PURPOSE = 'Wisp gets one certificate for a domain and all its subdomains from Let’s Encrypt, '
  + 'proving the domain through Cloudflare’s DNS, and renews it. The Caddy apps serve their sites with it.';

/** What the job is doing, by its step (docs/specs/CERTIFICATES.md, The job). */
const STEP_TEXT = {
  account: 'registering with Let’s Encrypt',
  order: 'ordering',
  dns: 'writing the DNS records',
  validate: 'waiting for Let’s Encrypt to check them',
  finalize: 'finalizing',
  deliver: 'storing it',
};

/** The certificate's state: getting it, the one Wisp holds, the last attempt's failure. */
function CertificateState({ record, jobRunning, step }) {
  const { certificate, lastAttempt } = record;
  const failed = lastAttempt?.error ?? null;
  return (
    <div className="space-y-1 pb-1 text-sm">
      {jobRunning && (
        <p className="text-status-transition">
          Getting the certificate{STEP_TEXT[step] ? `: ${STEP_TEXT[step]}` : ''}…
        </p>
      )}
      {certificate ? (
        <p className="text-text-secondary">
          Valid until <span className="text-text-primary">{formatDay(certificate.validUntil)}</span>,
          renewing around {formatDay(certificate.renewAt)}
          {certificate.domain !== record.domain && (
            <>; it is for <span className="font-mono text-[13px]">{certificate.domain}</span> and serves until the new domain’s is issued</>
          )}
          .
        </p>
      ) : (
        !jobRunning && !failed && <p className="text-text-muted">No certificate yet.</p>
      )}
      {failed && (
        <p className="text-status-stopped">
          The last attempt failed {formatRelativeTime(lastAttempt.at)}: {failed.detail}
          {certificate && <span className="text-text-secondary"> The certificate above still serves.</span>}
        </p>
      )}
    </div>
  );
}

/**
 * The host's certificate (docs/specs/UI-HOST.md, App Config): the domain and whether a
 * Cloudflare token is set, with an Edit; the certificate's state; Renew now and Remove.
 * With no setting it says what the certificate is for and offers Set up.
 */
export default function CertificateSettings() {
  const record = useRecord(RECORD.CERTIFICATE);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const act = useCommand();
  const runningJobId = useRunningJob((job) => job.kind === JOB_KIND.CERTIFICATE_ISSUE);
  const step = useJobProgress(runningJobId)?.step ?? null;
  const data = record.data;
  const isSet = !!data?.domain;
  const loadingReason = data ? undefined : 'the certificate is loading';

  const renew = () => act.run(renewCertificate, { key: 'renew', job: true, about: 'Couldn’t get the certificate' });
  const remove = () => {
    setRemoving(false);
    act.run(removeCertificate, { key: 'remove', about: 'Couldn’t remove the certificate' });
  };

  const actions = isSet ? (
    <>
      <IconButton
        icon={RefreshCw}
        label="Renew now"
        busy={act.isBusy('renew')}
        reason={runningJobId && !act.isBusy('renew') ? 'the certificate is being got' : undefined}
        onClick={renew}
      />
      <IconButton icon={Pencil} label="Edit the certificate's domain and token" onClick={() => setEditing(true)} />
      <IconButton icon={Trash2} label="Remove the certificate" variant="danger" busy={act.isBusy('remove')} onClick={() => setRemoving(true)} />
    </>
  ) : (
    <IconButton icon={Plus} kindIcon={ShieldCheck} label="Set up the certificate" variant="primary" reason={loadingReason} onClick={() => setEditing(true)} />
  );

  return (
    <Card title="Certificate" actions={actions} commands={[act]} errorPrefix={(_key, _cmd, about) => about}>
      <RecordGate record={record} what="certificate">
        {(rec) => (rec.domain ? (
          <>
            <ValueRows
              rows={[
                { label: 'Domain', value: rec.domain, mono: true },
                { label: 'Cloudflare token', value: rec.tokenSet ? 'Set' : 'Not set' },
              ]}
            />
            <CertificateState record={rec} jobRunning={!!runningJobId} step={step} />
          </>
        ) : (
          <p className="py-1 text-sm text-text-secondary">{PURPOSE}</p>
        ))}
      </RecordGate>
      {editing && data && (
        <SettingsEditor
          title="Certificate"
          subtitle={isSet ? data.domain : 'Let’s Encrypt, through Cloudflare’s DNS'}
          initial={() => certificateForm(data)}
          sent={certificateSent}
          problem={(form) => certificateProblem(form, data)}
          send={(_changed, form) => saveCertificate(certificateBody(form))}
          onClose={() => setEditing(false)}
        >
          {({ form, setField }) => (
            <>
              <FormField
                label="Domain"
                htmlFor="certificate-domain"
                hint="A Cloudflare zone, or a name inside one. The certificate covers it and every name directly under it."
              >
                <input
                  id="certificate-domain"
                  ref={autoFocusField}
                  type="text"
                  value={form.domain}
                  onChange={(e) => setField('domain', e.target.value)}
                  placeholder="home.example.com"
                  autoComplete="off"
                  spellCheck={false}
                  className="input-field font-mono"
                />
              </FormField>
              <FormField
                label="Cloudflare API token"
                htmlFor="certificate-token"
                hint={`It needs Zone:Read and DNS:Edit on the domain's zone.${data.tokenSet ? ' Empty: keep the stored token.' : ''}`}
              >
                <input
                  id="certificate-token"
                  type="password"
                  value={form.cloudflareApiToken}
                  onChange={(e) => setField('cloudflareApiToken', e.target.value)}
                  placeholder={data.tokenSet ? 'Unchanged' : ''}
                  autoComplete="new-password"
                  className="input-field font-mono"
                />
              </FormField>
            </>
          )}
        </SettingsEditor>
      )}
      <ConfirmDialog
        open={removing}
        title="Remove the certificate"
        confirmLabel="Remove"
        onConfirm={remove}
        onCancel={() => setRemoving(false)}
      >
        Remove the domain, the Cloudflare token, the certificate and its key? The sites of the Caddy apps stop being served.
      </ConfirmDialog>
    </Card>
  );
}
