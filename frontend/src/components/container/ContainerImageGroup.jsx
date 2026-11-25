import { useState } from 'react';
import { Pencil, Undo2 } from 'lucide-react';

import { changedFields, NOTHING_CHANGED } from '../../hooks/editorValues.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import FormModal from '../shared/FormModal.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import IconButton from '../shared/IconButton.jsx';
import Card from '../shared/Card.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import { getAppEntry } from '../../apps/appRegistry.js';
import ContainerImageField from './ContainerImageField.jsx';
import { imageProblems, sameImage } from './containerForms.js';

/**
 * The image the container runs; a newer one pulled is applied by Restart. On an app
 * container whose image is not its app's own, Use the app's image names that image
 * and saves it, at once (docs/specs/UI-CONTAINER.md, Groups).
 */
export default function ContainerImageGroup({ config, busy, update }) {
  const [editing, setEditing] = useState(false);
  const useAppImage = useCommand();
  const appImage = getAppEntry(config.metadata?.app)?.defaultImage ?? null;
  const offerAppImage = !!appImage && !sameImage(config.image, appImage);
  return (
    <Card
      title="Image"
      actions={(
        <>
          {offerAppImage && (
            <IconButton
              icon={Undo2}
              label={`Use the app's image, ${appImage}`}
              reason={busy}
              busy={useAppImage.busy}
              onClick={() => useAppImage.run(() => update({ image: appImage }), { about: `Couldn't use the app's image ${appImage}` })}
            />
          )}
          <IconButton icon={Pencil} label="Change image" reason={busy} disabled={useAppImage.busy} onClick={() => setEditing(true)} />
        </>
      )}
      commands={[useAppImage]}
      errorPrefix={(_key, _cmd, about) => about}
    >
      <ValueRows
        rows={[
          { label: 'Image', value: config.image || '—', mono: true },
          {
            label: 'Updates',
            value: config.updateAvailable ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-status-warning-soft px-2 py-0.5 text-xs font-medium text-status-warning">Update available</span>
                <span className="text-xs text-text-muted">Restart to apply it.</span>
              </span>
            ) : null,
          },
          { label: "App's image", value: offerAppImage ? appImage : null, mono: true },
        ]}
      />
      {editing && <ImageEditor config={config} update={update} onClose={() => setEditing(false)} />}
    </Card>
  );
}

function ImageEditor({ config, update, onClose }) {
  const { form, start, setField, dirty } = useEditor(() => ({ image: config.image || '' }));
  const save = useCommand();
  const problem = Object.values(imageProblems(form))[0] ?? null;
  const blocked = problem ?? (dirty ? null : NOTHING_CHANGED);
  return (
    <FormModal
      title="Image"
      subtitle={config.name}
      save={save}
      blocked={blocked}
      onClose={onClose}
      onSubmit={() => save.run(() => update(changedFields({ image: form.image.trim() }, { image: start.image })))
        .then((ok) => { if (ok) onClose(); })}
    >
      <FormField
        label="Image"
        htmlFor="container-image"
        hint={config.state === 'stopped' ? 'Used at the next start.' : 'A running container keeps its image until it restarts.'}
      >
        <ContainerImageField id="container-image" value={form.image} onChange={(v) => setField('image', v)} />
      </FormField>
    </FormModal>
  );
}
