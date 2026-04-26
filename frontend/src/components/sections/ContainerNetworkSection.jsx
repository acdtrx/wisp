import { useState, useEffect, useCallback } from 'react';
import {
  Network, Shuffle, Radio, Plus, X, Loader2,
} from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import { randomMac } from '../../utils/randomMac.js';
import Toggle from '../shared/Toggle.jsx';
import { getHostBridges } from '../../api/vms.js';
import { isVlanLikeBridgeName } from '../../utils/bridgeNames.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import {
  KNOWN_SERVICE_TYPES, DEFAULT_TXT_FOR_TYPE, isValidServiceType,
  parsePortLabel, suggestTypeForPort,
} from '../../lib/mdnsServiceTypes.js';
import {
  addContainerService, updateContainerService, removeContainerService,
} from '../../api/containers.js';

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
    txtPairs: Object.entries(txt).map(([k, v]) => [k, String(v)]),
  };
}

function draftFromService(service) {
  const isKnown = KNOWN_SERVICE_TYPES.some((k) => k.type === service.type);
  return {
    port: String(service.port),
    typeSelect: isKnown ? service.type : '__custom__',
    customType: isKnown ? '' : service.type,
    txtPairs: Object.entries(service.txt || {}).map(([k, v]) => [k, String(v)]),
  };
}

function effectiveType(draft) {
  return draft.typeSelect === '__custom__' ? draft.customType.trim() : draft.typeSelect;
}

function txtPairsToObject(pairs) {
  const out = {};
  for (const [k, v] of pairs) {
    const key = (k || '').trim();
    if (!key) continue;
    out[key] = v == null ? '' : String(v);
  }
  return out;
}

