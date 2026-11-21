import RecordError from './RecordError.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';

/**
 * A settings load failure while settings are on screen, shown until dismissed (the
 * last good settings stay). Before any settings load, SettingsGate shows the error.
 */
export default function SettingsRefreshNotice() {
  const record = useRecord(RECORD.SETTINGS);
  if (record.data == null) return null;
  return <RecordError record={record} what="settings" />;
}
