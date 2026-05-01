import { lazy, Suspense } from 'react';
import OsUpdateSection from './OsUpdateSection.jsx';
import ImageLibrary from '../library/ImageLibrary.jsx';

/* react-markdown (used to render release notes) is the heaviest tree on this
 * tab and the notes only render once the user expands the <details>. Defer
 * the whole section so the markdown stack stays out of the main bundle. */
const WispUpdateSection = lazy(() => import('./WispUpdateSection.jsx'));

export default function Software() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-5">
        <Suspense fallback={null}>
          <WispUpdateSection />
        </Suspense>
        <OsUpdateSection />
        <ImageLibrary mode="embedded" />
      </div>
    </div>
  );
}
