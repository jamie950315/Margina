import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createDocumentIndex, documentBatches, selectDocumentContext } from "../src/core/long-document.js";
import { runFullReading } from "../src/core/full-document.js";
import { requestChatCompletion } from "../src/core/openai.js";

test("full reading processes real HTTP map/reduce responses including tail facts", async t => {
  const indexed = createDocumentIndex({ text: "背景資料。".repeat(5000) + "結尾重要事實：夜間供電使用電池。", title: "Test", url: "https://example.com/" });
  const batches = documentBatches(indexed);
  const plan = { snapshotId: "test", title: indexed.title, url: indexed.url, totalChars: indexed.totalChars, batchCount: batches.length, context: selectDocumentContext(indexed, { query: "夜間" }) };
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(JSON.parse(body).messages[1].content);
    seen.push(payload);
    const source = payload.sources?.find(source => source.quote.includes("結尾重要事實"));
    const summary = source ? `夜間供電使用電池。[${source.id}]` : payload.sources ? `背景。[${payload.sources[0].id}]` : payload.summaries.join(" ");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: summary }, finish_reason: "stop" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await runFullReading({ plans: [plan], query: "夜間如何供電？", validatePlan: async () => true,
    loadBatch: async (_, index) => batches[index],
    request: (messages, options) => requestChatCompletion({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "", model: "synthetic-test", stream: false, messages, ...options }),
  });
  assert.equal(seen.filter(payload => payload.sources).length, batches.length);
  assert.match(result.pages[0].summary, /夜間供電使用電池/);
  assert.equal(result.pages[0].coverage.processedChars, indexed.totalChars);
});
