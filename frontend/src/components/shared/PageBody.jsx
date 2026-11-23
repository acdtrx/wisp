/**
 * A page's content under its header: the one set of gutters every page's cards stack
 * in (docs/FRONTEND-RULES.md, Cards). `narrow` holds the content to a centred column
 * (the workload pages); `scrolls` is false where the page scrolls as a whole, its
 * header with it.
 */
export default function PageBody({ narrow = false, scrolls = true, children }) {
  return (
    <div className={`min-h-0 flex-1 px-3 py-4 sm:px-4 lg:px-6 lg:py-5${scrolls ? ' overflow-y-auto' : ''}`}>
      <div className={`space-y-3${narrow ? ' mx-auto max-w-3xl' : ''}`}>{children}</div>
    </div>
  );
}
