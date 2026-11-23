import { lazy, Suspense } from 'react';
import OsUpdateSection from './OsUpdateSection.jsx';
import ImageLibrary from '../library/ImageLibrary.jsx';
import RecordError from '../shared/RecordError.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import PageBody from '../shared/PageBody.jsx';

/* marked + dompurify (used to render release notes) only matter when the user
 * opens the details modal. Defer the whole section so they stay out of the
 * main bundle. */
const WispUpdateSection = lazy(() => import('./WispUpdateSection.jsx'));

export default function Software({ onRequestRestart }) {
  const settingsRecord = useRecord(RECORD.SETTINGS);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <PageBody>
        {/* The settings carry the update channel: their failure is this page's notice,
            before they loaded (with a Retry) or over them. */}
        <RecordError record={settingsRecord} what="settings" />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Suspense fallback={null}>
            <WispUpdateSection />
          </Suspense>
          <OsUpdateSection onRequestRestart={onRequestRestart} />
        </div>
        <ImageLibrary mode="embedded" />
      </PageBody>
    </div>
  );
}
