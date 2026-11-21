import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';

import { fetchGithubKeys } from '../../api/vms.js';
import { useCommand } from '../../hooks/useCommand.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';

/**
 * A VM's SSH public key for its first boot setup: typed or pasted, or taken from a
 * GitHub user's keys (the first, or one picked when there are several). `onChange`
 * gets `{ sshKey, sshKeySource }`: `manual` for a typed key, `github:<user>` for one
 * taken from GitHub.
 */
export default function SshKeyField({ idPrefix, sshKey, onChange }) {
  const lookup = useCommand();
  const [github, setGithub] = useState({ user: '', keys: [] });

  const pick = (key, user) => onChange({ sshKey: key, sshKeySource: `github:${user}` });
  const fetchKeys = () => {
    const user = github.user.trim();
    if (!user) return;
    lookup.run(() => fetchGithubKeys(user), {
      onDone: (data) => {
        const keys = data.keys || [];
        setGithub((g) => ({ ...g, keys }));
        if (keys.length > 0) pick(keys[0], user);
      },
    });
  };

  return (
    <>
      <FormField label="SSH public key" htmlFor={`${idPrefix}-key`}>
        <input
          id={`${idPrefix}-key`}
          type="text"
          value={sshKey}
          onChange={(e) => onChange({ sshKey: e.target.value, sshKeySource: 'manual' })}
          placeholder="ssh-ed25519 AAAA… name"
          autoComplete="off"
          spellCheck={false}
          className="input-field font-mono"
        />
      </FormField>
      <FormField label="Or take it from GitHub" htmlFor={`${idPrefix}-github`}>
        <div className="flex items-stretch gap-2">
          <input
            id={`${idPrefix}-github`}
            type="text"
            value={github.user}
            onChange={(e) => setGithub({ user: e.target.value, keys: [] })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); fetchKeys(); } }}
            placeholder="GitHub user"
            autoComplete="off"
            spellCheck={false}
            className="input-field min-w-0 flex-1"
          />
          <button
            type="button"
            onClick={fetchKeys}
            disabled={lookup.busy || !github.user.trim()}
            className="inline-flex shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary disabled:opacity-40"
            title="Fetch the user’s keys from GitHub"
            aria-label="Fetch the user’s keys from GitHub"
          >
            {lookup.busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <KeyRound size={15} aria-hidden />}
          </button>
        </div>
        {github.keys.length > 1 && (
          <div className="mt-2 space-y-1">
            <p className="text-[11px] text-text-muted">{github.keys.length} keys found; pick one:</p>
            {github.keys.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => pick(key, github.user.trim())}
                className={`block w-full truncate rounded-md border px-2.5 py-1 text-left font-mono text-[11px] ${sshKey === key ? 'border-accent bg-accent-soft text-accent-text' : 'border-surface-border text-text-secondary'}`}
              >
                {key}
              </button>
            ))}
          </div>
        )}
        <ErrorBanner className="mt-2" error={lookup.error} prefix="GitHub keys" onDismiss={lookup.dismiss} />
      </FormField>
    </>
  );
}
