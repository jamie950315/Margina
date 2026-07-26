import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  requestChatCompletion,
  readAssistantResponse,
  resolveChatCompletionsUrl,
} from "../src/core/openai.js";

function fragmentedEventStreamResponse(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { value: undefined, done: true };
            return { value: encoder.encode(chunks[index++]), done: false };
          },
          async cancel() {},
        };
      },
    },
  };
}

test("resolveChatCompletionsUrl appends the compatible route to a base URL", () => {
  assert.equal(
    resolveChatCompletionsUrl("https://api.openai.com/v1/"),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    resolveChatCompletionsUrl("https://openrouter.ai/api/v1"),
    "https://openrouter.ai/api/v1/chat/completions",
  );
});

test("resolveChatCompletionsUrl preserves a full chat completions URL", () => {
  assert.equal(
    resolveChatCompletionsUrl("https://example.com/custom/chat/completions?region=tw"),
    "https://example.com/custom/chat/completions?region=tw",
  );
});

test("resolveChatCompletionsUrl rejects non-network protocols", () => {
  assert.throws(
    () => resolveChatCompletionsUrl("file:///tmp/chat"),
    /HTTP 或 HTTPS/,
  );
});

test("resolveChatCompletionsUrl rejects remote plaintext HTTP", () => {
  assert.throws(
    () => resolveChatCompletionsUrl("http://provider.example/v1"),
    /HTTPS/,
  );
});

test("readAssistantResponse streams deltas split across transport chunks", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Saf"}}]}\n',
    '\ndata: {"choices":[{"delta":{"content":"ari"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const deltas = [];

  const result = await readAssistantResponse(response, (delta) => deltas.push(delta));

  assert.equal(result, "Safari");
  assert.deepEqual(deltas, ["Saf", "ari"]);
});

test("readAssistantResponse accepts a non-streaming compatible response", async () => {
  const response = Response.json({
    choices: [{ message: { content: "完成" } }],
  });

  assert.equal(await readAssistantResponse(response), "完成");
});

test("readAssistantResponse surfaces the provider error message", async () => {
  const response = Response.json(
    { error: { message: "API key invalid" } },
    { status: 401 },
  );

  await assert.rejects(
    () => readAssistantResponse(response),
    (error) => error instanceof ApiError && error.status === 401 && error.message === "API key invalid",
  );
});

test("requestChatCompletion sends a canonical compatible payload and streams the answer", async () => {
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return Response.json({ choices: [{ message: { content: "回答" } }] });
  };
  const messages = [{ role: "user", content: "問題" }];

  const answer = await requestChatCompletion(
    {
      baseUrl: "https://provider.example/v1",
      apiKey: "secret-key",
      model: "vision-model",
      messages,
      stream: true,
    },
    undefined,
    fakeFetch,
  );

  assert.equal(answer, "回答");
  assert.equal(request.url, "https://provider.example/v1/chat/completions");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer secret-key");
  assert.deepEqual(JSON.parse(request.options.body), {
    model: "vision-model",
    messages,
    stream: true,
  });
});

test("requestChatCompletion supports local endpoints without an API key", async () => {
  let headers;
  const fakeFetch = async (_url, options) => {
    headers = options.headers;
    return Response.json({ choices: [{ message: { content: "local" } }] });
  };

  await requestChatCompletion(
    {
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      model: "local-model",
      messages: [],
      stream: false,
    },
    undefined,
    fakeFetch,
  );

  assert.equal("Authorization" in headers, false);
});

test("requestChatCompletion refuses to send an API key over loopback HTTP", async () => {
  await assert.rejects(
    () => requestChatCompletion(
      {
        baseUrl: "http://localhost:11434/v1",
        apiKey: "must-not-leak",
        model: "local",
        messages: [],
      },
      undefined,
      async () => {
        throw new Error("fetch must not run");
      },
    ),
    /API Key.*HTTPS/,
  );
});

test("readAssistantResponse rejects responses larger than the configured limit", async () => {
  const response = Response.json({ choices: [{ message: { content: "12345" } }] });

  await assert.rejects(
    () => readAssistantResponse(response, undefined, { maxChars: 4 }),
    /超過允許大小/,
  );
});

test("readAssistantResponse caps an unfinished SSE event split across many data lines", async () => {
  const response = fragmentedEventStreamResponse(Array(9_000).fill("data: x\n"));

  await assert.rejects(
    () => readAssistantResponse(response, undefined, { maxChars: 4 }),
    /超過允許大小/,
  );
});

test("readAssistantResponse caps total SSE input even when events produce no output", async () => {
  const response = fragmentedEventStreamResponse(Array(7_000).fill("data: {}\n\n"));

  await assert.rejects(
    () => readAssistantResponse(response, undefined, { maxChars: 4 }),
    /超過允許大小/,
  );
});

test("requestChatCompletion times out a provider that never responds", async () => {
  const neverResponds = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
    });

  await assert.rejects(
    () => requestChatCompletion(
      {
        baseUrl: "https://provider.example/v1",
        apiKey: "secret",
        model: "model",
        messages: [],
        timeoutMs: 5,
      },
      undefined,
      neverResponds,
    ),
    /逾時/,
  );
});
