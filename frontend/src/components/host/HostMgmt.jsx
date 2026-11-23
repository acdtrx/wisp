import HostBackup from './HostBackup.jsx';
import HostBackupScheduler from './HostBackupScheduler.jsx';
import HostStorage from './HostStorage.jsx';
import HostNetworkBridges from './HostNetworkBridges.jsx';
import RecordError from '../shared/RecordError.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import PageBody from '../shared/PageBody.jsx';

export default function HostMgmt() {
  /* One notice for the page's settings cards, when a re-read of the settings failed. */
  const settingsRecord = useRecord(RECORD.SETTINGS);

  return (
    <PageBody>
      {settingsRecord.data != null && <RecordError record={settingsRecord} what="settings" />}

      <HostNetworkBridges />

      <HostStorage />

      <HostBackup />

      <HostBackupScheduler />
    </PageBody>
  );
}
