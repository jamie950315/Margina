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
          await reader.cancel("upload limit");
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
    if (target.origin !== localOrigin) return originalFetch(input, init);
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
    if (target.origin === localOrigin) xhrLocal.add(this); else xhrLocal.delete(this);
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
  // No postMessage receiver, extension API access, cookie export, or automatic prompt sending.
})();
