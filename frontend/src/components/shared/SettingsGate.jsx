import RecordGate from './RecordGate.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';

/**
 * Renders its children once the settings have loaded; until then a loading
 * line, or the load error with a retry — never a form full of defaults that
 * a Save would write back over the real settings.
 */
export default function SettingsGate({ children, label = 'settings' }) {
  const record = useRecord(RECORD.SETTINGS);
  return <RecordGate record={record} what={label}>{() => children}</RecordGate>;
}