export default function ContainerNetworkSection({
  config, onSave, isCreating = false, onFormChange, onRefresh,
}) {
  const net = config.network || {};
  const isUp = config.state === 'running';
  const macEditable = isCreating ? false : !['running', 'paused', 'pausing'].includes(config.state);
  const interfaceEditable = isCreating ? true : !['running', 'paused', 'pausing'].includes(config.state);

  const [macDraft, setMacDraft] = useState(() => net.mac || '');
  const [originalMac, setOriginalMac] = useState(() => net.mac || '');
  const [interfaceDraft, setInterfaceDraft] = useState(() => net.interface || '');
  const [originalInterface, setOriginalInterface] = useState(() => net.interface || '');
  const [localDns, setLocalDns] = useState(() => config.localDns === true);
  const [originalLocalDns, setOriginalLocalDns] = useState(() => config.localDns === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [bridges, setBridges] = useState([]);

  /** Service editor strip state: { port: number|null, hasExisting, portEditable, draft, saving, error } */
  const [strip, setStrip] = useState(null);
  const servicesEnabled = !isCreating && config.localDns === true;
  const pills = isCreating ? [] : buildPortPills(config.exposedPorts, config.services);

  const closeStrip = useCallback(() => setStrip(null), []);
  useEscapeKey(strip != null && !strip.saving, closeStrip);
  const openStripForPort = (port, service) => {
    if (service) {
      setStrip({
        port, hasExisting: true, portEditable: false,
        draft: draftFromService(service), saving: false, error: null,
      });
    } else {
      const suggested = suggestTypeForPort(port);
      setStrip({
        port, hasExisting: false, portEditable: false,
        draft: emptyDraft(port, suggested), saving: false, error: null,
      });
    }
  };
  const openStripForAdd = () => {
    setStrip({
      port: null, hasExisting: false, portEditable: true,
      draft: emptyDraft(null, null), saving: false, error: null,
    });
  };
  const updateDraft = (patch) => {
    setStrip((s) => (s ? { ...s, draft: { ...s.draft, ...patch }, error: null } : s));
  };
  const setTypeChoice = (value) => {
    if (value === '__custom__') {
      setStrip((s) => (s ? { ...s, draft: { ...s.draft, typeSelect: value }, error: null } : s));
      return;
    }
    const defaults = DEFAULT_TXT_FOR_TYPE[value] || {};
    setStrip((s) => (s ? {
      ...s,
      error: null,
      draft: {
        ...s.draft,
        typeSelect: value,
        customType: '',
        // Replace TXT defaults only when user has not customized them
        txtPairs: s.draft.txtPairs.length === 0
          ? Object.entries(defaults).map(([k, v]) => [k, String(v)])
          : s.draft.txtPairs,
      },
    } : s));
  };
  const updateTxtPair = (idx, which, value) => {
    setStrip((s) => {
      if (!s) return s;
      const next = s.draft.txtPairs.map((pair, i) => (
        i === idx ? (which === 'k' ? [value, pair[1]] : [pair[0], value]) : pair
      ));
      return { ...s, draft: { ...s.draft, txtPairs: next }, error: null };
    });
  };
  const addTxtPair = () => {
    setStrip((s) => (s ? {
      ...s, draft: { ...s.draft, txtPairs: [...s.draft.txtPairs, ['', '']] }, error: null,
    } : s));
  };
  const removeTxtPair = (idx) => {
    setStrip((s) => (s ? {
      ...s,
      draft: { ...s.draft, txtPairs: s.draft.txtPairs.filter((_, i) => i !== idx) },
      error: null,
    } : s));
  };

  const handleStripSave = async () => {
    if (!strip) return;
    const type = effectiveType(strip.draft);
    if (!isValidServiceType(type)) {
      setStrip({ ...strip, error: 'Type must look like _name._tcp or _name._udp' });
      return;
    }
    let port = strip.port;
    if (strip.portEditable) {
      const parsed = parseInt(strip.draft.port, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        setStrip({ ...strip, error: 'Port must be an integer between 1 and 65535' });
        return;
      }
      port = parsed;
    }
    const txt = txtPairsToObject(strip.draft.txtPairs);
    setStrip({ ...strip, saving: true, error: null });
    try {
      if (strip.hasExisting) {
        await updateContainerService(config.name, port, { type, txt });
      } else {
        await addContainerService(config.name, { port, type, txt });
      }
      await onRefresh?.();
      setStrip(null);
    } catch (err) {
      setStrip((s) => (s ? { ...s, saving: false, error: err.message } : s));
    }
  };

  const handleStripDelete = async () => {
    if (!strip || !strip.hasExisting || strip.port == null) return;
    setStrip({ ...strip, saving: true, error: null });
    try {
      await removeContainerService(config.name, strip.port);
      await onRefresh?.();
      setStrip(null);
    } catch (err) {
      setStrip((s) => (s ? { ...s, saving: false, error: err.message } : s));
    }
  };

  const syncFromConfig = useCallback(() => {
    const m = config.network?.mac || '';
    setMacDraft(m);
    setOriginalMac(m);
    const iface = config.network?.interface || '';
    setInterfaceDraft(iface);
    setOriginalInterface(iface);
    const localDnsEnabled = config.localDns === true;
    setLocalDns(localDnsEnabled);
    setOriginalLocalDns(localDnsEnabled);
    setError(null);
    setRequiresRestart(false);
  }, [config.name, config.network?.mac, config.network?.interface, config.localDns]);

  useEffect(() => {
    syncFromConfig();
  }, [syncFromConfig]);

  useEffect(() => {
    setStrip(null);
  }, [config.name]);

  useEffect(() => {
    getHostBridges()
      .then((b) => {
        setBridges(b);
        if (isCreating && !config.network?.interface && b.length > 0) {
          const pick = b.find((name) => !isVlanLikeBridgeName(name)) ?? b[0];
          setInterfaceDraft(pick);
          setOriginalInterface(pick);
          onFormChange?.({
            network: {
              ...(config.network || {}),
              interface: pick,
            },
          });
        }
      })
      .catch(() => {
        setBridges([]);
      });
  }, [isCreating, config.network?.interface, onFormChange]);

  const norm = (s) => (s || '').trim().toLowerCase();
  const normInterface = (s) => (s || '').trim();
  const interfaceChanged = interfaceEditable && normInterface(interfaceDraft) !== normInterface(originalInterface);
  const isDirty = (macEditable && norm(macDraft) !== norm(originalMac))
    || interfaceChanged
    || localDns !== originalLocalDns;

  const applyInterfaceDraft = (value) => {
    setInterfaceDraft(value);
    if (!isCreating || !onFormChange) return;
    onFormChange({
      network: {
        ...(config.network || {}),
        interface: value || undefined,
      },
    });
  };

  const applyLocalDns = (value) => {
    setLocalDns(value);
    if (isCreating && onFormChange) onFormChange({ localDns: value });
  };

  const handleSave = async () => {
    if (isCreating) {
      setOriginalLocalDns(localDns);
      setOriginalInterface(interfaceDraft.trim());
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const changes = {};
      const networkChanges = {};
      if (macEditable && norm(macDraft) !== norm(originalMac)) {
        networkChanges.mac = macDraft.trim();
      }
      if (interfaceChanged) {
        const trimmed = interfaceDraft.trim();
        networkChanges.interface = trimmed || null;
      }
      if (Object.keys(networkChanges).length > 0) {
        changes.network = { ...net, ...networkChanges };
      }
      if (localDns !== originalLocalDns) {
        changes.localDns = localDns;
      }
      const result = await onSave(changes);
      if (result?.requiresRestart) setRequiresRestart(true);
      setOriginalMac(macDraft.trim());
      setOriginalInterface(interfaceDraft.trim());
      setOriginalLocalDns(localDns);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Network"
      titleIcon={<Network size={14} />}
      locked={!macEditable && !isCreating}
      lockedMessage="Stop the container to edit network settings"
      isDirty={isDirty}
      onSave={handleSave}
      saving={saving}
      error={error}
      requiresRestart={requiresRestart}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <Field label="Local DNS">
          <div className="flex h-8 items-center">
            <Toggle checked={localDns} onChange={applyLocalDns} />
          </div>
        </Field>
        <Field label="Interface">
          {interfaceEditable ? (
            <select
              value={interfaceDraft}
              onChange={(e) => applyInterfaceDraft(e.target.value)}
              className="input-field h-8 min-w-[130px] max-w-[180px]"
            >
              {!interfaceDraft && <option value="">Select…</option>}
              {bridges.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
              {interfaceDraft && !bridges.includes(interfaceDraft) && (
                <option value={interfaceDraft}>{interfaceDraft}</option>
              )}
            </select>
          ) : (
            <span className="text-sm text-text-primary font-mono">{net.interface || '—'}</span>
          )}
        </Field>
        {!isCreating ? (
          <>
        <Field label="Type">
          <span className="text-sm text-text-primary font-medium">{net.type || 'bridge'}</span>
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
          {macEditable ? (
            <>
              <input
                type="text"
                value={macDraft}
                onChange={(e) => setMacDraft(e.target.value)}
                className="input-field h-8 w-[200px] shrink-0 font-mono text-[11px]"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setMacDraft(randomMac())}
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
          </>
        ) : null}
      </div>
      {!isCreating && (pills.length > 0 || servicesEnabled) && (
        <div className="mt-3 pt-3 border-t border-surface-border">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-secondary">Exposed Ports</span>
            {!servicesEnabled && (
              <span className="text-[10px] text-text-muted">Enable Local DNS to advertise services</span>
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

          {strip && servicesEnabled && (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
              <div
                className="absolute inset-0 bg-black/30"
                onClick={() => { if (!strip.saving) closeStrip(); }}
              />
              <div
                className="relative z-10 mx-4 w-full max-w-xl rounded-card bg-surface-card shadow-lg"
                data-wisp-modal-root
              >
              <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
                <span className="text-sm font-semibold text-text-primary">
                  {strip.portEditable
                    ? 'Advertise new service'
                    : `${strip.hasExisting ? 'Service' : 'Advertise service'} for port ${strip.port}`}
                </span>
                <button
                  type="button"
                  onClick={closeStrip}
                  className="rounded-lg p-1 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
                  title="Close"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="px-4 py-4">

              {strip.error && (
                <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-status-stopped">
                  {strip.error}
                </div>
              )}

              <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                {strip.portEditable && (
                  <Field label="Port">
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={strip.draft.port}
                      onChange={(e) => updateDraft({ port: e.target.value })}
                      className="input-field h-8 w-[100px] font-mono text-xs"
                      placeholder="445"
                    />
                  </Field>
                )}
                <Field label="Type">
                  <select
                    value={strip.draft.typeSelect}
                    onChange={(e) => setTypeChoice(e.target.value)}
                    className="input-field h-8 min-w-[180px] text-xs"
                  >
                    {KNOWN_SERVICE_TYPES.map((t) => (
                      <option key={t.type} value={t.type}>{`${t.label} (${t.type})`}</option>
                    ))}
                    <option value="__custom__">Custom…</option>
                  </select>
                </Field>
                {strip.draft.typeSelect === '__custom__' && (
                  <Field label="Custom type">
                    <input
                      type="text"
                      value={strip.draft.customType}
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
                  {strip.draft.txtPairs.length === 0 && (
                    <span className="text-[11px] text-text-muted">No TXT records.</span>
                  )}
                  {strip.draft.txtPairs.map(([k, v], idx) => (
                    <div key={idx} className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={k}
                        onChange={(e) => updateTxtPair(idx, 'k', e.target.value)}
                        placeholder="key"
                        className="input-field h-7 w-[160px] shrink-0 font-mono text-[11px]"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <input
                        type="text"
                        value={v}
                        onChange={(e) => updateTxtPair(idx, 'v', e.target.value)}
                        placeholder="value"
                        className="input-field h-7 min-w-0 flex-1 font-mono text-[11px]"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() => removeTxtPair(idx)}
                        className="rounded p-1 text-text-muted hover:bg-surface-card hover:text-text-primary"
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

              <div className="mt-3 flex items-center justify-between gap-2">
                <div>
                  {strip.hasExisting && (
                    <button
                      type="button"
                      onClick={handleStripDelete}
                      disabled={strip.saving}
                      className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-medium text-status-stopped hover:bg-red-50 disabled:opacity-50"
                    >
                      Remove advertisement
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={closeStrip}
                    disabled={strip.saving}
                    className="rounded-md border border-surface-border px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:bg-surface-card disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleStripSave}
                    disabled={strip.saving}
                    className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  >
                    {strip.saving ? <Loader2 size={11} className="animate-spin" /> : null}
                    Save
                  </button>
                </div>
              </div>
              </div>
              </div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
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
