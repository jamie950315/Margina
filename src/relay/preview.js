(() => {
  const bootstrap = new URLSearchParams(location.hash.slice(1)).get("bootstrap");
  history.replaceState(history.state, "", location.pathname + location.search);
  let key;
  let providerURL = "";
  const frame = document.getElementById("provider");
  const status = document.getElementById("status");
  const providerStatus = document.getElementById("provider-status");
  const login = document.getElementById("login");
  const load = document.getElementById("load");
  const cancel = document.getElementById("cancel");
  let revision = -1;
  let poll;
  let phase = "signedOut";
  login.disabled = true; load.disabled = true;
  function openProvider() {
    if (!providerURL) return;
    const url = new URL(providerURL);
    if (url.protocol !== "http:" || !/^safai-provider-[a-f0-9-]{36}\.localhost$/.test(url.hostname) || url.port === location.port || url.username || url.password || url.pathname !== "/") throw new Error("Invalid relay origin");
    frame.src = url.href;
    providerStatus.textContent = "ChatGPT 畫面載入中；對話與附件仍需另外驗證。";
  }
  function update(state) {
    if (!Number.isInteger(state.revision) || state.revision < revision) return;
    const changed = revision !== state.revision;
    revision = state.revision;
    phase = state.phase;
    providerURL = state.providerURL || "";
    status.textContent = state.message;
    const waiting = ["opening", "waitingForUser", "checking"].includes(phase);
    login.disabled = waiting || phase === "signedIn";
    load.disabled = !providerURL;
    cancel.hidden = phase === "signedOut";
    if (!providerURL) { frame.removeAttribute("src"); providerStatus.textContent = ""; }
    if (phase === "signedIn" && changed) openProvider();
    clearTimeout(poll);
    if (waiting) poll = setTimeout(() => request("/__safai/status").catch(failed), 1500);
  }
  function failed() { clearTimeout(poll); providerStatus.textContent = ""; status.textContent = "本機控制操作未成功；沒有自動登入或重送對話。"; }
  async function request(path, method = "GET") {
    const response = await fetch(path, { method, headers: { "X-SafAI-Control": key }, cache: "no-store", referrerPolicy: "no-referrer" });
    if (!response.ok && response.status !== 409) throw new Error("Control request failed");
    const result = await response.json();
    update(result.state || result);
  }
  load.addEventListener("click", () => { try { openProvider(); } catch { failed(); } });
  login.addEventListener("click", () => request("/__safai/login/start", "POST").catch(failed));
  cancel.addEventListener("click", () => {
    frame.removeAttribute("src");
    providerStatus.textContent = "";
    request("/__safai/login/cancel", "POST").catch(failed);
  });
  async function initialize() {
    if (!bootstrap || !/^[a-f0-9]{64}$/.test(bootstrap)) {
      status.textContent = "請從選單列的「SafAI 中轉測試」開啟控制頁；直接輸入本機網址不會取得登入權限。";
      return;
    }
    const response = await fetch("/__safai/bootstrap", { method: "POST", headers: { "X-SafAI-Bootstrap": bootstrap }, cache: "no-store", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error("Native bootstrap expired");
    const result = await response.json();
    if (!/^[a-f0-9]{64}$/.test(result.controlKey)) throw new Error("Invalid control capability");
    key = result.controlKey;
    await request("/__safai/status");
  }
  initialize().catch(failed);
})();
