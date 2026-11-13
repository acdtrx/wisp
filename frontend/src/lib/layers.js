/**
 * The layer stack (FRONTEND-RULES, Layers): every modal, the phone drawer and
 * every popover pushes a layer while open. One Escape handler closes only the
 * top layer, wherever focus is; Tab is kept inside a trapping layer (a modal,
 * the drawer); what is under the top modal is made inert; closing a layer
 * returns focus to what opened it.
 *
 * Escape is handled on `window` in the bubble phase, after the target's own
 * handlers: a control that uses Escape itself (an inline rename) claims it
 * with `preventDefault()`, and the layer stack leaves it alone.
 */
import { useLayoutEffect, useRef } from 'react';
import { focusElement } from './focus.js';

/** @type {Array<{ id: number, kind: 'modal'|'drawer'|'popover', trap: boolean, getElement: () => HTMLElement|null, inertTargets: () => Element[], onEscape: () => void }>} */
const stack = [];
let nextId = 1;
let listening = false;
/** Elements this module made inert, to undo exactly those. */
let inerted = new Set();

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Whether any layer is open (for page-level Escape handlers, which then stand down). */
export function hasOpenLayer() {
  return stack.length > 0;
}

function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function onKeyDown(e) {
  if (!stack.length) return;
  const top = stack[stack.length - 1];
  if (e.key === 'Escape') {
    if (e.defaultPrevented) return; // claimed by the focused control
    e.preventDefault();
    top.onEscape();
    return;
  }
  if (e.key !== 'Tab' || !top.trap) return;
  const root = top.getElement();
  if (!root) return;
  const items = focusablesIn(root);
  if (!items.length) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = root.contains(active);
  if (e.shiftKey && (!inside || active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Inert: each layer's own targets (the app root under a modal, the page under
 * the drawer), plus every layer below the top modal — a modal under another,
 * the drawer under a confirm opened from it.
 */
function syncInert() {
  let topModal = -1;
  stack.forEach((l, i) => { if (l.kind === 'modal') topModal = i; });
  const next = new Set();
  stack.forEach((l, i) => {
    for (const el of l.inertTargets()) if (el) next.add(el);
    if (i < topModal) {
      const el = l.getElement();
      if (el) next.add(el);
    }
  });
  // A layer at or above the top modal is never inert, even when it sits inside a target.
  for (let i = Math.max(topModal, 0); i < stack.length; i++) {
    const el = stack[i].getElement();
    if (el) next.delete(el);
  }
  for (const el of inerted) if (!next.has(el)) el.inert = false;
  for (const el of next) el.inert = true;
  inerted = next;
}

/**
 * Hold a layer while `open`.
 * @param {boolean} open
 * @param {{ kind: 'modal'|'drawer'|'popover', ref: { current: HTMLElement|null },
 *           onEscape?: () => void, inertTargets?: () => Element[] }} opts
 *   kind: a modal and the drawer trap Tab; a modal makes the app root inert.
 *   onEscape: called when Escape reaches this layer on top (absent: Escape is
 *   swallowed, e.g. while a save runs).
 */
export function useLayer(open, { kind, ref, onEscape, inertTargets }) {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const targetsRef = useRef(inertTargets);
  targetsRef.current = inertTargets;

  useLayoutEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const layer = {
      id: nextId++,
      kind,
      trap: kind !== 'popover',
      getElement: () => ref.current,
      inertTargets: () => {
        const own = targetsRef.current?.() ?? [];
        return kind === 'modal' ? [document.getElementById('root'), ...own] : own;
      },
      onEscape: () => escapeRef.current?.(),
    };
    stack.push(layer);
    if (!listening) {
      window.addEventListener('keydown', onKeyDown);
      listening = true;
    }
    syncInert();
    return () => {
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
      syncInert();
      // Back to what opened it — unless focus has already moved somewhere real.
      const active = document.activeElement;
      const lostFocus = !active || active === document.body || ref.current?.contains(active) || !active.isConnected;
      if (lostFocus && opener && opener !== document.body && opener.isConnected) {
        focusElement(opener, { preventScroll: true });
      }
    };
  }, [open, kind, ref]);
}

/** Move focus into a layer that just opened, unless something inside already has it. */
export function focusIntoLayer(root, { preferFirst = false } = {}) {
  if (!root || root.contains(document.activeElement)) return;
  const first = preferFirst ? focusablesIn(root)[0] : null;
  if (first) focusElement(first, { preventScroll: true });
  if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
}
