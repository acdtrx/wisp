import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

import { useVmStore } from '../../store/vmStore.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { JOB_KIND } from '../../api/jobProgress.js';
import { createVM, getHostBridges } from '../../api/vms.js';
import GeneralSection from '../sections/GeneralSection.jsx';
import DisksSection from '../sections/DisksSection.jsx';
import AdvancedSection from '../sections/AdvancedSection.jsx';
import VmNetworkInterfacesSection from '../sections/VmNetworkInterfacesSection.jsx';
import CloudInitSection from '../sections/CloudInitSection.jsx';

const STEP_LABELS = {
  validating: 'Validating…',
  copying: 'Copying image…',
  resizing: 'Resizing disk…',
  'creating-disk': 'Creating disk…',
  cloudinit: 'Generating cloud-init ISO…',
  defining: 'Defining VM…',
  done: 'Done ✓',
  error: 'Error',
};

const defaultForm = () => ({
  name: '',
  osType: 'Linux',
  osVariant: 'generic',
  vcpus: 2,
  memoryMiB: 2048,
  autostart: false,
  firmware: 'uefi',
  machineType: 'q35',
  cpuMode: 'host-passthrough',
  videoDriver: 'virtio',
  graphicsType: 'vnc',
  bootOrder: ['hd', 'cdrom', 'network'],
  bootMenu: true,
  memBalloon: true,
  guestAgent: true,
  vtpm: false,
  virtioRng: true,
  nestedVirt: false,
  localDns: true,
  nics: [{ type: 'bridge', source: '', model: 'virtio', mac: '', vlan: null }],
  disk: { type: 'none', sizeGB: 32, bus: 'virtio', sourcePath: null, sourceName: null, resizeGB: null },
  disk2: { type: 'none', sizeGB: 32, bus: 'virtio', sourcePath: null, sourceName: null, resizeGB: null },
  cdrom1Path: null,
  cdrom2Path: null,
  cdrom1Name: null,
  cdrom2Name: null,
  cloudInit: { enabled: true, hostname: '', username: 'wisp', growPartition: true, packageUpgrade: true, installQemuGuestAgent: true, installAvahiDaemon: true },
});

