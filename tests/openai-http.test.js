import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { requestChatCompletion } from "../src/core/openai.js";

test("real HTTP requests distinguish complete, interrupted, and timed-out streams", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, body: JSON.parse(raw), authorization: request.headers.authorization });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"實際連線"}}]}\n\n');
    if (request.url.startsWith("/complete/")) response.end("data: [DONE]\n\n");
    else if (request.url.startsWith("/interrupted/")) response.end();
    // /timeout/ deliberately leaves the response open until the caller aborts.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const root = `http://127.0.0.1:${server.address().port}`;
  const request = (path, timeoutMs = 5_000) => requestChatCompletion({
    baseUrl: `${root}/${path}`,
    apiKey: "",
    model: "local-test",
    messages: [{ role: "user", content: "test" }],
    timeoutMs,
  });

  assert.equal(await request("complete"), "實際連線");
  await assert.rejects(request("interrupted"), /中斷/);
  await assert.rejects(request("timeout", 100), /逾時/);
  assert.deepEqual(requests.map((entry) => entry.path), [
    "/complete/chat/completions", "/interrupted/chat/completions", "/timeout/chat/completions",
  ]);
  for (const entry of requests) {
    assert.equal(entry.authorization, undefined);
    assert.equal(entry.body.stream, true);
    assert.equal(entry.body.model, "local-test");
  }
});

test("API requests reject redirects before forwarding the prompt body", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, body: raw });
    if (request.url === "/v1/chat/completions") {
      response.writeHead(307, { Location: "/unexpected-provider" });
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "redirected" } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  await assert.rejects(requestChatCompletion({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "",
    model: "local-test",
    messages: [{ role: "user", content: "synthetic page context" }],
  }));
  assert.deepEqual(requests.map((request) => request.path), ["/v1/chat/completions"]);
});
