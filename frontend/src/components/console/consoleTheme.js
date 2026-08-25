/**
 * The console well's colours, resolved from the `--color-console` /
 * `--color-console-text` tokens in index.css.
 *
 * The viewport `<div>` paints itself with the `bg-console` utility, but the
 * terminal and the noVNC screen paint themselves from JS — so both read the same
 * two variables rather than carrying their own copies of the hex. Resolved at
 * call time: the values change when the theme does, and callers re-apply them.
 *
 * @returns {{ background: string, foreground: string }}
 */
export function consoleTheme() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue('--color-console').trim(),
    foreground: styles.getPropertyValue('--color-console-text').trim(),
  };
}
