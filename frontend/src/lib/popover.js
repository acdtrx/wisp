/**
 * A popover anchored to a control (FRONTEND-RULES, Layers): it joins the layer
 * stack (Escape closes it alone), closes on a pointerdown outside it and its
 * anchor, moves focus to its first item and back to the anchor, and is
 * clamped to the viewport — rendered in a portal with fixed coordinates, it
 * also escapes any overflow clipping of the sidebar.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useLayer, focusIntoLayer } from './layers.js';

const MARGIN = 8;
const GAP = 4;

/**
 * Fixed position for `pop` next to `anchor`: below it (above when it doesn't
 * fit below), aligned to the anchor's `align` edge, shifted to stay inside
 * the viewport.
 */
export function useClampToViewport(open, anchorRef, popRef, { align = 'end', side = 'bottom' } = {}) {
  const [style, setStyle] = useState({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' });
  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const a = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === 'end' ? a.right - w : a.left;
    left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - w - MARGIN));
    const below = a.bottom + GAP;
    const above = a.top - GAP - h;
    const fitsBelow = below + h <= vh - MARGIN;
    const fitsAbove = above >= MARGIN;
    let top = side === 'top'
      ? (fitsAbove || !fitsBelow ? above : below)
      : (fitsBelow || !fitsAbove ? below : above);
    top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, vh - h - MARGIN));
    setStyle({ position: 'fixed', top, left, maxHeight: vh - 2 * MARGIN, visibility: 'visible' });
  }, [anchorRef, popRef, align, side]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (ro && popRef.current) ro.observe(popRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      ro?.disconnect();
    };
  }, [open, measure, popRef]);
  return style;
}

/**
 * @param {boolean} open
 * @param {{ anchorRef, popRef, onClose: () => void, align?: 'start'|'end', side?: 'bottom'|'top' }} opts
 * @returns {object} the popover's style (fixed position)
 */
export function usePopover(open, { anchorRef, popRef, onClose, align, side }) {
  useLayer(open, { kind: 'popover', ref: popRef, onEscape: onClose, returnFocusTo: anchorRef });
  const style = useClampToViewport(open, anchorRef, popRef, { align, side });

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, anchorRef, popRef, onClose]);

  // Once placed: a popover is hidden (unfocusable) until its first measure.
  const placed = open && style.visibility === 'visible';
  useEffect(() => {
    if (placed) focusIntoLayer(popRef.current, { preferFirst: true });
  }, [placed, popRef]);

  return style;
}
