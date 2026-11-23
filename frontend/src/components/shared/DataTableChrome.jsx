/**
 * Shared list/table layout tokens — see docs/FRONTEND-RULES.md.
 */

/**
 * -mx-4 cancels the cells' px-4 edge inset so the first/last columns align
 * with the parent card's own padding instead of double-indenting. Every
 * caller sits inside a container with ≥16px horizontal padding (Card
 * body, modal inner card, library card).
 */
export function DataTableScroll({ className = '', children }) {
  return (
    <div className={`overflow-x-auto -mx-4 ${className}`.trim()}>
      {children}
    </div>
  );
}

/**
 * Tables size by natural content width by default. Pass `minWidthClass` only when
 * a table needs a floor below which it scrolls instead of squashing — as a literal
 * Tailwind class string (e.g. `"sm:min-w-[30rem]"`) so the scanner emits the CSS.
 * @param {object} props
 * @param {string} [props.minWidthClass]
 * @param {import('react').ReactNode} props.children
 */
export function DataTable({ minWidthClass = '', children, ...rest }) {
  return (
    <table
      className={`w-full ${minWidthClass} text-sm text-text-secondary border-collapse`}
      {...rest}
    >
      {children}
    </table>
  );
}

export const dataTableHeadRowClass =
  'text-left text-[11px] font-medium text-text-muted uppercase tracking-wider border-b border-surface-border';

export const dataTableBodyRowClass = 'border-b border-surface-border/60 last:border-0';

/** Hover background + `group` so row actions can show on hover/focus-within (see BackupsPanel). */
export const dataTableInteractiveRowClass =
  'group border-b border-surface-border/60 last:border-0 hover:bg-surface transition-colors duration-150';

/** Horizontal inset for every `<th>` / `<td>` (symmetric; do not use `pr-*` alone). */
export const dataTableCellPadX = 'px-4';

const dataTableThPadComfortable = `${dataTableCellPadX} py-2 font-medium`;

const dataTableThPadDense = `${dataTableCellPadX} py-1.5 font-medium`;

/** Full-width empty / loading rows (`colSpan`) — horizontal inset matches data cells. */
export const dataTableEmptyCellClass = `${dataTableCellPadX} py-4`;

/**
 * @param {object} props
 * @param {boolean} [props.dense] - dense vertical padding (`py-1.5`) for form-heavy tables
 * @param {'left'|'right'} [props.align]
 * @param {string} [props.className]
 * @param {import('react').ReactNode} props.children
 */
export function DataTableTh({ dense = false, align = 'left', className = '', children, ...rest }) {
  const pad = dense ? dataTableThPadDense : dataTableThPadComfortable;
  const alignCls = align === 'right' ? 'text-right' : '';
  return (
    <th scope="col" className={`${pad} whitespace-nowrap ${alignCls} ${className}`.trim()} {...rest}>
      {children}
    </th>
  );
}

/**
 * @param {object} props
 * @param {boolean} [props.dense]
 * @param {'left'|'right'} [props.align]
 * @param {'middle'|'top'} [props.valign]
 * @param {string} [props.className]
 * @param {import('react').ReactNode} props.children
 */
export function DataTableTd({ dense = false, align = 'left', valign = 'middle', className = '', children, ...rest }) {
  const py = dense ? 'py-1.5' : 'py-2.5';
  const valignCls = valign === 'top' ? 'align-top' : 'align-middle';
  const alignCls = align === 'right' ? 'text-right' : '';
  return (
    <td className={`${dataTableCellPadX} ${py} ${valignCls} ${alignCls} ${className}`.trim()} {...rest}>
      {children}
    </td>
  );
}

/**
 * Icon actions hidden until row hover or focus-within; use `forceVisible` while editing or loading.
 * @param {{ children: React.ReactNode, forceVisible?: boolean }} props
 */
export function DataTableRowActions({ children, forceVisible = false }) {
  return (
    <div
      className={
        forceVisible
          ? 'flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap'
          : 'flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap hoverable:lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 transition-opacity duration-150'
      }
    >
      {children}
    </div>
  );
}
