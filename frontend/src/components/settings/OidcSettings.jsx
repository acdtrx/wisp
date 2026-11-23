import { useState } from 'react';
import { Check, Copy, Pencil } from 'lucide-react';

import { updateOidcSettings } from '../../api/settings.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useRecord } from '../../hooks/useRecord.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import SettingsEditor from '../host/SettingsEditor.jsx';
import { callbackUrl, oidcForm, oidcProblem, oidcSent, secretOwed, ssoSwitchReason } from '../host/settingsForms.js';
import CommandErrors from '../shared/CommandErrors.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import IconButton from '../shared/IconButton.jsx';
import Card from '../shared/Card.jsx';
import GroupSwitch from '../shared/GroupSwitch.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import ValueRows from '../shared/ValueRows.jsx';

/** The callback URL, with a copy action: what the provider is told before anything else. */
function RedirectUri({ uri }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context): the text is selectable anyway */
    }
  };
  return (
    <span className="flex items-start gap-1">
      <span className="min-w-0 select-all break-all font-mono text-[13px]">{uri}</span>
      <IconButton icon={copied ? Check : Copy} label="Copy the redirect URI" size="sm" onClick={copy} />
    </span>
  );
}

/**
 * Single sign-on (docs/specs/AUTH.md, OIDC): the provider's issuer, the client and
 * whether its secret is set (never the secret), the redirect URI to register with the
 * provider, and SSO on or off as a switch, which waits for all three. The Edit holds the
 * provider's values; the secret field starts empty and keeps the stored one unless typed.
 */
export default function OidcSettings() {
  const record = useRecord(RECORD.SETTINGS);
  const [editing, setEditing] = useState(false);
  const act = useCommand();

  return (
    <Card
      title="Single sign-on"
      actions={<IconButton icon={Pencil} label="Edit the SSO provider" reason={record.data ? undefined : 'the settings are loading'} onClick={() => setEditing(true)} />}
    >
      <RecordGate record={record} what="settings">
        {(settings) => {
          const oidc = settings.oidc ?? {};
          return (
            <>
              <ValueRows
                rows={[
                  { label: 'Issuer', value: oidc.issuer || 'Not set', mono: !!oidc.issuer },
                  { label: 'Client ID', value: oidc.clientId || 'Not set', mono: !!oidc.clientId },
                  { label: 'Client secret', value: oidc.hasClientSecret ? 'Set' : 'Not set' },
                  { label: 'Redirect URI', value: <RedirectUri uri={callbackUrl(settings.advertisedUrl, window.location.origin)} /> },
                ]}
              />
              <p className="pb-1 text-[11px] text-text-muted">
                Register the redirect URI with your provider.
                {!settings.advertisedUrl && ' Set the advertised URL above to pin it when Wisp is reached under more than one address.'}
              </p>
              <GroupSwitch
                label="Sign in with SSO"
                hint={ssoSwitchReason(settings)
                  ? `${ssoSwitchReason(settings)}: then the sign-in page offers your provider.`
                  : 'When on, the sign-in page offers your provider, and goes straight to it. The password stays as a way in.'}
                checked={oidc.enabled === true}
                reason={ssoSwitchReason(settings) ?? undefined}
                busy={act.isBusy('enabled')}
                onChange={(on) => act.run(() => updateOidcSettings({ enabled: on }), {
                  key: 'enabled', about: `Couldn't turn single sign-on ${on ? 'on' : 'off'}`,
                })}
              />
              <CommandErrors className="mt-2" commands={[act]} prefix={(_key, _cmd, about) => about} />
              {editing && (
                <SettingsEditor
                  title="Single sign-on"
                  subtitle="OpenID Connect, e.g. Pocket ID"
                  initial={() => oidcForm(settings)}
                  sent={oidcSent}
                  problem={(form) => oidcProblem(form, settings)}
                  send={updateOidcSettings}
                  onClose={() => setEditing(false)}
                >
                  {({ form, setField }) => {
                    const owed = secretOwed(form, settings);
                    return (
                      <>
                        <FormField label="Issuer URL" htmlFor="sso-issuer" hint="Your provider’s base URL; its /.well-known/openid-configuration is read from there.">
                          <input id="sso-issuer" ref={autoFocusField} type="text" value={form.issuer} onChange={(e) => setField('issuer', e.target.value)} placeholder="https://id.example.com" autoComplete="off" spellCheck={false} className="input-field font-mono" />
                        </FormField>
                        <FormField label="Client ID" htmlFor="sso-client">
                          <input id="sso-client" type="text" value={form.clientId} onChange={(e) => setField('clientId', e.target.value)} placeholder="wisp" autoComplete="off" spellCheck={false} className="input-field font-mono" />
                        </FormField>
                        <FormField
                          label="Client secret"
                          htmlFor="sso-secret"
                          hint={owed
                            ? 'Required: the stored secret is kept only for the same issuer and client ID.'
                            : oidc.hasClientSecret ? 'Empty: keep the stored secret.' : null}
                        >
                          <input
                            id="sso-secret"
                            type="password"
                            value={form.clientSecret}
                            onChange={(e) => setField('clientSecret', e.target.value)}
                            placeholder={oidc.hasClientSecret && !owed ? 'Unchanged' : ''}
                            autoComplete="new-password"
                            aria-invalid={owed && !form.clientSecret}
                            className="input-field font-mono"
                          />
                        </FormField>
                        <p className="text-[11px] text-text-muted">
                          Wisp stays single-user: a sign-in through the provider counts as the password. Limit this client to your own user in the provider.
                        </p>
                      </>
                    );
                  }}
                </SettingsEditor>
              )}
            </>
          );
        }}
      </RecordGate>
    </Card>
  );
}
