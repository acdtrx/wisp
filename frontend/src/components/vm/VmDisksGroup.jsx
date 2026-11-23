import { useState } from 'react';
import { Disc, Eject, HardDrive, Pencil, Plus, Trash2 } from 'lucide-react';

import { attachISO, detachDiskFromVM, ejectISO } from '../../api/vms.js';
import DiskEditorModal from './DiskEditorModal.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import GroupCard from '../shared/GroupCard.jsx';
import GroupItem from '../shared/GroupItem.jsx';
import ImageLibraryModal from '../shared/ImageLibraryModal.jsx';

/** The VM's disks and CDs take one change at a time (the VM's lock): one key. */
const MEDIA = 'media';

const DISK_LABEL = { sda: 'Disk 1', sdb: 'Disk 2' };
const CD_LABEL = { sdc: 'CD 1', sdd: 'CD 2' };
const BUS_LABEL = { virtio: 'VirtIO', scsi: 'VirtIO SCSI', sata: 'SATA', ide: 'IDE' };
const fileName = (path) => (path ? path.split('/').pop() : null);

/**
 * The VM's disks (Add, Edit size and bus, Remove: while it is shut off) and its CDs
 * (Insert, Change, Eject: at any time). The first boot setup's disk is that group's.
 * Every change is the page's command (`act`), one at a time.
 */
export default function VmDisksGroup({ config, busy, lockReason, act }) {
  const [editor, setEditor] = useState(null);
  /* The CD slot the image picker fills. */
  const [picking, setPicking] = useState(null);
  const disks = (config.disks ?? []).filter((d) => d.device === 'disk' && DISK_LABEL[d.slot]);
  const cds = (config.disks ?? []).filter((d) => d.device === 'cdrom' && CD_LABEL[d.slot]);
  const freeDisk = !disks.some((d) => d.slot === 'sda') ? 'sda' : !disks.some((d) => d.slot === 'sdb') ? 'sdb' : null;
  const freeCd = ['sdc', 'sdd'].find((slot) => !cds.find((c) => c.slot === slot)?.source) ?? null;
  const running = act.isBusy(MEDIA);
  const reason = busy ?? (running ? 'another change to the disks is being saved' : undefined);
  const diskReason = reason ?? lockReason;
  const runs = (about) => running && act.aboutOf(MEDIA) === about;

  const run = (fn, about) => act.run(fn, { key: MEDIA, about });
  const removeAbout = (slot) => `Couldn't remove ${DISK_LABEL[slot].toLowerCase()}`;
  const ejectAbout = (slot) => `Couldn't eject ${CD_LABEL[slot]}`;
  const insertAbout = (slot) => `Couldn't put the ISO in ${CD_LABEL[slot]}`;

  return (
    <GroupCard
      title="Disks and media"
      lockReason={lockReason ? 'Stop the VM to change its disks; CDs work at any time' : undefined}
      actions={(
        <>
          <GroupAction
            icon={Plus}
            kindIcon={HardDrive}
            variant="add"
            label="Add a disk"
            reason={diskReason ?? (freeDisk ? undefined : 'both disks are in use')}
            onClick={() => setEditor({ slot: freeDisk, editing: false })}
          />
          <GroupAction
            icon={Plus}
            kindIcon={Disc}
            variant="add"
            label="Insert an ISO"
            reason={reason ?? (freeCd ? undefined : 'both CDs hold an ISO')}
            onClick={() => setPicking(freeCd)}
          />
        </>
      )}
    >
      {disks.length === 0 && <p className="py-1 text-sm text-text-muted">No disks.</p>}
      {disks.map((d) => (
        <GroupItem
          key={d.slot}
          title={DISK_LABEL[d.slot]}
          detail={[d.sizeGiB != null ? `${d.sizeGiB} GB` : null, fileName(d.source), BUS_LABEL[d.bus] ?? d.bus].filter(Boolean).join(' · ')}
          actions={(
            <>
              <GroupAction icon={Pencil} label={`Edit ${DISK_LABEL[d.slot].toLowerCase()}`} reason={diskReason} onClick={() => setEditor({ slot: d.slot, editing: true, disk: d })} />
              <GroupAction
                icon={Trash2}
                variant="danger"
                label={`Remove ${DISK_LABEL[d.slot].toLowerCase()} (its file stays in the VM's folder)`}
                reason={diskReason}
                busy={runs(removeAbout(d.slot))}
                onClick={() => run(() => detachDiskFromVM(config.name, d.slot), removeAbout(d.slot))}
              />
            </>
          )}
        />
      ))}
      {cds.filter((c) => c.source).map((c) => (
        <GroupItem
          key={c.slot}
          title={CD_LABEL[c.slot]}
          detail={fileName(c.source)}
          actions={(
            <>
              <GroupAction icon={Disc} label={`Change the ISO in ${CD_LABEL[c.slot]}`} reason={reason} busy={runs(insertAbout(c.slot))} onClick={() => setPicking(c.slot)} />
              <GroupAction icon={Eject} label={`Eject ${CD_LABEL[c.slot]}`} reason={reason} busy={runs(ejectAbout(c.slot))} onClick={() => run(() => ejectISO(config.name, c.slot), ejectAbout(c.slot))} />
            </>
          )}
        />
      ))}

      <DiskEditorModal
        open={editor != null}
        vmName={config.name}
        slot={editor?.slot}
        editing={editor?.editing ?? false}
        disk={editor?.disk ?? null}
        defaultBus={disks[0]?.bus ?? 'virtio'}
        onClose={() => setEditor(null)}
      />
      <ImageLibraryModal
        open={picking != null}
        onClose={() => setPicking(null)}
        onSelect={(file) => {
          const slot = picking;
          run(() => attachISO(config.name, slot, file.name), insertAbout(slot));
        }}
        defaultFilter="iso"
      />
    </GroupCard>
  );
}
