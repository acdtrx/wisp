import { useState } from 'react';
import { Plus, X } from 'lucide-react';

import { addContainerService, updateContainerService } from '../../api/containers.js';
import { rowId, NOTHING_CHANGED } from '../../hooks/editorValues.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { KNOWN_SERVICE_TYPES } from '../../lib/mdnsServiceTypes.js';
import FormModal from '../shared/FormModal.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import {
  CUSTOM_TYPE, OTHER_PORT, serviceForm, serviceProblem, serviceSent, unannouncedPorts, withPortChoice, withType,
} from './containerServices.js';
import IconButton from '../shared/IconButton.jsx';

/**
 * The editor of one service the container announces (`service`; null: a new one). A
 * new one's port is one of the image's exposed ports not announced yet, or typed; an
 * existing one's port is fixed (remove it and add another to move it).
 */
export default function ContainerServiceEditorModal({ config, service, onClose }) {
  /* The ports, as the editor opened. */
  const [opened] = useState(() => ({
    offered: unannouncedPorts(config.exposedPorts, config.services),
    taken: (config.services ?? []).map((s) => s.port).filter((p) => p !== service?.port),
  }));
  const { form, setForm, dirty } = useEditor(() => serviceForm(service, opened.offered));
  const save = useCommand();
  const isNew = service == null;
  const problem = serviceProblem(form, opened.taken);
  const blocked = problem ?? (isNew || dirty ? null : NOTHING_CHANGED);

  const setTxt = (id, key, value) => setForm((f) => ({ ...f, txt: f.txt.map((r) => (r.id === id ? { ...r, [key]: value } : r)) }));

  const submit = () => {
    const values = serviceSent(form);
    save.run(() => (isNew
      ? addContainerService(config.name, values)
      : updateContainerService(config.name, service.port, { type: values.type, txt: values.txt })))
      .then((ok) => { if (ok) onClose(); });
  };

  return (
    <FormModal
      title={isNew ? 'Announce a service' : `Service on port ${service.port}`}
      subtitle={`${config.name}.local`}
      saveLabel={isNew ? 'Announce' : 'Save'}
      save={save}
      blocked={blocked}
      onClose={onClose}
      onSubmit={submit}
      size="md"
    >
      {isNew && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Port" htmlFor="service-port-choice">
            <select
              id="service-port-choice"
              value={form.portChoice}
              onChange={(e) => setForm((f) => withPortChoice(f, e.target.value))}
              className="input-field"
            >
              {opened.offered.map((p) => <option key={p} value={String(p)}>{p} (the image exposes it)</option>)}
              <option value={OTHER_PORT}>Another port…</option>
            </select>
          </FormField>
          {form.portChoice === OTHER_PORT && (
            <FormField label="Port number" htmlFor="service-port">
              <input
                id="service-port"
                type="text"
                inputMode="numeric"
                value={form.port}
                onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                placeholder="8080"
                className="input-field font-mono"
              />
            </FormField>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Type" htmlFor="service-type">
          <select id="service-type" value={form.typeSelect} onChange={(e) => setForm((f) => withType(f, e.target.value))} className="input-field">
            {KNOWN_SERVICE_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label} ({t.type})</option>)}
            <option value={CUSTOM_TYPE}>Another type…</option>
          </select>
        </FormField>
        {form.typeSelect === CUSTOM_TYPE && (
          <FormField label="Type name" htmlFor="service-custom-type">
            <input
              id="service-custom-type"
              type="text"
              value={form.customType}
              onChange={(e) => setForm((f) => ({ ...f, customType: e.target.value }))}
              placeholder="_name._tcp"
              spellCheck={false}
              autoComplete="off"
              className="input-field font-mono"
            />
          </FormField>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-text-secondary">TXT records</span>
          <IconButton icon={Plus} label="Add a TXT record" size="sm" onClick={() => setForm((f) => ({ ...f, txt: [...f.txt, { id: rowId(), k: '', v: '' }] }))} />
        </div>
        {form.txt.length === 0 && <p className="text-xs text-text-muted">No TXT records.</p>}
        <div className="space-y-1.5">
          {form.txt.map((r) => (
            <div key={r.id} className="flex items-center gap-1.5">
              <input
                type="text"
                value={r.k}
                onChange={(e) => setTxt(r.id, 'k', e.target.value)}
                placeholder="key"
                aria-label="TXT key"
                spellCheck={false}
                autoComplete="off"
                className="input-field w-28 shrink-0 font-mono sm:w-36"
              />
              <input
                type="text"
                value={r.v}
                onChange={(e) => setTxt(r.id, 'v', e.target.value)}
                placeholder="value"
                aria-label="TXT value"
                spellCheck={false}
                autoComplete="off"
                className="input-field min-w-0 flex-1 font-mono"
              />
              <IconButton icon={X} label="Remove this TXT record" variant="danger" size="sm" onClick={() => setForm((f) => ({ ...f, txt: f.txt.filter((x) => x.id !== r.id) }))} />
            </div>
          ))}
        </div>
      </div>
      {problem && form.port.trim() !== '' && <p className="text-[11px] text-text-muted">{problem}</p>}
    </FormModal>
  );
}
