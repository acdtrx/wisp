/**
 * A page's content under its header: the one set of gutters every page's cards stack
 * in (docs/FRONTEND-RULES.md, Cards). `narrow` holds the content to a centred column
 * (the workload pages); `scrolls` is false where the page scrolls as a whole, its
 * header with it.
 */
export default function PageBody({ narrow = false, scrolls = true, children }) {
  return (
    /* A scroller may shrink below its content (`min-h-0`); a body inside its page's
     * own scroller keeps its full height, so its bottom gutter stays below the last card. */
    <div className={`flex-1 px-3 py-4 sm:px-4 lg:px-6 lg:py-5${scrolls ? ' min-h-0 overflow-y-auto' : ''}`}>
      <div className={`space-y-3${narrow ? ' mx-auto max-w-3xl' : ''}`}>{children}</div>
    </div>
  );
}
