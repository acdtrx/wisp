/**
 * The one comment stripper of the dependency-free source scans
 * (check-imports.mjs, check-fences.mjs). Aware of strings, templates and regex
 * literals, so a `//` or `/*` inside one is not taken for a comment.
 */
const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/** Blank out comments (newlines kept, so line numbers hold); strings stay. */
export function stripComments(src) {
  let out = '';
  let i = 0;
  let lastSignificant = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSignificant = c;
      continue;
    }
    if (c === '/' && (lastSignificant === '' || REGEX_PRECEDERS.has(lastSignificant)
      || REGEX_KEYWORDS.test(out.trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSignificant = 'a';
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = /[\w$]/.test(c) ? 'a' : c;
    out += c;
    i += 1;
  }
  return out;
}
