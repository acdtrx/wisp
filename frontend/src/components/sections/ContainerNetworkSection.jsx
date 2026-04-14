import { useState, useEffect, useCallback } from 'react';
import { Network, Shuffle } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import { randomMac } from '../../utils/randomMac.js';
import Toggle from '../shared/Toggle.jsx';
import { getHostBridges } from '../../api/vms.js';
import { isVlanLikeBridgeName } from '../../utils/bridgeNames.js';

export default function ContainerNetworkSection({ config, onSave, isCreating = false, onFormChange }) {
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
      {!isCreating && config.exposedPorts?.length > 0 && (
        <div className="mt-3 pt-3 border-t border-surface-border">
          <span className="text-xs font-medium text-text-secondary">Exposed Ports</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {config.exposedPorts.map((p) => (
              <span key={p} className="inline-flex items-center rounded-md bg-surface px-2 py-0.5 text-xs font-mono text-text-primary border border-surface-border">
                {p}
              </span>
            ))}
          </div>
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
