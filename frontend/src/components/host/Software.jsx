import OsUpdateSection from './OsUpdateSection.jsx';
import ImageLibrary from '../library/ImageLibrary.jsx';

export default function Software() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-5">
        <OsUpdateSection />
        <ImageLibrary mode="embedded" />
      </div>
    </div>
  );
}
