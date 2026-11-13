/**
 * The one place programmatic focus goes through (FRONTEND-RULES, Phones and
 * touch): on a touch device only a tap on a field may open the keyboard, so a
 * field is never focused by code there. Focusing a non-field element (a dialog
 * container, a menu item, the button that opened a layer) stays unconditional:
 * it opens no keyboard.
 */

/** The same query as the 16px-field rule in index.css, so the two agree. */
const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

export function isTouchDevice() {
  return typeof window !== 'undefined' && window.matchMedia?.(TOUCH_QUERY).matches === true;
}

/** Whether focusing `el` can open an on-screen keyboard. */
export function isTextField(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  if (tag !== 'input') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden'].includes(type);
}

/** Focus a field, except on a touch device. Returns whether it focused. */
export function focusField(el, options) {
  if (!el || isTouchDevice()) return false;
  el.focus(options);
  return true;
}

/** Focus any element: a field through focusField, anything else always. */
export function focusElement(el, options) {
  if (!el || typeof el.focus !== 'function') return false;
  if (isTextField(el)) return focusField(el, options);
  el.focus(options);
  return true;
}

/** A callback ref that focuses its field when it mounts (the touch-aware `autoFocus`). */
export function autoFocusField(el) {
  if (el) focusField(el);
}
