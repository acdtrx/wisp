import HostBackup from './HostBackup.jsx';
import HostBackupScheduler from './HostBackupScheduler.jsx';
import HostStorage from './HostStorage.jsx';
import HostNetworkBridges from './HostNetworkBridges.jsx';
import RecordError from '../shared/RecordError.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';

export default function HostMgmt() {
  /* One notice for the page's settings cards, when a re-read of the settings failed. */
  const settingsRecord = useRecord(RECORD.SETTINGS);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5 space-y-5">
      {settingsRecord.data != null && <RecordError record={settingsRecord} what="settings" />}

      <HostNetworkBridges />

      <HostStorage />

      <HostBackup />

      <HostBackupScheduler />
    </div>
  );
}
