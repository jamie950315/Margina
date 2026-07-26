export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_CHARS = 200_000;
const MAX_ERROR_CHARS = 64_000;

function isLoopback(url) {
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function resolveChatCompletionsUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? "").trim());
  } catch {
    throw new TypeError("請輸入有效的 API 位址");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("API 位址必須使用 HTTP 或 HTTPS");
  }
  if (url.protocol === "http:" && !isLoopback(url)) {
    throw new TypeError("遠端 API 位址必須使用 HTTPS；HTTP 僅限本機 loopback 服務");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) {
    url.pathname = `${path}/chat/completions`.replace(/^\/$/, "/chat/completions");
  }

  return url.toString();
}

export function assertEndpointSecurity(baseUrl, apiKey = "") {
  const endpoint = new URL(resolveChatCompletionsUrl(baseUrl));
  if (endpoint.protocol === "http:" && String(apiKey).trim()) {
    throw new TypeError("API Key 只能透過 HTTPS 傳送；本機 HTTP 服務請留空 Key");
  }
  return endpoint.toString();
}

function choiceText(choice) {
  const content = choice?.message?.content ?? choice?.delta?.content ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
    .join("");
}

function responseTooLarge() {
  return new ApiError("API 回覆超過允許大小", 413);
}

async function readBodyText(response, maxChars) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxChars * 4) {
    throw responseTooLarge();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    output += decoder.decode(value, { stream: !done });
    if (output.length > maxChars) {
      await reader.cancel().catch(() => {});
      throw responseTooLarge();
    }
    if (done) return output;
  }
}

async function providerError(response) {
  const raw = await readBodyText(response, MAX_ERROR_CHARS);
  try {
    const body = JSON.parse(raw);
    return body?.error?.message ?? body?.message ?? raw;
  } catch {
    return raw || `API 回傳 ${response.status}`;
  }
}

function parseEventData(lines, onDelta, output) {
  if (lines.length === 0) return { done: false, output };
  const data = lines.join("\n");
  if (data === "[DONE]") return { done: true, output };

  try {
    const event = JSON.parse(data);
    const delta = choiceText(event?.choices?.[0]);
    if (delta) {
      onDelta?.(delta);
      return { done: false, output: output + delta };
    }
  } catch {
    // Ignore provider keep-alives and non-JSON SSE events.
  }
  return { done: false, output };
}

async function readEventStream(response, onDelta, maxChars) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const maxInputChars = Math.max(maxChars * 4, 64_000);
  let inputChars = 0;
  let buffer = "";
  let eventLines = [];
  let output = "";
  let stopped = false;

  while (!stopped) {
    const { value, done } = await reader.read();
    const decoded = decoder.decode(value, { stream: !done });
    inputChars += decoded.length;
    if (inputChars > maxInputChars) {
      await reader.cancel().catch(() => {});
      throw responseTooLarge();
    }
    buffer += decoded;

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);

      if (line === "") {
        const result = parseEventData(eventLines, onDelta, output);
        eventLines = [];
        output = result.output;
        if (output.length > maxChars) {
          await reader.cancel().catch(() => {});
          throw responseTooLarge();
        }
        if (result.done) {
          stopped = true;
          break;
        }
      } else if (line.startsWith("data:")) {
        eventLines.push(line.slice(5).trimStart());
      }

      newlineIndex = buffer.indexOf("\n");
    }

    if (done) break;
  }

  if (!stopped && buffer.trimStart().startsWith("data:")) {
    eventLines.push(buffer.trimStart().slice(5).trimStart());
  }
  if (!stopped && eventLines.length) {
    output = parseEventData(eventLines, onDelta, output).output;
  }
  if (output.length > maxChars) throw responseTooLarge();

  return output;
}

export async function readAssistantResponse(
  response,
  onDelta,
  { maxChars = DEFAULT_MAX_RESPONSE_CHARS } = {},
) {
  if (!response.ok) {
    throw new ApiError(await providerError(response), response.status);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return readEventStream(response, onDelta, maxChars);
  }

  const raw = await readBodyText(response, Math.max(maxChars * 4, 64_000));
  const body = JSON.parse(raw);
  const text = choiceText(body?.choices?.[0]);
  if (text.length > maxChars) throw responseTooLarge();
  return text;
}

export async function requestChatCompletion(
  {
    baseUrl,
    apiKey,
    model,
    messages,
    stream = true,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseChars = DEFAULT_MAX_RESPONSE_CHARS,
  },
  onDelta,
  fetchImpl = fetch,
) {
  const endpoint = assertEndpointSecurity(baseUrl, apiKey);
  const headers = { "Content-Type": "application/json" };
  const normalizedKey = String(apiKey ?? "").trim();
  if (normalizedKey) headers.Authorization = `Bearer ${normalizedKey}`;

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("API request timed out", "TimeoutError"));
  }, Math.max(1, timeoutMs));

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: String(model ?? "").trim(),
        messages,
        stream: Boolean(stream),
      }),
      signal: controller.signal,
    });
    return await readAssistantResponse(response, onDelta, {
      maxChars: maxResponseChars,
    });
  } catch (error) {
    if (timedOut) throw new ApiError("API 回應逾時，請稍後再試", 408);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
