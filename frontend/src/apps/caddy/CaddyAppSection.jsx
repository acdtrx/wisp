/**
 * Caddy Reverse Proxy app configuration — single SectionCard:
 * TLS fields (domain, email, Cloudflare token) on one row,
 * then a Hosts sub-header with add button, then the hosts table.
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Globe, Eye, EyeOff, Server } from 'lucide-react';
import SectionCard from '../../components/shared/SectionCard.jsx';
import {
  DataTableScroll,
  DataTable,
  dataTableHeadRowClass,
  dataTableBodyRowClass,
  dataTableInteractiveRowClass,
  DataTableRowActions,
  DataTableTh,
  DataTableTd,
  dataTableEmptyCellClass,
} from '../../components/shared/DataTableChrome.jsx';
import { randomId } from '../../utils/randomId.js';

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

function parseAppConfig(config) {
  const ac = config?.appConfig || {};
  return {
    domain: ac.domain ?? '',
    email: ac.email ?? '',
    cloudflareApiToken: '',
    cloudflareTokenIsSet: ac.cloudflareApiToken?.isSet ?? false,
    cloudflareTokenDirty: false,
    hosts: (ac.hosts || []).map((h) => ({
      id: randomId(),
      subdomain: h.subdomain ?? '',
      target: h.target ?? '',
    })),
  };
}

export default function CaddyAppSection({ config, onSave }) {
  const [form, setForm] = useState(() => parseAppConfig(config));
  const [original, setOriginal] = useState(() => parseAppConfig(config));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    const parsed = parseAppConfig(config);
    setForm(parsed);
    setOriginal(parsed);
    setRequiresRestart(false);
    setError(null);
  }, [config?.appConfig?.domain, config?.appConfig?.email, JSON.stringify(config?.appConfig?.hosts), config?.appConfig?.cloudflareApiToken?.isSet]);

  const isDirty = useCallback(() => {
    if (form.domain !== original.domain) return true;
    if (form.email !== original.email) return true;
    if (form.cloudflareTokenDirty) return true;
    if (form.hosts.length !== original.hosts.length) return true;
    for (let i = 0; i < form.hosts.length; i++) {
      if (form.hosts[i].subdomain !== original.hosts[i]?.subdomain) return true;
      if (form.hosts[i].target !== original.hosts[i]?.target) return true;
    }
    return false;
  }, [form, original]);

  const updateField = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const updateHost = (id, field, value) => {
    setForm((prev) => ({
      ...prev,
      hosts: prev.hosts.map((h) => (h.id === id ? { ...h, [field]: value } : h)),
    }));
  };

  const addHost = () => {
    setForm((prev) => ({
      ...prev,
      hosts: [...prev.hosts, { id: randomId(), subdomain: '', target: '' }],
    }));
  };

  const removeHost = (id) => {
    setForm((prev) => ({
      ...prev,
      hosts: prev.hosts.filter((h) => h.id !== id),
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const appConfig = {
        domain: form.domain.trim(),
        email: form.email.trim(),
        hosts: form.hosts.map((h) => ({
          subdomain: h.subdomain.trim(),
          target: h.target.trim(),
        })),
      };
      if (form.cloudflareTokenDirty) {
        appConfig.cloudflareApiToken = form.cloudflareApiToken;
      } else if (!form.cloudflareTokenIsSet) {
        appConfig.cloudflareApiToken = '';
      }
      const result = await onSave(appConfig);
      if (result?.requiresRestart) setRequiresRestart(true);
    } catch (err) {
      setError(err?.detail || err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const dirty = isDirty();

  return (
    <SectionCard
      title="Caddy Reverse Proxy Configuration"
      titleIcon={<Globe size={14} />}
      onSave={handleSave}
      saving={saving}
      isDirty={dirty}
      requiresRestart={requiresRestart || config?.pendingRestart}
      error={error}
    >
      <div className="space-y-4">
        {/* TLS fields — single row */}
        <div className="flex items-end gap-4 flex-wrap">
          <div className="min-w-[140px] flex-1">
            <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5">
              Domain
            </label>
            <input
              type="text"
              className="input-field"
              placeholder="example.com"
              value={form.domain}
              onChange={(e) => updateField('domain', e.target.value)}
            />
          </div>

          <div className="min-w-[140px] flex-1">
            <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5">
              Email
            </label>
            <input
              type="email"
              className="input-field"
              placeholder="admin@example.com"
              value={form.email}
              onChange={(e) => updateField('email', e.target.value)}
            />
          </div>

          <div className="min-w-[160px] flex-1">
            <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5">
              Cloudflare API Token
            </label>
            <div className="flex items-stretch gap-2">
              <input
                type={showToken ? 'text' : 'password'}
                className="input-field flex-1"
                placeholder={form.cloudflareTokenIsSet && !form.cloudflareTokenDirty ? 'Set (leave empty to keep)' : 'Cloudflare API token'}
                value={form.cloudflareApiToken}
                onChange={(e) => {
                  updateField('cloudflareApiToken', e.target.value);
                  updateField('cloudflareTokenDirty', true);
                }}
              />
              <button
                type="button"
                className={iconBtn}
                onClick={() => setShowToken((v) => !v)}
                title={showToken ? 'Hide token' : 'Show token'}
                aria-label={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        </div>

        {/* Hosts sub-header */}
        <div className="flex items-center justify-between border-t border-surface-border pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Hosts</span>
          <button
            type="button"
            onClick={addHost}
            className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
            title="Add host"
            aria-label="Add host"
          >
            <Plus size={14} aria-hidden />
            <Server size={14} aria-hidden />
          </button>
        </div>

        {/* Hosts table */}
        <DataTableScroll>
          <DataTable minWidthRem={30}>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh dense className="w-1/3">Subdomain</DataTableTh>
                <DataTableTh dense>Target</DataTableTh>
                <DataTableTh dense align="right" className="w-12">Actions</DataTableTh>
              </tr>
            </thead>
            <tbody>
              {form.hosts.length === 0 && (
                <tr className={dataTableBodyRowClass}>
                  <td colSpan={3} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                    No hosts configured. Use the + button above to add a reverse proxy entry.
                  </td>
                </tr>
              )}
              {form.hosts.map((host) => (
                <tr key={host.id} className={dataTableInteractiveRowClass}>
                  <DataTableTd dense className="w-1/3">
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        className="input-field flex-1 min-w-0 text-xs"
                        placeholder="app"
                        value={host.subdomain}
                        onChange={(e) => updateHost(host.id, 'subdomain', e.target.value)}
                      />
                      <span className="text-[10px] text-text-muted whitespace-nowrap shrink-0">
                        .{form.domain || '…'}
                      </span>
                    </div>
                  </DataTableTd>
                  <DataTableTd dense>
                    <input
                      type="text"
                      className="input-field w-full min-w-0 text-xs"
                      placeholder="192.168.1.100 or 192.168.1.100:8080"
                      value={host.target}
                      onChange={(e) => updateHost(host.id, 'target', e.target.value)}
                    />
                  </DataTableTd>
                  <DataTableTd dense align="right">
                    <DataTableRowActions forceVisible>
                      <button
                        type="button"
                        className={iconBtn}
                        onClick={() => removeHost(host.id)}
                        title="Remove host"
                        aria-label="Remove host"
                      >
                        <Trash2 size={13} />
                      </button>
                    </DataTableRowActions>
                  </DataTableTd>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </DataTableScroll>
      </div>
    </SectionCard>
  );
}
