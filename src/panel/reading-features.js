import { parseQuickPrompts, serializeQuickPrompts } from "../core/quick-prompts.js";
import { parseDisabledSelectionSites, selectionSiteHostname } from "../core/settings.js";

export function createReadingFeatures({ document, settings, page, saveSettings, request, attach, usePrompt, notify, canOpen, setModal }) {
  const sheet = document.getElementById("readingSheet");
  const title = document.getElementById("readingTitle");
  const content = document.getElementById("readingContent");
  const closeButton = document.getElementById("closeReadingButton");
  let trigger;
  let epoch = 0;
  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function button(text, action, label) {
    const item = node("button", text, "reading-button");
    item.type = "button";
    if (label) item.setAttribute("aria-label", label);
    item.addEventListener("click", action);
    return item;
  }
  function open(name) {
    if (!canOpen()) return false;
    trigger = document.getElementById("attachButton") || document.activeElement;
    epoch++;
    title.textContent = name;
    content.replaceChildren();
    sheet.hidden = false;
    setModal(true);
    closeButton.focus();
    return true;
  }
  function close() {
    epoch++;
    sheet.hidden = true;
    setModal(false);
    trigger?.focus?.();
  }
  closeButton.addEventListener("click", close);
  sheet.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key !== "Tab") return;
    const items = [...sheet.querySelectorAll("button,input,textarea,summary")].filter(el => !el.disabled && !el.closest("[hidden]"));
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  async function openTabs() {
    if (!open("比較分頁")) return;
    const current = epoch;
    content.append(node("p", "勾選最多 3 個分頁。只讀取你選的內容，按傳送才交給 AI。比較時不另外附上目前頁面。", "reading-note"));
    const status = node("p", "正在取得分頁清單…", "reading-note");
    content.append(status);
    try {
      const result = await request("LIST_READING_TABS");
      if (current !== epoch) return;
      status.textContent = result.tabs.length ? "" : "這個視窗沒有可讀取的一般網頁。";
      const selected = new Map();
      for (const tab of result.tabs) {
        const row = node("label", "", "reading-tab");
        const check = node("input"); check.type = "checkbox";
        check.setAttribute("aria-label", `比較 ${tab.title}`);
        const text = node("span");
        text.append(node("strong", tab.title), node("small", tab.url));
        row.append(check, text); content.append(row);
        check.addEventListener("change", () => {
          if (check.checked && selected.size >= 3) { check.checked = false; notify("最多選擇 3 個分頁", "error"); return; }
          if (check.checked) selected.set(tab.id, { id: tab.id, url: tab.url });
          else selected.delete(tab.id);
        });
      }
      const confirm = button("讀取並附上所選分頁", async () => {
        if (!selected.size) { notify("請至少勾選一個分頁", "error"); return; }
        confirm.disabled = true;
        const checks = [...content.querySelectorAll('input[type="checkbox"]')];
        checks.forEach(check => { check.disabled = true; });
        status.textContent = "正在讀取所選分頁…";
        try {
          const result = await request("READ_READING_TABS", { items: [...selected.values()] });
          if (current !== epoch) return;
          attach(result.pages);
          close();
          notify("已附上分頁快照；可預覽或移除，尚未傳送");
        } catch (error) {
          if (current === epoch) { status.textContent = error.message; notify(error.message, "error"); }
        } finally { confirm.disabled = false; checks.forEach(check => { check.disabled = false; }); }
      });
      confirm.classList.add("primary-button");
      content.append(confirm);
    } catch (error) {
      if (current === epoch) status.textContent = error.message;
    }
  }

  function openSelectionSettings() {
    if (!open("反白文字選單")) return;
    const current = epoch;
    const hostname = selectionSiteHostname(page()?.url);
    function render() {
      content.replaceChildren();
      const saved = settings();
      const sites = parseDisabledSelectionSites(saved.selectionToolsDisabledSites);
      async function update(patch, expected) {
        const focusId = document.activeElement?.id;
        content.querySelectorAll("button,input").forEach(item => { item.disabled = true; });
        try {
          await saveSettings(patch, expected);
          notify("反白文字選單設定已儲存");
        } catch (error) { notify(error.message, "error"); }
        finally {
          if (current === epoch) {
            render();
            (document.getElementById(focusId) || document.getElementById("disableSelectionSite"))?.focus();
          }
        }
      }
      const globalLabel = node("label", "", "reading-tab");
      const globalToggle = node("input");
      globalToggle.type = "checkbox";
      globalToggle.checked = saved.selectionTools;
      globalToggle.id = "enableSelectionMenu";
      globalLabel.append(globalToggle, node("span", "反白文字時顯示快速提問"));
      globalToggle.addEventListener("change", () => update({ selectionTools: globalToggle.checked }, { selectionTools: saved.selectionTools }));
      const siteLabel = node("label", "", "reading-tab");
      const siteToggle = node("input");
      siteToggle.type = "checkbox";
      siteToggle.id = "disableSelectionSite";
      siteToggle.checked = sites.includes(hostname);
      siteToggle.disabled = !hostname;
      const siteText = node("span");
      siteText.append(node("strong", "在此網站關閉選單"), node("small", hostname || "請回到一般網頁後重新開啟設定"));
      siteLabel.append(siteToggle, siteText);
      siteToggle.addEventListener("change", () => {
        const next = siteToggle.checked ? [...sites, hostname] : sites.filter(site => site !== hostname);
        update({ selectionToolsDisabledSites: next.sort().join("\n") }, { selectionToolsDisabledSites: saved.selectionToolsDisabledSites });
      });
      content.append(globalLabel, siteLabel,
        node("p", "變更立即儲存，套用至此網域的所有頁面。子網域各自設定；只關閉浮動選單，仍可在側欄使用反白文字。", "reading-note"),
        node("h3", "已關閉選單的網站"));
      if (!sites.length) content.append(node("p", "尚未關閉任何網站。", "reading-note"));
      for (const site of sites) {
        const row = node("div", "", "reading-command selection-site-row");
        const label = node("span", site);
        const restore = button("恢復", () => update({ selectionToolsDisabledSites: sites.filter(other => other !== site).join("\n") },
          { selectionToolsDisabledSites: saved.selectionToolsDisabledSites }), `恢復 ${site} 的反白文字選單`);
        row.append(label, restore);
        content.append(row);
      }
    }
    render();
  }

  function openCommands() {
    if (!open("常用指令")) return;
    const initial = settings().quickPrompts;
    let items = parseQuickPrompts(initial);
    let editing = null;
    content.append(node("p", "選擇指令帶入草稿，不會自動傳送。可調整順序；編輯後請按儲存。", "reading-note"));
    const toggleLabel = node("label", "", "reading-tab");
    const toggle = node("input"); toggle.type = "checkbox"; toggle.checked = settings().selectionTools;
    toggleLabel.append(toggle, node("span", "反白文字時顯示快速提問"));
    toggle.addEventListener("change", async () => {
      const previous = settings().selectionTools;
      toggle.disabled = true;
      try { await saveSettings({ selectionTools: toggle.checked }, { selectionTools: previous }); }
      catch (error) { toggle.checked = previous; notify(error.message, "error"); }
      finally { toggle.disabled = false; }
    });
    const list = node("div", "", "reading-command-list");
    const nameLabel = node("label", "指令名稱", "field");
    const name = node("input"); name.maxLength = 32; nameLabel.append(name);
    const promptLabel = node("label", "指令內容", "field");
    const prompt = node("textarea"); prompt.maxLength = 2000; prompt.rows = 4; promptLabel.append(prompt);
    function render() {
      list.replaceChildren();
      items.forEach((item, index) => {
        const row = node("div", "", "reading-command");
        const use = button(item.title, () => { close(); usePrompt(item.prompt); });
        use.classList.add("command-use");
        const controls = node("div", "", "reading-command-actions");
        controls.append(button("編輯", () => { editing = item.id; name.value = item.title; prompt.value = item.prompt; name.focus(); }),
          button("↑", () => { if (index > 0) { [items[index - 1], items[index]] = [items[index], items[index - 1]]; render(); } }, `上移 ${item.title}`),
          button("↓", () => { if (index < items.length - 1) { [items[index + 1], items[index]] = [items[index], items[index + 1]]; render(); } }, `下移 ${item.title}`),
          button("移除", () => { items = items.filter(other => other.id !== item.id); if (editing === item.id) editing = null; render(); }, `移除指令 ${item.title}`));
        row.append(use, controls); list.append(row);
      });
    }
    const update = button("加入／更新指令", () => {
      try {
        const item = { id: editing ?? document.defaultView.crypto.randomUUID(), title: name.value.trim(), prompt: prompt.value.trim() };
        const next = editing ? items.map(old => old.id === editing ? item : old) : [...items, item];
        items = parseQuickPrompts(serializeQuickPrompts(next));
        editing = null; name.value = ""; prompt.value = ""; render();
      } catch (error) { notify(error.message, "error"); }
    });
    const save = button("儲存指令", async () => {
      if (name.value.trim() || prompt.value.trim()) { notify("請先按「加入／更新指令」保存編輯欄內容", "error"); return; }
      save.disabled = true;
      try {
        await saveSettings({ quickPrompts: serializeQuickPrompts(items) }, { quickPrompts: initial });
        close(); notify("常用指令已儲存");
      } catch (error) { notify(error.message, "error"); }
      finally { save.disabled = false; }
    });
    save.classList.add("primary-button");
    content.append(toggleLabel, list, nameLabel, promptLabel, update, save);
    render();
  }
  return { openTabs, openCommands, openSelectionSettings, close, get isOpen() { return !sheet.hidden; } };
}
