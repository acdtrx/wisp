/**
 * `wisp/catch-says-why`: a catch that drops its error says why (CODING-RULES §5).
 *
 * A `catch` clause, or a function written inline as a promise's rejection
 * handler (`.catch(fn)`, or `.then(onOk, fn)`'s second argument), handles its error when it reads the error's binding or throws.
 * Otherwise it drops the error, and it must carry a comment, inside the handler
 * or on the line of its `catch`, that gives the reason. A comment that is only
 * a word for "dropped" is no reason: one with fewer than three words once
 * "ignore", "best effort", "noop", "swallow", "intentional" and "empty" are
 * taken out fails. A handler passed by name (`.catch(reject)`) handles the
 * error where it is defined.
 */
const FILLER = /\b(?:ignor(?:e|ed|es|ing)|best[- ]effort|no-?op|swallow(?:s|ed|ing)?|intentional(?:ly)?|empty|silent(?:ly)?)\b/gi;
const MIN_REASON_WORDS = 3;

function isReason(text) {
  const words = text.replace(FILLER, ' ').replace(/[^\p{L}\p{N}'`.-]+/gu, ' ').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length >= MIN_REASON_WORDS;
}

function throwsInside(body) {
  let found = false;
  const visit = (node) => {
    if (found || !node || typeof node.type !== 'string') return;
    if (node.type === 'ThrowStatement') { found = true; return; }
    if (node !== body && /Function/.test(node.type)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    }
  };
  visit(body);
  return found;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A catch that drops its error says why in a comment' },
    messages: {
      silent: 'This catch drops its error: log it, show it, rethrow it, or say in a comment here why dropping it is right (CODING-RULES §5).',
      noReason: 'This catch drops its error and its comment gives no reason: say why dropping it is right ("ignore" and "best effort" are not reasons).',
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;

    const usesError = (param, scopeNode) => {
      if (!param) return false;
      if (param.type !== 'Identifier') return true; // a destructured error is read
      const variable = sourceCode.getDeclaredVariables(scopeNode).find((v) => v.name === param.name);
      return !!variable && variable.references.length > 0;
    };

    const judge = (handler, param, scopeNode, body, catchLine) => {
      if (usesError(param, scopeNode) || throwsInside(body)) return;
      const comments = sourceCode.getAllComments().filter((c) => (c.range[0] >= handler.range[0] && c.range[1] <= handler.range[1])
        || c.loc.start.line === catchLine);
      if (comments.length === 0) {
        context.report({ node: handler, loc: { line: catchLine, column: 0 }, messageId: 'silent' });
      } else if (!comments.some((c) => isReason(c.value))) {
        context.report({ node: handler, loc: { line: catchLine, column: 0 }, messageId: 'noReason' });
      }
    };

    return {
      CatchClause(node) {
        judge(node, node.param, node, node.body, node.loc.start.line);
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        const name = callee.property.name;
        if (name !== 'catch' && name !== 'then') return;
        const handler = node.arguments[name === 'catch' ? 0 : 1];
        if (!handler || !/^(?:Arrow)?FunctionExpression$/.test(handler.type)) return;
        judge(handler, handler.params[0], handler, handler.body, callee.property.loc.start.line);
      },
    };
  },
};
