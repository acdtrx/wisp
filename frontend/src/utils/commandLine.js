/**
 * The container command override is stored as an argv array and edited as one
 * line of shell-style quoting. `parseCommandLine(formatCommandLine(argv))`
 * returns `argv` unchanged for every array of strings, so a command set through
 * the API survives a UI edit.
 *
 * Only quoting is shell-like: no shell runs, so `$VAR`, globs, `|`, `&&` and `;`
 * are plain characters. Supported forms:
 * - `'…'`  — literal, no escapes
 * - `"…"`  — backslash escapes only `"`, `\`, `$` and `` ` ``
 * - `$'…'` — ANSI-C escapes (`\n`, `\t`, `\r`, `\\`, `\'`, `\"`, `\xHH`); the
 *   formatter uses it for arguments holding newlines or other control characters
 * - `\c` outside quotes — the character `c`
 */

const BARE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;
const WHITESPACE = /\s/;
const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', '\\', '$', '`']);
const ANSI_C_ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };

function ansiCQuote(arg) {
  let out = "$'";
  for (const ch of arg) {
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (CONTROL_CHAR.test(ch)) out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `${out}'`;
}

function quoteArg(arg) {
  if (arg === '') return "''";
  if (BARE_ARG.test(arg)) return arg;
  if (CONTROL_CHAR.test(arg)) return ansiCQuote(arg);
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** @param {string[] | null | undefined} argv */
export function formatCommandLine(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return '';
  return argv.map(quoteArg).join(' ');
}

/**
 * @param {string} text
 * @returns {string[]} the argv; empty for blank input
 * @throws {Error} on an unterminated quote or a trailing backslash
 */
export function parseCommandLine(text) {
  const args = [];
  let current = '';
  let inWord = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (WHITESPACE.test(ch)) {
      if (inWord) {
        args.push(current);
        current = '';
        inWord = false;
      }
      i += 1;
      continue;
    }

    inWord = true;

    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new Error('Unterminated single quote in command');
      current += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (ch === '$' && text[i + 1] === "'") {
      i += 2;
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === "'") {
          closed = true;
          i += 1;
          break;
        }
        if (c !== '\\') {
          current += c;
          i += 1;
          continue;
        }
        const next = text[i + 1];
        if (next === undefined) break;
        if (next in ANSI_C_ESCAPES) {
          current += ANSI_C_ESCAPES[next];
          i += 2;
        } else if (next === 'x' && /^[0-9a-fA-F]/.test(text[i + 2] ?? '')) {
          const hex = text.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{1,2}/)[0];
          current += String.fromCharCode(parseInt(hex, 16));
          i += 2 + hex.length;
        } else {
          current += `\\${next}`;
          i += 2;
        }
      }
      if (!closed) throw new Error("Unterminated $'…' quote in command");
      continue;
    }

    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === '\\' && DOUBLE_QUOTE_ESCAPABLE.has(text[i + 1])) {
          current += text[i + 1];
          i += 2;
          continue;
        }
        current += c;
        i += 1;
      }
      if (!closed) throw new Error('Unterminated double quote in command');
      continue;
    }

    if (ch === '\\') {
      if (i + 1 >= text.length) throw new Error('Trailing backslash in command');
      current += text[i + 1];
      i += 2;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (inWord) args.push(current);
  return args;
}
