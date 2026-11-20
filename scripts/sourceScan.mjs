/**
 * Shared pieces of the dependency-free source scans (check-imports.mjs,
 * check-fences.mjs, check-error-messages.mjs): the comment stripper, aware of strings, templates and
 * regex literals, so a `//` or `/*` inside one is not taken for a comment; and
 * the reading of a call's argument.
 *
 * Known limit: after `++` or `--`, a `/` is read as the start of a regex, so a
 * comment later on that line is kept.
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

/** The text between the `(` that ends at `open` and its matching `)`. */
export function callArgument(code, open) {
  let depth = 1;
  let j = open;
  while (j < code.length && depth > 0) {
    if (code[j] === '(') depth += 1;
    else if (code[j] === ')') depth -= 1;
    j += 1;
  }
  return code.slice(open, j - 1).trim();
}

/**
 * Split a call's first argument (up to a depth-0 `,`) at its depth-0 `?` / `:`
 * (and `||`, `??`) — outside literals, templates and brackets — into
 * `[{ text, isCondition }]`: the part before each `?` is a ternary's condition,
 * the rest are the values it can take.
 */
export function argumentValues(arg) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const cut = (end, sep) => {
    parts.push({ text: arg.slice(start, end).trim(), isCondition: sep === '?' });
  };
  let end = arg.length;
  while (i < arg.length) {
    const c = arg[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < arg.length && arg[j] !== c) j += arg[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (depth === 0 && c === ',') {
      // Only the first argument names the module (import()'s second is options).
      end = i;
      break;
    } else if (depth === 0 && (c === '?' || c === ':') && arg[i + 1] !== '?' && arg[i + 1] !== '.') {
      cut(i, c);
      start = i + 1;
    } else if (depth === 0 && (arg.startsWith('||', i) || arg.startsWith('??', i))) {
      cut(i, '|');
      start = i + 2;
      i += 2;
      continue;
    }
    i += 1;
  }
  cut(end, null);
  return parts;
}
