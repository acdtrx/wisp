import { lazy, Suspense } from 'react';
import OsUpdateSection from './OsUpdateSection.jsx';
import ImageLibrary from '../library/ImageLibrary.jsx';

/* marked + dompurify (used to render release notes) only matter when the user
 * opens the details modal. Defer the whole section so they stay out of the
 * main bundle. */
const WispUpdateSection = lazy(() => import('./WispUpdateSection.jsx'));

export default function Software({ onRequestRestart }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5 space-y-5">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Suspense fallback={null}>
            <WispUpdateSection />
          </Suspense>
          <OsUpdateSection onRequestRestart={onRequestRestart} />
        </div>
        <ImageLibrary mode="embedded" />
      </div>
    </div>
  );
}
