import test from "node:test";
import assert from "node:assert/strict";
import { estimateRequestTokens, requestInputBudget, pageTokenBudget } from "../src/core/request-budget.js";

test("request budget reserves answer space and includes history, framing and images", () => {
  assert.equal(requestInputBudget({ contextWindowTokens: 262144 }), 253952);
  assert.equal(requestInputBudget({ contextWindowTokens: 8192 }), 6144);
  const base = [{ role: "system", content: "System" }, { role: "user", content: "Question" }];
  const count = estimateRequestTokens(base);
  assert.ok(estimateRequestTokens([...base, { role: "assistant", content: "history".repeat(100) }]) > count);
  const image = data => [{ role: "user", content: [{ type: "text", text: "Question" }, { type: "image_url", image_url: { url: data } }] }];
  assert.equal(estimateRequestTokens(image("data:image/png;base64,a")), estimateRequestTokens(image("data:image/png;base64," + "a".repeat(10000))));
  assert.ok(estimateRequestTokens(image("image")) > 4096);
  const settings = { contextWindowTokens: 8192 };
  assert.ok(pageTokenBudget(settings, base, 3) * 3 <= requestInputBudget(settings) - count);
  assert.throws(() => pageTokenBudget(settings, [{ role: "user", content: "large".repeat(10000) }]), /Context window/);
});
