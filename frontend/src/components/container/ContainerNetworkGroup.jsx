import { useState } from 'react';
import { Pencil, Plus, Radio, Shuffle, Trash2 } from 'lucide-react';

import { removeContainerService } from '../../api/containers.js';
import { changedFields } from '../../hooks/editorValues.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import { randomMac } from '../../utils/randomMac.js';
import { bridgeChoice } from '../shared/bridgeChoice.js';
import FormModal from '../shared/FormModal.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import Card from '../shared/Card.jsx';
import GroupItem from '../shared/GroupItem.jsx';
import GroupSwitch from '../shared/GroupSwitch.jsx';
import RecordError from '../shared/RecordError.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import ContainerServiceEditorModal from './ContainerServiceEditorModal.jsx';
import { networkForm, networkProblems, networkSent } from './containerForms.js';
import { serviceTypeText } from './containerServices.js';

const NO_BRIDGES = [];

/**
 * How the container sits on the network: the switch that announces it as
 * `<name>.local` (acts at once), its bridge and MAC (Edit, only while it is stopped),
 * and the services it announces under that name (Add, Edit, Remove while the local name
 * is on).
 */
export default function ContainerNetworkGroup({ config, busy, locked, act, update }) {
  const [editing, setEditing] = useState(false);
  /* The service editor: the service it edits (null: a new one). */
  const [service, setService] = useState(undefined);
  const services = config.services ?? [];
  const localName = config.localDns === true;
  const localNameOff = localName ? undefined : 'turn on the local name first';

  const toggleLocalName = (on) => act.run(() => update({ localDns: on }), {
    key: 'localDns', about: `Couldn't turn the local name ${on ? 'on' : 'off'}`,
  });
  const removeService = (s) => act.run(() => removeContainerService(config.name, s.port), {
    key: `service:${s.port}`, about: `Couldn't remove the service on port ${s.port}`,
  });

  return (
    <Card
      title="Network"
      lockReason={locked ? 'Stop the container to change its bridge or MAC address' : undefined}
      actions={(
        <>
          <GroupAction icon={Plus} kindIcon={Radio} variant="add" label="Announce a service" reason={busy ?? localNameOff} onClick={() => setService(null)} />
          <GroupAction icon={Pencil} label="Edit network" reason={busy ?? (locked ? 'stop the container first' : undefined)} onClick={() => setEditing(true)} />
        </>
      )}
    >
      <GroupSwitch
        label={`Announce as ${config.name}.local`}
        hint="Other devices on the network reach it by this name."
        checked={localName}
        onChange={toggleLocalName}
        busy={act.isBusy('localDns')}
        reason={busy}
      />
      <div className="border-t border-surface-border pt-1.5">
        <ValueRows
          rows={[
            { label: 'Bridge', value: config.network?.interface || '—' },
            { label: 'MAC address', value: config.network?.mac || '—', mono: true },
          ]}
        />
      </div>
      <div className="mt-1.5 border-t border-surface-border pt-2">
        <div className="text-xs font-medium text-text-muted">Services it announces</div>
        {services.length === 0 && (
          <p className="py-1 text-sm text-text-muted">{localName ? 'None.' : 'None. Turn on the local name to announce one.'}</p>
        )}
        <div>
          {[...services].sort((a, b) => a.port - b.port).map((s) => {
            const removing = act.isBusy(`service:${s.port}`);
            return (
              <GroupItem
                key={s.port}
                title={`${serviceTypeText(s.type)} on port ${s.port}`}
                detail={Object.keys(s.txt ?? {}).length > 0
                  ? `${s.type} · ${Object.entries(s.txt).map(([k, v]) => `${k}=${v}`).join(', ')}`
                  : s.type}
                actions={(
                  <>
                    <GroupAction icon={Pencil} label={`Edit the service on port ${s.port}`} reason={busy ?? localNameOff} disabled={removing} onClick={() => setService(s)} />
                    <GroupAction icon={Trash2} variant="danger" label={`Remove the service on port ${s.port}`} reason={busy} busy={removing} onClick={() => removeService(s)} />
                  </>
                )}
              />
            );
          })}
        </div>
      </div>

      {editing && <NetworkEditor config={config} update={update} onClose={() => setEditing(false)} />}
      {service !== undefined && (
        <ContainerServiceEditorModal config={config} service={service} onClose={() => setService(undefined)} />
      )}
    </Card>
  );
}

function NetworkEditor({ config, update, onClose }) {
  const { form, start, setField, dirty } = useEditor(() => networkForm(config));
  const save = useCommand();
  const bridges = useRecord(RECORD.HOST_BRIDGES);
  const bridgeList = bridges.data ?? NO_BRIDGES;
  const problems = networkProblems(form);
  const blocked = Object.values(problems)[0] ?? (dirty ? null : 'Nothing changed');

  return (
    <FormModal
      title="Network"
      subtitle={config.name}
      save={save}
      blocked={blocked}
      onClose={onClose}
      onSubmit={() => save.run(() => update({ network: changedFields(networkSent(form), networkSent(start)) }))
        .then((ok) => { if (ok) onClose(); })}
    >
      <RecordError record={bridges} what="host bridges" />
      <FormField label="Bridge" htmlFor="container-bridge">
        <select id="container-bridge" value={form.interface} onChange={(e) => setField('interface', e.target.value)} className="input-field">
          {!form.interface && <option value="">{bridgeChoice(bridges)}</option>}
          {bridgeList.map((b) => <option key={b} value={b}>{b}</option>)}
          {form.interface && !bridgeList.includes(form.interface) && <option value={form.interface}>{form.interface}</option>}
        </select>
      </FormField>
      <FormField label="MAC address" htmlFor="container-mac" hint={problems.mac && form.mac.trim() !== '' ? problems.mac : 'Its DHCP lease follows the MAC address.'}>
        <div className="flex items-stretch gap-2">
          <input
            id="container-mac"
            type="text"
            value={form.mac}
            onChange={(e) => setField('mac', e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="input-field min-w-0 flex-1 font-mono"
          />
          <button
            type="button"
            onClick={() => setField('mac', randomMac())}
            className="inline-flex shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary transition-colors duration-150 hoverable:hover:bg-surface-sidebar"
            title="A new random MAC address"
            aria-label="A new random MAC address"
          >
            <Shuffle size={15} aria-hidden />
          </button>
        </div>
      </FormField>
    </FormModal>
  );
}
