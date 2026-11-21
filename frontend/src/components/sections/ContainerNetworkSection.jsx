import { useState, useCallback } from 'react';
import {
  Network, Shuffle, Radio, Plus, X, Loader2,
} from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import Modal from '../shared/Modal.jsx';
import { randomMac } from '../../utils/randomMac.js';
import {
  KNOWN_SERVICE_TYPES, DEFAULT_TXT_FOR_TYPE, isValidServiceType,
  parsePortLabel, suggestTypeForPort,
} from '../../lib/mdnsServiceTypes.js';
import {
  addContainerService, updateContainerService, removeContainerService,
} from '../../api/containers.js';
import { awaitContainerChange } from '../../store/containerStore.js';
import RecordError from '../shared/RecordError.jsx';
import { bridgeChoice } from '../shared/bridgeChoice.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useForm } from '../../hooks/useForm.js';
import { changedFields, rowId } from '../../hooks/formState.js';
import CommandErrors from '../shared/CommandErrors.jsx';
import { EditorGone } from '../shared/FormModalChrome.jsx';
import { RECORD } from '../../store/records.js';
import { containerLocked } from '../../utils/workloadLocks.js';
import { useRecord } from '../../hooks/useRecord.js';

const NO_BRIDGES = [];

function serviceProto(type) {
  return typeof type === 'string' && type.endsWith('._udp') ? 'udp' : 'tcp';
}

/**
 * Merge EXPOSE-derived ports and persisted services into a single, deduped pill list.
 * EXPOSE-derived pills come first (in image order); user-added (service ports not in EXPOSE) come after, sorted by port.
 */
function buildPortPills(exposedPorts, services) {
  const exposedMap = new Map();
  for (const lbl of exposedPorts || []) {
    const p = parsePortLabel(lbl);
    if (p && !exposedMap.has(p)) exposedMap.set(p, lbl);
  }
  const serviceMap = new Map();
  for (const s of services || []) {
    serviceMap.set(s.port, s);
  }
  const out = [];
  for (const [port, label] of exposedMap) {
    out.push({ port, label, isUserAdded: false, service: serviceMap.get(port) || null });
  }
  const userAdded = [...serviceMap.entries()]
    .filter(([port]) => !exposedMap.has(port))
    .sort((a, b) => a[0] - b[0]);
  for (const [port, service] of userAdded) {
    out.push({ port, label: `${port}/${serviceProto(service.type)}`, isUserAdded: true, service });
  }
  return out;
}

function emptyDraft(port, suggestedType) {
  const type = suggestedType && isValidServiceType(suggestedType) ? suggestedType : '_http._tcp';
  const txt = DEFAULT_TXT_FOR_TYPE[type] || {};
  return {
    port: port == null ? '' : String(port),
    typeSelect: type,
    customType: '',
    txtPairs: txtRows(txt),
  };
}

function draftFromService(service) {
  const isKnown = KNOWN_SERVICE_TYPES.some((k) => k.type === service.type);
  return {
    port: String(service.port),
    typeSelect: isKnown ? service.type : '__custom__',
    customType: isKnown ? '' : service.type,
    txtPairs: txtRows(service.txt),
  };
}

function effectiveType(draft) {
  return draft.typeSelect === '__custom__' ? draft.customType.trim() : draft.typeSelect;
}

/** TXT records as the editor's rows: each a row of its own (`rowId`), never sent. */
function txtRows(txt) {
  return Object.entries(txt || {}).map(([k, v]) => ({ id: rowId(), k, v: String(v) }));
}

function txtPairsToObject(pairs) {
  const out = {};
  for (const { k, v } of pairs) {
    const key = (k || '').trim();
    if (!key) continue;
    out[key] = v == null ? '' : String(v);
  }
  return out;
}

/** The section's values from a container's config. */
const networkForm = (config) => ({ mac: config.network?.mac || '', interface: config.network?.interface || '' });

/** What Save sends: the MAC trimmed and in lower case, the interface trimmed (none: null). */
const networkSent = (f) => ({ mac: f.mac.trim().toLowerCase(), interface: f.interface.trim() || null });

const NETWORK_FIELDS = ['mac', 'interface'];

