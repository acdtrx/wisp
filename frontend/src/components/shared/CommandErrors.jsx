import ErrorBanner from './ErrorBanner.jsx';

/**
 * The errors of a view's command hooks (`useCommand`): one banner per key that
 * failed, each dismissed on its own (docs/FRONTEND-RULES.md, Errors).
 *
 * @param {{ commands: Array<ReturnType<import('../../hooks/useCommand.js').useCommand>>,
 *   prefix?: (key: unknown, command: object, about: unknown) => string | undefined, shows?: (error: unknown) => boolean, className?: string }} props
 *   `shows`: which errors are banners here (a view may show one kind of failure as a status)
 */
export default function CommandErrors({ commands, prefix, shows = () => true, className = '' }) {
  const shown = commands.flatMap((command, i) => command.errors
    .filter(({ error }) => shows(error))
    .map(({ key, error, about }) => ({ id: `${i}:${String(key)}`, command, key, error, about })));
  if (shown.length === 0) return null;
  return (
    <div className={`space-y-1.5 ${className}`}>
      {shown.map(({ id, command, key, error, about }) => (
        <ErrorBanner key={id} error={error} prefix={prefix?.(key, command, about)} onDismiss={() => command.dismiss(key)} />
      ))}
    </div>
  );
}
