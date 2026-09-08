import katex from "katex";

const MAX_FORMULA_CHARS = 8_000;
const MISSING_INLINE_CLOSERS = Symbol("missingInlineMathClosers");
const MISSING_BLOCK_CLOSERS = Symbol("missingBlockMathClosers");

function escapedAt(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function findClosing(source, marker, from, limit = source.length) {
  if (limit < source.length) {
    for (let index = from; index + marker.length <= limit; index += 1) {
      if (source.startsWith(marker, index) && !escapedAt(source, index)) return index;
    }
    return -1;
  }
  let index = source.indexOf(marker, from);
  while (index !== -1 && index < limit) {
    if (!escapedAt(source, index)) return index;
    index = source.indexOf(marker, index + marker.length);
  }
  return -1;
}

function findInlineClosing(state, marker, from, cacheMissing = true) {
  const missing = state[MISSING_INLINE_CLOSERS] ??= new Set();
  const cacheKey = `${marker}:${state.posMax}`;
  if (missing.has(cacheKey)) return -1;
  const closing = findClosing(state.src, marker, from, state.posMax);
  if (closing === -1 && cacheMissing) missing.add(cacheKey);
  return closing;
}

function pushLiteral(state, marker, silent) {
  if (!silent) state.pending += marker;
  state.pos += marker.length;
  return true;
}

function pushInlineMath(state, silent, { open, close, end, displayMode }) {
  if (!silent) {
    const token = state.push(displayMode ? "math_display" : "math_inline", "math", 0);
    token.content = state.src.slice(state.pos + open.length, end);
    token.markup = open;
    token.meta = {
      displayMode,
      raw: state.src.slice(state.pos, end + close.length),
    };
  }
  state.pos = end + close.length;
  return true;
}

function bracketInlineRule(open, close, displayMode = false) {
  return (state, silent) => {
    if (!state.src.startsWith(open, state.pos)) return false;
    const searchStart = state.pos + open.length;
    const nextOpen = findClosing(state.src, open, searchStart, state.posMax);
    const end = nextOpen === -1
      ? findInlineClosing(state, close, searchStart, !silent)
      : findClosing(state.src, close, searchStart, nextOpen);
    if (end === -1) return pushLiteral(state, open, silent);
    return pushInlineMath(state, silent, { open, close, end, displayMode });
  };
}

function displayDollarInlineRule(state, silent) {
  const open = "$$";
  if (!state.src.startsWith(open, state.pos)) return false;
  const end = findInlineClosing(state, open, state.pos + open.length, !silent);
  if (end === -1) return pushLiteral(state, open, silent);
  return pushInlineMath(state, silent, {
    open,
    close: open,
    end,
    displayMode: true,
  });
}

function dollarInlineRule(state, silent) {
  if (state.src[state.pos] !== "$" || state.src[state.pos + 1] === "$") return false;
  const nextCode = state.src.charCodeAt(state.pos + 1);
  if (state.md.utils.isSpace(nextCode)) return false;

  let end = findInlineClosing(state, "$", state.pos + 1, !silent);
  while (end !== -1) {
    const priorCode = state.src.charCodeAt(end - 1);
    const followingCode = state.src.charCodeAt(end + 1);
    const closes = !state.md.utils.isSpace(priorCode) && !(followingCode >= 48 && followingCode <= 57);
    if (closes && !state.src.slice(state.pos + 1, end).includes("\n")) break;
    const startsNewFormula =
      state.src.startsWith("$$", end) || !state.md.utils.isSpace(followingCode);
    if (startsNewFormula) return false;
    end = findInlineClosing(state, "$", end + 1, !silent);
  }
  if (end === -1) return false;
  return pushInlineMath(state, silent, {
    open: "$",
    close: "$",
    end,
    displayMode: false,
  });
}

function closingAtLineEnd(state, line, marker, from) {
  const lineEnd = state.eMarks[line];
  let end = findClosing(state.src, marker, from, lineEnd);
  while (end !== -1) {
    if (state.src.slice(end + marker.length, lineEnd).trim() === "") return end;
    end = findClosing(state.src, marker, end + marker.length, lineEnd);
  }
  return -1;
}

function isMarkdownBoundary(state, line, open, close) {
  const start = state.bMarks[line] + state.tShift[line];
  const text = state.src.slice(start, state.eMarks[line]).trim();
  if (!text) return true;
  if (text === close) return false;
  return text.startsWith(open);
}

function mathBlockRule(state, startLine, endLine, silent) {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const firstEnd = state.eMarks[startLine];
  const open = state.src.startsWith("$$", start)
    ? "$$"
    : state.src.startsWith("\\[", start)
      ? "\\["
      : "";
  if (!open) return false;
  const close = open === "$$" ? "$$" : "\\]";
  const missing = state[MISSING_BLOCK_CLOSERS] ??= new Set();
  const missingKey = `${close}:${endLine}`;
  if (missing.has(missingKey)) return false;

  let closingLine = startLine;
  let closing = closingAtLineEnd(state, startLine, close, start + open.length);
  while (closing === -1 && closingLine + 1 < endLine) {
    closingLine += 1;
    if (isMarkdownBoundary(state, closingLine, open, close)) return false;
    const lineStart = state.bMarks[closingLine] + state.tShift[closingLine];
    closing = closingAtLineEnd(state, closingLine, close, lineStart);
  }
  if (closing === -1) {
    missing.add(missingKey);
    return false;
  }
  if (silent) return true;

  const parts = [
    state.src.slice(start + open.length, closingLine === startLine ? closing : firstEnd),
  ];
  for (let line = startLine + 1; line < closingLine; line += 1) {
    parts.push(state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]));
  }
  if (closingLine > startLine) {
    parts.push(
      state.src.slice(state.bMarks[closingLine] + state.tShift[closingLine], closing),
    );
  }

  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = parts.join("\n").trim();
  token.markup = open;
  token.map = [startLine, closingLine + 1];
  token.meta = {
    displayMode: true,
    raw: `${open}${parts.join("\n")}${close}`,
  };
  state.line = closingLine + 1;
  return true;
}