export default function ContainerNetworkSection({ config, onSave }) {
  const net = config.network || {};
  const isUp = config.state === 'running';
  /* The MAC and the interface are editable only when the container is stopped
   * (workloadLocks.js). */
  const editable = !containerLocked(config.state);

  const record = useRecord(RECORD.CONTAINER, config.name);
  /* Locked, both fields show the stored values and are neither sent nor a change. */
  const { form, setField, dirty, saving, save: saveForm } = useForm(record, networkForm, networkSent, { locked: editable ? [] : NETWORK_FIELDS });
  const save = useCommand();
  /* The restart badge follows the container's `pendingRestart`. */
  const requiresRestart = !!config.pendingRestart;
  /* The bridges a container can join, kept current as bridges are made or removed. */
  const bridgesRecord = useRecord(RECORD.HOST_BRIDGES);
  const bridges = bridgesRecord.data ?? NO_BRIDGES;

  /** The service editor open: `{ port, hasExisting, portEditable }` (port null: a new
   *  port is typed). The editor keeps its own values. */
  const [strip, setStrip] = useState(null);
  const servicesEnabled = config.localDns === true;
  const pills = buildPortPills(config.exposedPorts, config.services);

  const closeStrip = useCallback(() => setStrip(null), []);
  const openStripForPort = (port, service) => setStrip({ port, hasExisting: !!service, portEditable: false });
  const openStripForAdd = () => setStrip({ port: null, hasExisting: false, portEditable: true });

  const handleSave = () => saveForm((values, saved) => save.run(() => onSave({ network: changedFields(values, saved) })));

  return (
    <SectionCard
      title="Network"
      titleIcon={<Network size={14} />}
      locked={!editable}
      lockedMessage="Stop the container to edit network settings"
      isDirty={dirty}
      onSave={handleSave}
      saving={saving}
      commands={[save]}
      requiresRestart={requiresRestart}
    >
      <RecordError record={bridgesRecord} what="host bridges" className="mb-2" />
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <Field label="Interface">
          {editable ? (
            <select
              value={form.interface}
              onChange={(e) => setField('interface', e.target.value)}
              className="input-field h-8 min-w-[130px] max-w-[180px]"
            >
              {!form.interface && <option value="">{bridgeChoice(bridgesRecord)}</option>}
              {bridges.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
              {form.interface && !bridges.includes(form.interface) && (
                <option value={form.interface}>{form.interface}</option>
              )}
            </select>
          ) : (
            <span className="text-sm text-text-primary font-mono">{net.interface || '—'}</span>
          )}
        </Field>
        <Field label="Type">
          <span className="text-sm text-text-primary font-medium">{net.type}</span>
        </Field>
        {net.ip ? (
          <Field label="IP Address">
            <span className="text-sm text-text-primary font-mono">{net.ip}</span>
          </Field>
        ) : (
          <Field label="IP Address">
            <span className="text-sm text-text-muted">—</span>
          </Field>
        )}
        <Field label="MAC Address">
          {editable ? (
            <>
              <input
                type="text"
                value={form.mac}
                onChange={(e) => setField('mac', e.target.value)}
                className="input-field h-8 w-[200px] shrink-0 font-mono text-[11px]"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setField('mac', randomMac())}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-surface-border text-text-muted hover:bg-surface hover:text-text-secondary transition-colors duration-150"
                title="Randomize MAC"
              >
                <Shuffle size={13} />
              </button>
            </>
          ) : (
            <span className="text-sm text-text-primary font-mono">{net.mac || '—'}</span>
          )}
        </Field>
        <Field label="Status">
          <span className={`text-sm font-medium ${isUp ? 'text-status-running' : 'text-text-muted'}`}>
            {isUp ? 'Up' : 'Down'}
          </span>
        </Field>
      </div>
      {(pills.length > 0 || servicesEnabled) && (
        <div className="mt-3 pt-3 border-t border-surface-border">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-secondary">Exposed Ports</span>
            {!servicesEnabled && (
              <span className="text-[10px] text-text-muted">Enable Local DNS (General section) to advertise services</span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {pills.map(({ port, label, isUserAdded, service }) => {
              const isOpen = strip && !strip.portEditable && strip.port === port;
              const baseClasses = 'inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-xs font-mono text-text-primary border';
              const borderClass = isUserAdded ? 'border-dashed border-surface-border' : 'border-surface-border';
              const stateClass = isOpen ? 'ring-1 ring-accent' : '';
              const interactive = servicesEnabled
                ? 'cursor-pointer hover:bg-surface-card hover:border-text-muted'
                : 'opacity-70';
              return (
                <button
                  key={port}
                  type="button"
                  disabled={!servicesEnabled}
                  onClick={() => (isOpen ? closeStrip() : openStripForPort(port, service))}
                  className={`${baseClasses} ${borderClass} ${stateClass} ${interactive} transition-colors duration-150`}
                  title={service ? `${label} • ${service.type}` : label}
                >
                  <span>{label}</span>
                  {service && <Radio size={10} className="text-text-secondary" aria-hidden />}
                </button>
              );
            })}
            {servicesEnabled && (
              <button
                type="button"
                onClick={openStripForAdd}
                className={`inline-flex items-center gap-0.5 rounded-md border border-dashed border-surface-border bg-surface px-2 py-0.5 text-xs text-text-muted hover:text-text-primary hover:border-text-muted transition-colors duration-150 ${strip?.portEditable ? 'ring-1 ring-accent' : ''}`}
                title="Advertise on a custom port"
              >
                <Plus size={12} />
              </button>
            )}
          </div>

          <ServiceEditorModal strip={servicesEnabled ? strip : null} containerName={config.name} onClose={closeStrip} />
        </div>
      )}
    </SectionCard>
  );
}

/**
 * The editor of one advertised service (modal form editor): its record is the
 * container's config, the service picked by its port when it opens (`strip`); a new
 * one starts from the port's suggested type. It mounts when it opens.
 */
/** What a service editor's Save writes: its port (a form value: typed for a new port,
 *  else the port it opened on), its type, its TXT records. */
function serviceSent(d) {
  return { port: parseInt(d.port, 10), type: effectiveType(d), txt: txtPairsToObject(d.txtPairs) };
}

/** What a service editor's values lack to be saved, by the field each is about. */
function serviceProblems(d) {
  const { port, type } = serviceSent(d);
  const problems = {};
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.port = 'Port must be an integer between 1 and 65535';
  if (!isValidServiceType(type)) problems['typeSelect,customType'] = 'Type must look like _name._tcp or _name._udp';
  return problems;
}

function ServiceEditorModal(props) {
  return props.strip ? <ServiceEditor {...props} /> : null;
}

function ServiceEditor({ strip, containerName, onClose }) {
  const record = useRecord(RECORD.CONTAINER, containerName);
  const [blank] = useState(() => emptyDraft(strip.port, strip.port == null ? null : suggestTypeForPort(strip.port)));
  const { form: draft, setForm, dirty, saving, blocked: problem, save: saveForm } = useForm(
    record,
    (config) => {
      if (!strip.hasExisting) return blank;
      const service = (config.services || []).find((svc) => svc.port === strip.port);
      return service ? draftFromService(service) : null;
    },
    serviceSent,
    { problems: serviceProblems, creating: !strip.hasExisting },
  );
  const serviceCmd = useCommand();
  const busy = saving || serviceCmd.busy;

  const updateDraft = (patch) => setForm((d) => ({ ...d, ...patch }));
  const setTypeChoice = (value) => {
    if (value === '__custom__') {
      updateDraft({ typeSelect: value });
      return;
    }
    const defaults = DEFAULT_TXT_FOR_TYPE[value] || {};
    setForm((d) => ({
      ...d,
      typeSelect: value,
      customType: '',
      // Replace TXT defaults only when user has not customized them
      txtPairs: d.txtPairs.length === 0 ? txtRows(defaults) : d.txtPairs,
    }));
  };
  const updateTxtPair = (id, which, value) => setForm((d) => ({
    ...d,
    txtPairs: d.txtPairs.map((pair) => (pair.id === id ? { ...pair, [which]: value } : pair)),
  }));
  const addTxtPair = () => setForm((d) => ({ ...d, txtPairs: [...d.txtPairs, { id: rowId(), k: '', v: '' }] }));
  const removeTxtPair = (id) => setForm((d) => ({ ...d, txtPairs: d.txtPairs.filter((pair) => pair.id !== id) }));

  /* An edit needs a change that sends something; a new service only valid values (the
   * first problem that stands shows under them). */
  const canSave = draft != null && !problem && (!strip.hasExisting || dirty) && !busy;

  const handleSave = () => {
    if (!canSave) return;
    saveForm((values) => serviceCmd.run(() => (strip.hasExisting
      ? updateContainerService(containerName, values.port, { type: values.type, txt: values.txt })
      : addContainerService(containerName, values))))
      .then((ok) => { if (ok) onClose(); });
  };

  const handleDelete = () => serviceCmd.run(
    () => awaitContainerChange(containerName, () => removeContainerService(containerName, strip.port)),
    { key: 'delete', onDone: onClose },
  );

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose(); }}
      title={strip.portEditable
        ? 'Advertise new service'
        : `${strip.hasExisting ? 'Service' : 'Advertise service'} for port ${strip.port}`}
      size="xl"
      closeOnEscape={!busy}
    >
      {/* Its own delete closes the editor: "gone" is for a removal from elsewhere. */}
      {draft == null ? (serviceCmd.isBusy('delete') ? null : <EditorGone what="service" />) : (
      <>
      <CommandErrors className="mb-2" commands={[serviceCmd]} prefix={(key) => (key === 'delete' ? "Couldn't remove the service" : undefined)} />

      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        {strip.portEditable && (
          <Field label="Port">
            <input
              type="number"
              min={1}
              max={65535}
              value={draft.port}
              onChange={(e) => updateDraft({ port: e.target.value })}
              className="input-field h-8 w-[100px] font-mono text-xs"
              placeholder="445"
            />
          </Field>
        )}
        <Field label="Type">
          <select
            value={draft.typeSelect}
            onChange={(e) => setTypeChoice(e.target.value)}
            className="input-field h-8 min-w-[180px] text-xs"
          >
            {KNOWN_SERVICE_TYPES.map((t) => (
              <option key={t.type} value={t.type}>{`${t.label} (${t.type})`}</option>
            ))}
            <option value="__custom__">Custom…</option>
          </select>
        </Field>
        {draft.typeSelect === '__custom__' && (
          <Field label="Custom type">
            <input
              type="text"
              value={draft.customType}
              onChange={(e) => updateDraft({ customType: e.target.value })}
              placeholder="_xyz._tcp"
              className="input-field h-8 w-[180px] font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
        )}
      </div>

      <div className="mt-3">
        <span className="text-xs font-medium text-text-secondary">TXT records</span>
        <div className="mt-1 space-y-1">
          {draft.txtPairs.length === 0 && (
            <span className="text-[11px] text-text-muted">No TXT records.</span>
          )}
          {draft.txtPairs.map(({ id, k, v }) => (
            <div key={id} className="flex items-center gap-1.5">
              <input
                type="text"
                value={k}
                onChange={(e) => updateTxtPair(id, 'k', e.target.value)}
                placeholder="key"
                className="input-field h-7 w-[160px] shrink-0 font-mono text-[11px]"
                spellCheck={false}
                autoComplete="off"
              />
              <input
                type="text"
                value={v}
                onChange={(e) => updateTxtPair(id, 'v', e.target.value)}
                placeholder="value"
                className="input-field h-7 min-w-0 flex-1 font-mono text-[11px]"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => removeTxtPair(id)}
                className="rounded-sm p-2 lg:p-1 text-text-muted hover:bg-surface-card hover:text-text-primary"
                title="Remove TXT record"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addTxtPair}
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"
        >
          <Plus size={11} /> add TXT
        </button>
      </div>

      {problem && <p className="mt-2 text-[11px] text-text-muted">{problem}</p>}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div>
          {strip.hasExisting && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              className="rounded-md border border-status-stopped/30 px-2 py-1 text-[11px] font-medium text-status-stopped hover:bg-status-stopped-soft disabled:opacity-50"
            >
              Remove advertisement
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-surface-border px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:bg-surface-card disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            title={problem ?? undefined}
            className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
      </>
      )}
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium leading-none text-text-secondary">{label}</span>
      <div className="flex min-h-8 items-center gap-1.5">
        {children}
      </div>
    </div>
  );
}
