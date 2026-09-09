import { relayProviderURL, relayState } from "../core/relay-contract.js";

const IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function validateRelayDraft(text, attachments) {
  if (typeof text !== "string" || !text.trim() || text.length > 196_608) throw new Error("附加內容太長或空白，請縮小選取範圍。");
  if (!Array.isArray(attachments) || attachments.length > 8) throw new Error("一次最多附上 8 張圖片。");
  let total = 0;
  const images = attachments.map((item, index) => {
    if (typeof item?.dataUrl !== "string" || item.dataUrl.length > 20_000_000 || !IMAGE.test(item.dataUrl)) throw new Error("有圖片無法附加；請移除後重新擷取。");
    total += item.dataUrl.length;
    if (total > 40_000_000) throw new Error("圖片總大小超過限制，請減少圖片。");
    const ext = item.dataUrl.startsWith("data:image/jpeg;") ? "jpg" : item.dataUrl.slice(11, item.dataUrl.indexOf(";"));
    return { dataUrl: item.dataUrl, name: `SafAI-${index + 1}.${ext}` };
  });
  return { text, attachments: images };
}

// This controller is created only after settings/history initialization succeeds.
// It never stores capabilities or sends page context through native messaging.
export function createRelayPanel({ root, sendCommand, createChannel, pollMs = 5000, timeoutMs = 15000, commandTimeoutMs = 30000 }) {
  const document = root.ownerDocument;
  const view = document.defaultView;
  const frame = root.querySelector("iframe");
  const status = root.querySelector("[data-relay-status]");
  const login = root.querySelector('[data-relay-action="login"]');
  const logout = root.querySelector('[data-relay-action="logout"]');
  const switchAccount = root.querySelector('[data-relay-action="switch"]');
  const reconnect = root.querySelector('[data-relay-action="reconnect"]');
  const makeChannel = createChannel ?? (() => new view.MessageChannel());
  let active = false, destroyed = false, busy = false, intersecting = true;
  let state = null, providerURL = "", port, ready = false;
  let poll, handshakeTimer, handshakePromise, resolveHandshake, rejectHandshake;
  let generation = 0, requestSequence = 0, commandId = 0, statusStarted = false;
  const pending = new Map();
  const nativeWaiters = new Map();

  function visible() { return active && intersecting && document.visibilityState !== "hidden" && !destroyed; }
  function note(message, error = false) { status.textContent = message; status.dataset.error = String(error); }
  function controls() {
    const waiting = busy || ["opening", "waitingForUser", "checking", "restoring"].includes(state?.phase);
    const signedIn = state?.phase === "signedIn";
    login.hidden = signedIn;
    login.disabled = waiting;
    logout.hidden = !signedIn && !waiting;
    logout.disabled = busy;
    switchAccount.hidden = !signedIn;
    switchAccount.disabled = waiting;
    reconnect.hidden = !signedIn && state?.phase !== "blocked" && state !== null;
    reconnect.disabled = waiting;
    root.setAttribute("aria-busy", String(waiting));
  }
  function closeChannel(message = "ChatGPT 連線已變更，請確認登入後再附加。") {
    generation++;
    ready = false;
    view.clearTimeout(handshakeTimer);
    rejectHandshake?.(new Error(message));
    resolveHandshake = rejectHandshake = undefined;
    handshakePromise = undefined;
    port?.close(); port = undefined;
    for (const item of pending.values()) { view.clearTimeout(item.timer); item.reject(new Error(message)); }
    pending.clear();
  }
  function detach(message) {
    closeChannel(message);
    providerURL = "";
    frame.removeAttribute("src");
    frame.hidden = true;
  }
  function connect() {
    closeChannel();
    if (!providerURL || state?.phase !== "signedIn" || destroyed) return;
    const current = generation;
    handshakePromise = new Promise((resolve, reject) => { resolveHandshake = resolve; rejectHandshake = reject; });
    // Loading the provider alone must not create an unhandled promise rejection.
    handshakePromise.catch(() => {});
    try {
      const url = relayProviderURL(providerURL);
      const channel = makeChannel();
      port = channel.port1;
      port.onmessage = event => {
        if (current !== generation || destroyed) return;
        const message = event.data;
        if (message?.type === "READY") {
          ready = true;
          view.clearTimeout(handshakeTimer);
          resolveHandshake?.(); resolveHandshake = rejectHandshake = undefined;
        } else if (message?.type === "RESULT" && typeof message.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(message.id)) {
          const item = pending.get(message.id);
          if (!item) return;
          pending.delete(message.id); view.clearTimeout(item.timer);
          if (message.ok === true) item.resolve();
          else item.reject(new Error(typeof message.error === "string" && message.error.length <= 1024 ? message.error : "ChatGPT 未確認附加內容；你的草稿仍保留。"));
        }
      };
      port.onmessageerror = () => { closeChannel(); note("ChatGPT 連線中斷；請重新連線。你的草稿仍保留。", true); };
      port.start();
      handshakeTimer = view.setTimeout(() => {
        if (current !== generation) return;
        closeChannel(); note("ChatGPT 網頁尚未準備好接收內容；請確認網頁載入，或重新連線。", true);
      }, timeoutMs);
      frame.contentWindow.postMessage({ type: "SAFAI_RELAY_CONNECT", key: url.searchParams.get("__safai_key") }, url.origin, [channel.port2]);
    } catch {
      closeChannel(); note("無法連接 ChatGPT 網頁；你的草稿仍保留。", true);
    }
  }
  function attach(url, force = false) {
    relayProviderURL(url);
    if (!force && providerURL === url && frame.hasAttribute("src")) return;
    closeChannel();
    providerURL = url;
    frame.hidden = false;
    frame.src = url;
  }
  function update(value) {
    const next = relayState(value);
    const changed = !state || state.phase !== next.phase || state.revision !== next.revision || state.providerURL !== next.providerURL;
    state = next;
    // A heartbeat must not replace upload warnings or draft/handshake failures.
    if (changed) note(state.message);
    if (state.phase !== "signedIn") detach();
    else if (visible()) attach(state.providerURL);
    controls();
  }
  function schedule() {
    view.clearTimeout(poll);
    if (visible() && !busy) poll = view.setTimeout(() => { void refresh().catch(() => {}); }, pollMs);
  }
  function boundedCommand(action) {
    // Safari's native runtime message may remain pending. Bound the UI operation
    // independently; expiry is not a logout and must not replay the command.
    const ticket = Symbol(action);
    let timer;
    const operation = new Promise((resolve, reject) => {
      nativeWaiters.set(ticket, reject);
      timer = view.setTimeout(() => {
        const error = new Error("Safari 尚未回覆 ChatGPT 操作；登入狀態尚未確認，你的草稿仍保留。");
        error.code = "RELAY_COMMAND_TIMEOUT";
        reject(error);
      }, commandTimeoutMs);
      Promise.resolve().then(() => sendCommand(action)).then(resolve, reject);
    });
    return operation.finally(() => { view.clearTimeout(timer); nativeWaiters.delete(ticket); });
  }
  async function refresh() {
    if (!visible() || busy) return state;
    const sequence = ++requestSequence;
    if (!statusStarted) { statusStarted = true; note("正在確認 ChatGPT 登入狀態…"); }
    try {
      const result = await boundedCommand("status");
      if (sequence !== requestSequence || destroyed) return state;
      update(result);
      return state;
    } catch (error) {
      if (sequence === requestSequence && !destroyed) {
        state = null; detach(); controls();
        note(error?.code === "RELAY_COMMAND_TIMEOUT" ? error.message : "無法確認 ChatGPT 連線。請稍後重新連線；你的登入與草稿不會因此刪除。", true);
      }
      throw new Error("無法確認 ChatGPT 連線；你的草稿仍保留。");
    } finally { if (sequence === requestSequence) schedule(); }
  }
  async function command(action) {
    if (busy || destroyed) return;
    busy = true;
    const sequence = ++requestSequence;
    view.clearTimeout(poll);
    // Revoke the old frame immediately, not after a potentially slow native reply.
    detach(); controls();
    note(action === "logout" ? "正在登出 ChatGPT…" : action === "reconnect" ? "正在重新確認已儲存的登入；不會傳送對話。" : "請在官方登入視窗完成登入，再返回 Safari。");
    try {
      const result = await boundedCommand(action);
      if (sequence === requestSequence && !destroyed) update(result);
    } catch (error) {
      if (sequence === requestSequence && !destroyed) { state = null; note(error?.code === "RELAY_COMMAND_TIMEOUT" ? error.message : "ChatGPT 操作未成功；你的草稿仍保留，請稍後重試。", true); }
    } finally { busy = false; if (!destroyed) { controls(); schedule(); } }
  }
  async function prepareDraft(text, attachments = []) {
    const draft = validateRelayDraft(text, attachments);
    if (pending.size) throw new Error("請等待目前的附加操作完成。");
    if (!visible() || busy) throw new Error("請先切換到 ChatGPT 並完成登入。");
    const requestedProviderURL = providerURL;
    await refresh();
    if (requestedProviderURL && requestedProviderURL !== providerURL) {
      const message = "登入或連線已變更，請確認目前帳號後再附加；草稿仍保留。";
      note(message, true);
      throw new Error(message);
    }
    if (state?.phase !== "signedIn" || !providerURL) throw new Error("請先登入 ChatGPT，再附加內容。");
    // A status check may attach a newly restored session; wait for its load handshake.
    if (!handshakePromise && !ready) throw new Error("ChatGPT 網頁仍在載入，請稍候再附加。");
    const current = generation;
    if (!ready) await handshakePromise;
    if (current !== generation || !ready || !port || !visible()) throw new Error("ChatGPT 連線已變更；你的草稿仍保留。");
    const id = `draft-${++commandId}`;
    note("正在附加到 ChatGPT 草稿，不會自動送出…");
    try {
      await new Promise((resolve, reject) => {
        const timer = view.setTimeout(() => {
          pending.delete(id);
          reject(new Error("尚未收到附加確認。請先檢查 ChatGPT 草稿與圖片，避免重複附加；SafAI 草稿仍保留。"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { port.postMessage({ type: "PREPARE_DRAFT", id, ...draft }); }
        catch { view.clearTimeout(timer); pending.delete(id); reject(new Error("無法附加到 ChatGPT；你的草稿仍保留。")); }
      });
      note("已附到 ChatGPT，請確認草稿與圖片上傳完成後再送出。");
    } catch (error) { note(error.message, true); throw error; }
  }
  const listeners = [];
  function on(target, event, callback) { target.addEventListener(event, callback); listeners.push(() => target.removeEventListener(event, callback)); }
  on(frame, "load", connect);
  on(login, "click", () => { void command("login"); });
  on(logout, "click", () => { void command("logout"); });
  on(switchAccount, "click", () => { void command("switch"); });
  on(reconnect, "click", () => { void command("reconnect"); });
  const focus = () => { if (visible()) void refresh().catch(() => {}); else view.clearTimeout(poll); };
  on(view, "focus", focus); on(document, "visibilitychange", focus);
  if (typeof view.IntersectionObserver === "function") {
    const observer = new view.IntersectionObserver(entries => {
      const entry = entries.find(item => item.target === root);
      if (!entry || intersecting === entry.isIntersecting) return;
      intersecting = entry.isIntersecting;
      focus();
    });
    observer.observe(root);
    listeners.push(() => observer.disconnect());
  }
  controls();
  return {
    setActive(value) {
      const changed = active !== Boolean(value);
      active = Boolean(value); root.hidden = !active;
      if (!active) view.clearTimeout(poll);
      else if (changed) void refresh().catch(() => {});
    },
    refresh, prepareDraft,
    newChat() { if (state?.phase === "signedIn" && !busy) attach(state.providerURL, true); },
    destroy() {
      destroyed = true; ++requestSequence; view.clearTimeout(poll); detach();
      for (const reject of nativeWaiters.values()) reject(new Error("側欄已關閉"));
      nativeWaiters.clear();
      listeners.forEach(remove => remove());
    },
  };
}