function renderMath(markdown, content, raw, displayMode) {
  if (
    !content.trim() ||
    content.length > MAX_FORMULA_CHARS
  ) {
    return markdown.utils.escapeHtml(raw);
  }
  try {
    return katex.renderToString(content, {
      displayMode,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: () => {
        throw new katex.ParseError("Trusted KaTeX commands are disabled");
      },
      strict: "error",
      maxExpand: 1_000,
      maxSize: 10,
      macros: {},
      globalGroup: false,
    });
  } catch (error) {
    // Invalid model-generated LaTeX stays readable; implementation errors must surface.
    if (!(error instanceof katex.ParseError)) throw error;
    return markdown.utils.escapeHtml(raw);
  }
}

export function mathMarkdownPlugin(markdown) {
  markdown.inline.ruler.before(
    "escape",
    "math_display_bracket",
    bracketInlineRule("\\[", "\\]", true),
  );
  markdown.inline.ruler.before(
    "escape",
    "math_inline_bracket",
    bracketInlineRule("\\(", "\\)"),
  );
  markdown.inline.ruler.after("escape", "math_display_dollar", displayDollarInlineRule);
  markdown.inline.ruler.after("math_display_dollar", "math_inline_dollar", dollarInlineRule);
  markdown.block.ruler.after("blockquote", "math_block", mathBlockRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });

  markdown.renderer.rules.math_inline = (tokens, index) => {
    const token = tokens[index];
    return renderMath(markdown, token.content, token.meta.raw, false);
  };
  markdown.renderer.rules.math_display = (tokens, index) => {
    const token = tokens[index];
    return renderMath(markdown, token.content, token.meta.raw, true);
  };
  markdown.renderer.rules.math_block = (tokens, index) => {
    const token = tokens[index];
    const rendered = renderMath(markdown, token.content, token.meta.raw, true);
    return rendered.startsWith("<span class=\"katex-display\"")
      ? `${rendered}\n`
      : `<pre class="math-source"><code>${rendered}</code></pre>\n`;
  };

  const renderFence = markdown.renderer.rules.fence;
  markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    if (token.info.trim() !== "math") {
      return renderFence(tokens, index, options, env, renderer);
    }
    const raw = `\`\`\`math\n${token.content}\`\`\``;
    const rendered = renderMath(markdown, token.content.trim(), raw, true);
    return rendered.startsWith("<span class=\"katex-display\"")
      ? `${rendered}\n`
      : `<pre class="math-source"><code>${rendered}</code></pre>\n`;
  };
}
