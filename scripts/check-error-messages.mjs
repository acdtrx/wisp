#!/usr/bin/env node
/**
 * An error's message is Wisp's own text, sent to the client whole; a tool's or
 * a library's text goes in its `raw` cause, which alone is redacted
 * (docs/specs/ERROR-HANDLING.md, The error body). Run with `npm run check` (or
 * `node scripts/check-error-messages.mjs`) from the repo root; exits 1 when the
 * message argument of an error factory in backend/src (comments and tests
 * aside) carries another error's text.
 *
 * The factories: createAppError, vmError, containerError, networkingError,
 * asAppError (their message argument is the second) and setupError (the
 * first). In the message argument's code — outside its string literals, inside
 * a template's `${…}` — it flags:
 * - a `.message`, `.details` (a gRPC error's), `.stderr` or `.stdout`, or a
 *   bare `stderr` / `stdout`;
 * - `String(x)` or `x.toString()` of an error-like name;
 * - an error-like name used whole (`${err}`, `'Failed: ' + err`);
 * error-like names being `err`, `e`, `ex`, `error`, `cause` and any name
 * ending in `Err` or `Error`. A message argument that is a bare name is
 * also read through every `const` / `let` / `var` declaration or assignment
 * of that name in the same file.
 *
 * What it cannot catch: the text reached through a helper's return value
 * (`describe(err)`), a property other than those above (`err.reason`), an
 * error held under another name (`failure`, a rejection's `reason`), a
 * message variable built in another file or passed in as a parameter, and a
 * factory under another name (a wrapper that forwards its argument to one of
 * the factories is checked only at that call). A Wisp error's own message
 * wrapped in another's is flagged all the same: the scan cannot tell it from
 * a tool's, so a wrapping error carries the inner one's text in its raw cause.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { stripComments } from './sourceScan.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Each factory, and the index of its message argument. */
const FACTORIES = {
  createAppError: 1,
  vmError: 1,
  containerError: 1,
  networkingError: 1,
  asAppError: 1,
  setupError: 0,
};

const ERRISH = String.raw`(?:err|e|ex|error|cause|[\w$]*Err|[\w$]*Error)`;
const TOOL_TEXT = [
  { re: /\.\s*(?:message|details|stderr|stdout)\b/, what: 'an error\'s or a tool\'s text' },
  { re: /(?<![\w$.])(?:stderr|stdout)\b/, what: 'a tool\'s output' },
  { re: new RegExp(String.raw`\bString\(\s*${ERRISH}\s*\)`), what: 'an error as a string' },
  { re: new RegExp(String.raw`(?<![\w$.])${ERRISH}\s*\??\.\s*toString\(`), what: 'an error as a string' },
  // A name used whole: not called, not a property read, not a key.
  { re: new RegExp(String.raw`(?<![\w$.])${ERRISH}(?![\w$])(?!\s*(?:[(.:]|\?\.))`), what: 'an error used whole' },
];

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'backend/src'], {
  cwd: ROOT, encoding: 'utf8',
}).split('\0').filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));

/**
 * The text with its string literals' contents blanked, a template's `${…}`
 * kept as code; the same length, so indexes hold.
 */
function codeOnly(text) {
  let out = '';
  let i = 0;
  const literal = (quote) => {
    out += quote;
    i += 1;
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\') { out += '  '; i += 2; continue; }
      if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
        out += '${';
        i += 2;
        let depth = 1;
        const start = i;
        while (i < text.length && depth > 0) {
          if (text[i] === '{') depth += 1;
          else if (text[i] === '}') depth -= 1;
          if (depth > 0) i += 1;
        }
        out += codeOnly(text.slice(start, i));
        if (i < text.length) { out += '}'; i += 1; }
        continue;
      }
      out += text[i] === '\n' ? '\n' : ' ';
      i += 1;
    }
    if (i < text.length) { out += quote; i += 1; }
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { literal(c); continue; }
    out += c;
    i += 1;
  }
  return out;
}

/** The arguments of the call whose `(` is at `open - 1`: `[{ start, end }]` into `code`. */
function callArguments(code, open) {
  const args = [];
  let depth = 0;
  let start = open;
  let i = open;
  for (; i < code.length; i += 1) {
    const c = code[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      args.push({ start, end: i });
      start = i + 1;
    }
  }
  if (code.slice(start, i).trim()) args.push({ start, end: i });
  return args;
}

/**
 * The expression that starts at `from`: up to a depth-0 `;`, `,` or closing
 * bracket, or a line end, unless that line ends or the next starts with an
 * operator.
 */
function expressionAt(code, from) {
  let depth = 0;
  let i = from;
  for (; i < code.length; i += 1) {
    const c = code[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (c === ';' || c === ',')) break;
    else if (depth === 0 && c === '\n' && !/^\s*[?:+.|&]/.test(code.slice(i + 1, i + 40))) {
      if (!/[?:+|&=(,]\s*$/.test(code.slice(from, i))) break;
    }
  }
  return code.slice(from, i);
}

function findToolText(code) {
  for (const { re, what } of TOOL_TEXT) {
    const m = re.exec(code);
    if (m) return { what, text: m[0].trim() };
  }
  return null;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const problems = [];
let calls = 0;
for (const file of files) {
  const src = stripComments(readFileSync(path.join(ROOT, file), 'utf8'));
  const code = codeOnly(src);
  const callRe = new RegExp(String.raw`(?<![\w$.])(${Object.keys(FACTORIES).join('|')})\s*\(`, 'g');
  for (const m of code.matchAll(callRe)) {
    if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue; // its definition
    calls += 1;
    const args = callArguments(code, m.index + m[0].length);
    const arg = args[FACTORIES[m[1]]];
    if (!arg) continue;
    const argCode = code.slice(arg.start, arg.end);
    const where = `${file}:${lineOf(src, arg.start + argCode.length - argCode.trimStart().length)}`;
    const direct = findToolText(argCode);
    if (direct) {
      problems.push(`${where}: ${m[1]}'s message carries ${direct.what} (${direct.text}); put it in raw`);
      continue;
    }
    const name = argCode.trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    const assignRe = new RegExp(String.raw`(?<![\w$.])${name.replaceAll('$', '\\$')}\s*\+?=(?![=>])`, 'g');
    for (const a of code.matchAll(assignRe)) {
      const found = findToolText(expressionAt(code, a.index + a[0].length));
      if (found) {
        problems.push(`${where}: ${m[1]}'s message ${name} (set at line ${lineOf(src, a.index)}) carries ${found.what} (${found.text}); put it in raw`);
        break;
      }
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`\n${problems.length} error message(s) carry another error's text: the message is Wisp's words, the tool's text its raw cause (docs/specs/ERROR-HANDLING.md).`);
  process.exit(1);
}
console.log(`error messages: ${calls} factory calls in backend/src, none with another error's text in its message.`);
