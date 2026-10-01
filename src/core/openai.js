import { t } from "../i18n/index.js";
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
    throw new TypeError(t("請輸入有效的 API 位址"));
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(t("API 位址必須使用 HTTP 或 HTTPS"));
  }
  if (url.protocol === "http:" && !isLoopback(url)) {
    throw new TypeError(t("遠端 API 位址必須使用 HTTPS；HTTP 僅限本機 loopback 服務"));
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
    throw new TypeError(t("API Key 只能透過 HTTPS 傳送；本機 HTTP 服務請留空 Key"));
  }
  return endpoint.toString();
}

function choiceText(choice) {
  if (choice?.finish_reason === "length") throw new ApiError(t("API 回覆達到長度上限，尚未完成"));
  if (choice?.finish_reason === "content_filter") throw new ApiError(t("API 因內容限制而中止回覆"));
  const message = choice?.message ?? choice?.delta;
  if (!message || typeof message !== "object") {
    throw new ApiError(t("API 回覆格式錯誤：缺少訊息內容"));
  }
  if (message.refusal) throw new ApiError(t("API 拒絕回答：{0}", [message.refusal]));
  const content = message.content ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const text = typeof part === "string" ? part : part?.text;
      if (typeof text !== "string") throw new ApiError(t("API 回覆格式錯誤：內容不是文字"));
      return text;
    }).join("");
  }
  throw new ApiError(t("API 回覆格式錯誤：內容不是文字"));
}

function responseTooLarge() {
  return new ApiError(t("API 回覆超過允許大小"), 413);
}

async function readBodyText(response, maxChars) {
  const declaredLength = Number(response.headers.get("content-length"));
  const oversized = Number.isFinite(declaredLength) && declaredLength > maxChars * 4;
  if (!response.body) {
    if (oversized) throw responseTooLarge();
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    if (oversized) throw responseTooLarge();
    while (true) {
      const { value, done } = await reader.read();
      output += decoder.decode(value, { stream: !done });
      if (output.length > maxChars) throw responseTooLarge();
      if (done) return output;
    }
  } finally {
    // Cleanup must not replace the original read/size error if the stream already failed.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function providerError(response) {
  const raw = await readBodyText(response, MAX_ERROR_CHARS);
  try {
    const body = JSON.parse(raw);
    return body?.error?.message ?? body?.message ?? raw;
  } catch {
    return raw || t("API 回傳 {0}", [response.status]);
  }
}

async function readEventStream(response, onDelta, maxChars) {
  if (!response.body) throw new ApiError(t("API 未回傳文字"));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const maxInputChars = Math.max(maxChars * 4, 64_000);
  let inputChars = 0;
  let buffer = "";
  let eventLines = [];
  let output = "";
  let stopped = false;
  let finished = false;

  function consumeEvent() {
    if (!eventLines.length) return;
    const data = eventLines.join("\n");
    eventLines = [];
    if (data === "[DONE]") {
      stopped = true;
      return;
    }
    const event = JSON.parse(data);
    if (event?.error) throw new ApiError(event.error.message || t("API 回覆失敗"));
    if (!Array.isArray(event?.choices)) throw new ApiError(t("API 回覆格式錯誤：缺少 choices"));
    // The optional final usage chunk contains no choices.
    if (!event.choices.length && event.usage) return;
    const choice = event.choices[0];
    const delta = choiceText(choice);
    if (output.length + delta.length > maxChars) throw responseTooLarge();
    output += delta;
    if (delta) onDelta?.(delta);
    if (choice.finish_reason != null) finished = true;
  }

  try {
    while (!stopped) {
      const { value, done } = await reader.read();
      const decoded = decoder.decode(value, { stream: !done });
      inputChars += decoded.length;
      if (inputChars > maxInputChars) throw responseTooLarge();
      buffer += decoded;

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1 && !stopped) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line === "") consumeEvent();
        else if (line.startsWith("data:")) eventLines.push(line.slice(5).trimStart());
        newlineIndex = buffer.indexOf("\n");
      }
      if (done) break;
    }

    if (!stopped) {
      if (buffer.startsWith("data:")) eventLines.push(buffer.slice(5).trimStart());
      consumeEvent();
    }
    if (!stopped && !finished) throw new ApiError(t("API 回覆中斷，尚未完成"));
    if (!output.trim()) throw new ApiError(t("API 未回傳文字"));
    return output;
  } finally {
    // DONE can precede network EOF. Close it, also preserving any original parsing/rendering error.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
  if (body?.error) throw new ApiError(body.error.message || t("API 回覆失敗"));
  const text = choiceText(body?.choices?.[0]);
  if (text.length > maxChars) throw responseTooLarge();
  if (!text.trim()) throw new ApiError(t("API 未回傳文字"));
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
      redirect: "error",
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
    if (timedOut) throw new ApiError(t("API 回應逾時，請稍後再試"), 408);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