export default function CreateVMPanel() {
  const navigate = useNavigate();
  const fetchVMs = useVmStore((s) => s.fetchVMs);
  const registerJob = useBackgroundJobsStore((s) => s.registerJob);
  const createRow = useBackgroundJobsStore((s) => s.jobs);

  const [form, setForm] = useState(defaultForm);
  const [bridges, setBridges] = useState([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [createDetail, setCreateDetail] = useState(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [createJobId, setCreateJobId] = useState(null);

  useEffect(() => {
    getHostBridges()
      .then((list) => {
        const b = list?.length ? list : ['virbr0'];
        setBridges(b);
        setForm((prev) => {
          if (!prev.nics?.length) return prev;
          const nics = prev.nics.map((nic, i) =>
            i === 0 && (!nic.source || nic.source === 'virbr0') ? { ...nic, source: b[0] } : nic
          );
          return { ...prev, nics };
        });
      })
      .catch(() => setBridges(['virbr0']));
  }, []);

  const vmConfig = useCallback(() => ({
    name: form.name,
    state: 'creating',
    osCategory: form.osType === 'Windows' ? 'windows' : 'linux',
    osType: form.osType,
    osVariant: form.osVariant,
    vcpus: form.vcpus,
    memoryMiB: form.memoryMiB,
    autostart: form.autostart,
    firmware: form.firmware,
    machineType: form.machineType,
    cpuMode: form.cpuMode,
    videoModel: form.videoDriver,
    graphics: { type: form.graphicsType },
    bootOrder: form.bootOrder,
    bootMenu: form.bootMenu,
    memBalloon: form.memBalloon,
    guestAgent: form.guestAgent,
    vtpm: form.vtpm,
    virtioRng: form.virtioRng,
    nestedVirt: form.nestedVirt,
    localDns: form.localDns,
    nics: form.nics,
    disks: [],
    features: form.osType === 'Windows' ? { hyperv: true } : {},
  }), [form]);

  const handleGeneralSave = useCallback((changes) => {
    setForm((prev) => ({ ...prev, ...changes }));
    return Promise.resolve({ requiresRestart: false });
  }, []);

  const handleAdvancedSave = useCallback((changes) => {
    setForm((prev) => ({ ...prev, ...changes }));
    return Promise.resolve({ requiresRestart: false });
  }, []);

  const handleCdromChange = useCallback((slot, path, name) => {
    setForm((prev) => ({
      ...prev,
      [slot === 'sdc' ? 'cdrom1Path' : 'cdrom2Path']: path,
      [slot === 'sdc' ? 'cdrom1Name' : 'cdrom2Name']: name,
    }));
  }, []);

  const handleCloudInitChange = useCallback((c) => {
    setForm((prev) => ({ ...prev, cloudInit: c }));
  }, []);

  const handleCreate = async () => {
    const name = (form.name || '').trim();
    if (!name) {
      setCreateError('VM name is required');
      setErrorOpen(true);
      return;
    }
    if (form.disk?.type === 'existing' && !form.disk?.sourcePath) {
      setCreateError('Please select an existing disk image');
      setErrorOpen(true);
      return;
    }
    if (form.disk2?.type === 'existing' && !form.disk2?.sourcePath) {
      setCreateError('Please select an existing disk image for the second disk');
      setErrorOpen(true);
      return;
    }

    setCreating(true);
    setCreateError(null);
    setCreateDetail(null);

    try {
      const spec = {
        name,
        osType: form.osType,
        osVariant: form.osVariant ?? 'generic',
        vcpus: form.vcpus,
        memoryMiB: form.memoryMiB,
        autostart: form.autostart,
        firmware: form.firmware,
        machineType: form.machineType,
        cpuMode: form.cpuMode,
        videoDriver: form.videoDriver,
        graphicsType: form.graphicsType,
        bootOrder: form.bootOrder,
        bootMenu: form.bootMenu,
        memBalloon: form.memBalloon,
        guestAgent: form.guestAgent,
        vtpm: form.vtpm,
        virtioRng: form.virtioRng,
        nestedVirt: form.nestedVirt,
        localDns: form.localDns,
        nics: form.nics.map((n) => ({
          type: n.type || 'bridge',
          source: n.source || bridges[0] || 'virbr0',
          model: n.model || 'virtio',
          mac: n.mac || undefined,
          vlan: n.vlan !== '' && n.vlan != null ? parseInt(n.vlan, 10) : undefined,
        })),
        disk:
          form.disk?.type === 'none'
            ? { type: 'none', bus: form.disk?.bus || 'virtio' }
            : {
                type: form.disk?.type || 'new',
                sizeGB: form.disk?.sizeGB ?? 32,
                bus: form.disk?.bus || 'virtio',
                sourcePath: form.disk?.sourcePath || undefined,
                resizeGB: form.disk?.resizeGB != null && form.disk.resizeGB > 0 ? form.disk.resizeGB : undefined,
              },
        disk2: form.disk2?.type && form.disk2.type !== 'none' ? {
          type: form.disk2.type,
          sizeGB: form.disk2.sizeGB ?? 32,
          bus: form.disk2.bus || 'virtio',
          sourcePath: form.disk2.type === 'existing' ? form.disk2.sourcePath : undefined,
          resizeGB: form.disk2.resizeGB != null && form.disk2.resizeGB > 0 ? form.disk2.resizeGB : undefined,
        } : undefined,
        cdrom1Path: form.cdrom1Path || undefined,
        cdrom2Path: form.cdrom2Path || undefined,
        cloudInit:
          form.osType !== 'Windows' &&
          form.cloudInit &&
          (form.disk?.type === 'existing' || form.disk2?.type === 'existing')
            ? form.cloudInit
            : undefined,
      };

      const { jobId, title } = await createVM(spec);
      setCreateJobId(jobId);
      registerJob({
        jobId,
        kind: JOB_KIND.VM_CREATE,
        title,
        onTerminal: (data) => {
          if (data.step === 'done' && data.name) {
            setCreating(false);
            setCreateJobId(null);
            fetchVMs();
            navigate(`/vm/${encodeURIComponent(data.name)}/overview`);
          }
          if (data.step === 'error') {
            setCreateError(data.error || 'Create failed');
            setCreateDetail(data.detail);
            setCreating(false);
            setCreateJobId(null);
          }
        },
      });
    } catch (err) {
      setCreateError(err.message || 'Failed to start create');
      setCreateDetail(err.detail || err.message);
      setCreating(false);
    }
  };

  const config = vmConfig();
  const activeCreate = createJobId ? createRow[createJobId] : null;
  const displayStep = activeCreate?.step ?? (creating ? 'validating' : null);
  const displayPercent = activeCreate?.percent ?? null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col overflow-y-auto px-6 py-5">
        <div className="space-y-5">
          <GeneralSection vmConfig={config} isCreating onSave={handleGeneralSave} onFormChange={(changes) => setForm((prev) => {
            const next = { ...prev, ...changes };
            if (changes.osType === 'Windows') {
              next.vtpm = true;
              next.vcpus = 4;
              next.memoryMiB = 8192;
              next.firmware = 'uefi-secure';
              next.disk = { ...(prev.disk || {}), bus: 'scsi' };
              next.disk2 = { ...(prev.disk2 || {}), bus: 'scsi' };
            } else if (changes.osType === 'Linux') {
              next.vcpus = 2;
              next.memoryMiB = 2048;
              next.firmware = 'uefi';
              next.disk = { ...(prev.disk || {}), bus: 'virtio' };
              next.disk2 = { ...(prev.disk2 || {}), bus: 'virtio' };
            }
            return next;
          })} />
          <DisksSection
            vmConfig={config}
            isCreating
            createDisk={form.disk}
            onCreateDiskChange={(disk) => setForm((prev) => ({ ...prev, disk }))}
            createDisk2={form.disk2}
            onCreateDisk2Change={(disk2) => setForm((prev) => ({ ...prev, disk2 }))}
            cdrom1Path={form.cdrom1Path}
            cdrom2Path={form.cdrom2Path}
            onCdromChange={handleCdromChange}
          />
          {form.osType !== 'Windows' &&
            (form.disk?.type === 'existing' || form.disk2?.type === 'existing') && (
            <CloudInitSection
              vmConfig={{ ...config, name: form.name }}
              isCreating
              onRefresh={() => {}}
              initialCloudInit={form.cloudInit}
              onCloudInitChange={handleCloudInitChange}
            />
          )}
          <VmNetworkInterfacesSection
            vmConfig={config}
            isCreating
            onSave={handleAdvancedSave}
            onFormChange={(changes) => setForm((prev) => ({ ...prev, ...changes }))}
          />
          <AdvancedSection vmConfig={config} isCreating onSave={handleAdvancedSave} onFormChange={(changes) => setForm((prev) => ({ ...prev, ...changes }))} />
        </div>

        {createError && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-status-stopped">{createError}</p>
            {createDetail && (
              <button
                type="button"
                onClick={() => setErrorOpen((o) => !o)}
                className="mt-1 text-xs text-text-muted hover:text-text-secondary"
              >
                {errorOpen ? 'Hide details' : 'Show details'}
              </button>
            )}
            {errorOpen && createDetail && <pre className="mt-2 overflow-auto rounded bg-white/50 p-2 text-[11px] text-text-secondary">{createDetail}</pre>}
          </div>
        )}

        <div className="sticky bottom-0 mt-8 flex flex-col gap-2 rounded-lg border border-surface-border bg-surface-card p-4">
          {creating && (
            <p className="text-sm text-text-secondary">
              {STEP_LABELS[displayStep] || displayStep || 'Working…'}
              {displayPercent != null && ` ${Math.round(displayPercent)}%`}
            </p>
          )}
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="flex items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors duration-150"
          >
            {creating && <Loader2 size={18} className="animate-spin" />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
