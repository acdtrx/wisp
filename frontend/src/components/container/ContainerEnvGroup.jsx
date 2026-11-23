import { useMemo, useState } from 'react';
import { Braces, Pencil, Plus, Trash2 } from 'lucide-react';

import EnvVarEditorModal, { rowsFromEnv } from './EnvVarEditorModal.jsx';
import IconButton from '../shared/IconButton.jsx';
import Card from '../shared/Card.jsx';
import GroupItem from '../shared/GroupItem.jsx';

/**
 * The environment of a plain container: each variable, a secret's value never shown.
 * Add and Edit open the variable's editor; Remove acts at once (`act`, the page's
 * command, its error in the page's error display). Every change is an `envPatch`.
 */
export default function ContainerEnvGroup({ config, busy, act, update }) {
  /* The editor: the variable it edits, by key (null: a new one). */
  const [editor, setEditor] = useState(null);
  const rows = useMemo(() => rowsFromEnv(config.env), [config.env]);

  const remove = (row) => act.run(() => update({ envPatch: { [row.key]: null } }), {
    key: `env:${row.key}`, about: `Couldn't remove ${row.key}`,
  });

  return (
    <Card
      title="Environment"
      actions={(
        <IconButton icon={Plus} kindIcon={Braces} variant="primary" label="Add variable" reason={busy} onClick={() => setEditor({ key: null })} />
      )}
    >
      {rows.length === 0 && <p className="py-1 text-sm text-text-muted">No variables.</p>}
      {rows.map((row) => {
        const removing = act.isBusy(`env:${row.key}`);
        return (
          <GroupItem
            key={row.key}
            title={row.key}
            mono
            detail={row.secret ? (row.isSet ? 'Secret' : 'Secret, not set') : (row.value === '' ? 'Empty' : row.value)}
            actions={(
              <>
                <IconButton icon={Pencil} label={`Edit ${row.key}`} reason={busy} disabled={removing} onClick={() => setEditor({ key: row.key })} />
                <IconButton icon={Trash2} variant="danger" label={`Remove ${row.key}`} reason={busy} busy={removing} onClick={() => remove(row)} />
              </>
            )}
          />
        );
      })}
      <EnvVarEditorModal
        open={editor != null}
        env={config.env}
        rowKey={editor?.key ?? null}
        onSubmit={({ envPatch }) => update({ envPatch })}
        onClose={() => setEditor(null)}
      />
    </Card>
  );
}
