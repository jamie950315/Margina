// Runs only in the unprivileged, locally relayed provider page, never in the extension panel.
(() => {
  "use strict";
  const bootstrap = document.currentScript;
  const key = new URL(bootstrap.src).searchParams.get("__safai_key");
  const localOrigin = location.origin;
  const allowed = new Set(["chatgpt.com", "cdn.oaistatic.com", "persistent.oaistatic.com", "auth.openai.com"]);
  if (!key || !/^[a-f0-9]{64}$/.test(key)) throw new Error("SafAI relay bootstrap is invalid");
  const clean = new URL(location.href);
  clean.searchParams.delete("__safai_key");
  history.replaceState(history.state, "", clean);

  function route(input, capability = true) {
    const target = new URL(input, location.href);
    if (target.protocol !== "http:" && target.protocol !== "https:") return target;
    if (target.origin !== localOrigin) {
      if (target.protocol !== "https:" || target.port || !allowed.has(target.hostname)) return target;
      const pathname = target.hostname === "chatgpt.com" ? target.pathname : `/__safai/upstream/${target.hostname}${target.pathname}`;
      const mapped = new URL(pathname + target.search + target.hash, localOrigin);
      if (capability) mapped.searchParams.set("__safai_key", key);
      return mapped;
    }
    if (capability) target.searchParams.set("__safai_key", key);
    return target;
  }

  const originalFetch = window.fetch.bind(window);
  async function bufferedBody(request, signal) {
    if (signal?.aborted) throw signal.reason;
    if (!request.body) return new ArrayBuffer(0);
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (signal?.aborted) throw signal.reason;
        if (done) break;
        size += value.byteLength;
        if (size > 32 * 1024 * 1024) {
          // Source cleanup is best-effort; a stalled cancel must not retain the
          // buffered upload or delay the explicit size-limit rejection.
          reader.cancel("upload limit").catch(() => {});
          throw new RangeError("Relay upload exceeds 32 MiB");
        }
        chunks.push(value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return body.buffer;
    } finally {
      signal?.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  }
  window.fetch = async function relayFetch(input, init) {
    const original = input instanceof Request ? input : null;
    const target = route(original ? original.url : String(input), false);
    if (target.origin !== localOrigin || !["http:", "https:"].includes(target.protocol)) return originalFetch(input, init);
    const options = { ...(original ? {
      method: original.method, headers: original.headers, signal: original.signal,
      credentials: original.credentials, redirect: original.redirect, cache: original.cache,
    } : {}), ...init };
    if (original && original.method !== "GET" && original.method !== "HEAD" && init?.body === undefined) {
      options.body = await bufferedBody(original, options.signal);
    }
    const headers = new Headers(options.headers);
    headers.set("X-SafAI-Relay", key);
    return originalFetch(target.href, { ...options, headers, referrerPolicy: "no-referrer" });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const xhrLocal = new WeakSet();
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const target = route(String(url), false);
    if (target.origin === localOrigin && ["http:", "https:"].includes(target.protocol)) xhrLocal.add(this); else xhrLocal.delete(this);
    return originalOpen.call(this, method, target.href, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (xhrLocal.has(this)) this.setRequestHeader("X-SafAI-Relay", key);
    return originalSend.call(this, body);
  };

  const originalAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (["src", "href", "action", "poster"].includes(String(name).toLowerCase()) && typeof value === "string" && !/^(?:data:|blob:|#)/i.test(value)) {
      try { value = route(value).href; } catch { /* Browser handles an invalid URL normally. */ }
    }
    return originalAttribute.call(this, name, value);
  };
  for (const [prototype, property] of [[HTMLImageElement.prototype, "src"], [HTMLScriptElement.prototype, "src"], [HTMLLinkElement.prototype, "href"], [HTMLIFrameElement.prototype, "src"]]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor?.set || !descriptor.configurable) continue;
    Object.defineProperty(prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, route(String(value)).href); } });
  }
  document.addEventListener("click", event => {
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor || anchor.getAttribute("href").startsWith("#")) return;
    const mapped = route(anchor.href);
    if (mapped.origin === localOrigin) originalAttribute.call(anchor, "href", mapped.href);
  }, true);
  document.addEventListener("submit", event => {
    const form = event.target;
    if (form instanceof HTMLFormElement) originalAttribute.call(form, "action", route(form.action).href);
  }, true);
  // The only parent command prepares a user-requested draft. It cannot read
  // conversations, export cookies, invoke native controls, or press Send.
  let draftPort;
  const completedDrafts = new Map();
  function prepareDraft(message) {
    const { text, attachments } = message;
    if (typeof text !== "string" || !text.trim() || text.length > 196608 ||
        !Array.isArray(attachments) || attachments.length > 8) throw new Error("草稿或圖片超過支援範圍，未附上內容。");
    const editors = Array.from(document.querySelectorAll('#prompt-textarea')).filter(node =>
      node instanceof HTMLTextAreaElement || node.getAttribute("contenteditable") === "true");
    if (editors.length !== 1 || editors[0].disabled || editors[0].getAttribute("aria-disabled") === "true") throw new Error("ChatGPT 輸入框尚未就緒，請等待畫面載入後再試。");
    const editor = editors[0];
    const currentText = editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent;
    if (currentText?.trim()) throw new Error("ChatGPT 已有未送出的草稿，請先送出或清空它；SafAI 沒有覆蓋內容。");
    let input, transfer;
    if (attachments.length) {
      const composerForm = editor.closest("form");
      const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(node => !node.disabled &&
        (!composerForm || node.form === composerForm) &&
        (!node.accept || /image|\.png|\.jpe?g/i.test(node.accept)) && (node.multiple || attachments.length === 1));
      if (inputs.length !== 1 || typeof DataTransfer !== "function") throw new Error("ChatGPT 圖片上傳尚未就緒；請先展開附件選單後再試，內容仍保留在 SafAI。");
      input = inputs[0];
      if (input.files?.length) throw new Error("ChatGPT 已有選取的圖片，請先完成目前草稿。");
      transfer = new DataTransfer();
      // Readiness checks above avoid decoding large images that cannot be handed off.
      let total = 0;
      const files = attachments.map((attachment, index) => {
        const data = attachment?.dataUrl;
        if (typeof data !== "string" || data.length > 20000000 || (total += data.length) > 40000000) throw new Error("圖片過大，未附上內容。");
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
        if (!match) throw new Error("圖片格式不支援，未附上內容。");
        const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
        const suffix = match[1] === "image/jpeg" ? "jpg" : match[1].slice(6);
        return new File([bytes], `SafAI-${index + 1}.${suffix}`, { type: match[1] });
      });
      files.forEach(file => transfer.items.add(file));
    }
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(editor, text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // Editing through the browser's text operation updates the site's editor
      // state; replacing innerHTML would leave its internal document stale.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand("insertText", false, text)) throw new Error("ChatGPT 暫時無法接收草稿，內容仍保留在 SafAI。");
    }
    if (input) {
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  window.addEventListener("message", event => {
    if (event.source !== window.parent || window.parent === window ||
        !/^safari-web-extension:\/\/[A-Za-z0-9-]+$/.test(event.origin) ||
        event.data?.type !== "SAFAI_RELAY_CONNECT" || event.data.key !== key || event.ports?.length !== 1) return;
    draftPort?.close();
    const port = event.ports[0];
    draftPort = port;
    port.onmessage = event => {
      const message = event.data;
      if (draftPort !== port || message?.type !== "PREPARE_DRAFT" || typeof message.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(message.id)) return;
      let result = completedDrafts.get(message.id);
      if (!result) {
        try { prepareDraft(message); result = { type: "RESULT", id: message.id, ok: true }; }
        catch (error) { result = { type: "RESULT", id: message.id, ok: false, error: error?.message || "無法附上草稿，內容仍保留在 SafAI。" }; }
        completedDrafts.set(message.id, result);
        if (completedDrafts.size > 16) completedDrafts.delete(completedDrafts.keys().next().value);
      }
      port.postMessage(result);
    };
    port.start();
    port.postMessage({ type: "READY" });
  });
})();
