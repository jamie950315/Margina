import test from "node:test";
import assert from "node:assert/strict";
import katex from "katex";

import { renderMessageMarkdown } from "../src/core/message-renderer.js";

test("renderMessageMarkdown does not hide unexpected renderer failures as literal math", () => {
  const render = katex.renderToString;
  const failure = new Error("Unexpected renderer failure");
  try {
    katex.renderToString = () => { throw failure; };
    assert.throws(() => renderMessageMarkdown("$x$"), (error) => error === failure);
  } finally {
    katex.renderToString = render;
  }
});

test("renderMessageMarkdown renders common Markdown structures", () => {
  const html = renderMessageMarkdown(`## Result

**Bold** and [docs](https://example.com).

- one
- two

| A | B |
| - | - |
| 1 | 2 |

\`\`\`js
const answer = 42;
\`\`\``);

  assert.match(html, /<h2>Result<\/h2>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<table>/);
  assert.match(html, /<code class="language-js">/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("renderMessageMarkdown renders dollar and LaTeX bracket math with KaTeX", () => {
  const html = renderMessageMarkdown(String.raw`Inline $E=mc^2$ and \(a+b\).

$$\int_0^1 x^2\,dx$$

\[\sum_{n=1}^{\infty} n^{-2}\]`);

  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<math/);
  assert.doesNotMatch(html, /\$E=mc\^2\$/);
});

test("renderMessageMarkdown never executes raw HTML or unsafe links", () => {
  const html = renderMessageMarkdown(String.raw`<script>alert(1)</script>

[unsafe](javascript:alert(1))

\(\href{javascript:alert(2)}{unsafe}\)`);

  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /href\s*=\s*["']javascript:/i);
  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /javascript:alert\(2\)/);
});

test("renderMessageMarkdown keeps incomplete streamed math renderable", () => {
  assert.doesNotThrow(() => renderMessageMarkdown("Working: $\\frac{1}{"));
});

test("renderMessageMarkdown lets a later bracket formula recover from an unfinished opener", () => {
  const html = renderMessageMarkdown(String.raw`Unclosed \(bad. Later \(x\) works.`);

  assert.match(html, /\\\(bad/);
  assert.equal(html.match(/class="katex"/g)?.length, 1);
});

test("renderMessageMarkdown lets a later bracket display recover from an unfinished opener", () => {
  const bracket = renderMessageMarkdown(String.raw`Unclosed \[bad. Later \[x\] works.`);

  assert.match(bracket, /\\\[bad/);
  assert.equal(bracket.match(/class="katex-display"/g)?.length, 1);
});

test("renderMessageMarkdown accepts whitespace inside inline display dollar delimiters", () => {
  for (const source of [
    "before $$ x+y $$ after",
    "before $$x+y $$ after",
    "before $$ x+y$$ after",
  ]) {
    const html = renderMessageMarkdown(source);
    assert.equal(html.match(/class="katex-display"/g)?.length, 1, source);
  }
});

test("renderMessageMarkdown keeps links intact after an unfinished bracket formula", () => {
  const html = renderMessageMarkdown(
    String.raw`[unclosed \(bad](https://example.com) later \(x\)`,
  );

  assert.match(html, /href="https:\/\/example\.com"/);
  assert.equal(html.match(/class="katex"/g)?.length, 1);
});

test("renderMessageMarkdown preserves unfinished display math without swallowing later Markdown", () => {
  const html = renderMessageMarkdown(`Before

$$x +

## After`);

  assert.match(html, /\$\$x \+/);
  assert.match(html, /<h2>After<\/h2>/);
  assert.doesNotMatch(html, /katex-error/);
});

test("renderMessageMarkdown leaves math delimiters inside code untouched", () => {
  const html = renderMessageMarkdown(`Outside $x^2$.

Inline: \`$not_math$\`

\`\`\`text
$$also_not_math$$
\`\`\``);

  assert.equal(html.match(/class="katex"/g)?.length, 1);
  assert.match(html, /<code>\$not_math\$<\/code>/);
  assert.match(html, /\$\$also_not_math\$\$/);
});

test("renderMessageMarkdown does not mistake currency or escaped dollars for math", () => {
  const html = renderMessageMarkdown(String.raw`Costs are $20,000 and \$5 today.`);

  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /\$20,000/);
  assert.match(html, /\$5/);
});

test("renderMessageMarkdown does not let an earlier currency marker consume a later formula", () => {
  const html = renderMessageMarkdown("Pay $20 now; then use $E=mc^2$.");

  assert.match(html, /\$20/);
  assert.equal(html.match(/class="katex"/g)?.length, 1);
  assert.doesNotMatch(html, /\$E=mc\^2\$/);
});

test("renderMessageMarkdown preserves invalid or excessive formulas as source text", () => {
  const invalid = renderMessageMarkdown(String.raw`Bad $\definitelyUnknown{x}$ formula.`);
  const excessive = renderMessageMarkdown(`$${"x".repeat(8_001)}$`);

  assert.doesNotMatch(invalid, /katex-error|ParseError|title=/);
  assert.match(invalid, /\\definitelyUnknown/);
  assert.doesNotMatch(excessive, /class="katex"/);
  assert.match(excessive, /x{100}/);
});

test("renderMessageMarkdown disables images and non-HTTP links", () => {
  const html = renderMessageMarkdown(`[safe](https://example.com)

[relative](/settings) [mail](mailto:test@example.com)

![remote](https://tracker.example/pixel.png)`);

  assert.match(html, /href="https:\/\/example\.com"/);
  assert.doesNotMatch(html, /href="\/settings"|href="mailto:/);
  assert.doesNotMatch(html, /<img/i);
});

test("renderMessageMarkdown isolates macros and blocks trusted KaTeX commands", () => {
  renderMessageMarkdown(String.raw`$\gdef\privateMacro{LEAK}\privateMacro$`);
  const isolated = renderMessageMarkdown(String.raw`$\privateMacro$`);
  const external = renderMessageMarkdown(
    String.raw`$\includegraphics{https://tracker.example/pixel.png}$`,
  );

  assert.doesNotMatch(isolated, /LEAK/);
  assert.match(isolated, /\\privateMacro/);
  assert.doesNotMatch(external, /<img|src=|class="katex"/i);
  assert.match(external, /\\includegraphics/);
  assert.match(external, /https:\/\/tracker\.example\/pixel\.png/);
});

test("renderMessageMarkdown does not mistake an escaped command name for a trusted command", () => {
  const html = renderMessageMarkdown(String.raw`$a\\href$`);

  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /\$a\\\\href\$/);
});

test("renderMessageMarkdown stops an unfinished display block at a Markdown boundary", () => {
  const html = renderMessageMarkdown(`$$bad

## Between

$$x$$`);

  assert.match(html, /\$\$bad/);
  assert.match(html, /<h2>Between<\/h2>/);
  assert.equal(html.match(/class="katex-display"/g)?.length, 1);
});

test("renderMessageMarkdown keeps minus and greater-than lines inside display math", () => {
  const minus = renderMessageMarkdown(`$$
x
- y
$$`);
  const greater = renderMessageMarkdown(`$$
x
> y
$$`);

  assert.equal(minus.match(/class="katex-display"/g)?.length, 1);
  assert.doesNotMatch(minus, /<ul>|<li>/);
  assert.equal(greater.match(/class="katex-display"/g)?.length, 1);
  assert.doesNotMatch(greater, /<blockquote>/);
});
