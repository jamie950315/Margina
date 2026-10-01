import { t } from "../i18n/index.js";
import { DEFAULT_QUICK_PROMPTS, parseQuickPrompts, serializeQuickPrompts } from "../core/quick-prompts.js";
import { parseDisabledSelectionSites, selectionSiteHostname } from "../core/settings.js";

export function createReadingFeatures({ document, settings, page, saveSettings, request, attach, usePrompt, notify, canOpen, setModal }) {
  const sheet = document.getElementById("readingSheet");
  const title = document.getElementById("readingTitle");
  const content = document.getElementById("readingContent");
  const closeButton = document.getElementById("closeReadingButton");
  let trigger;
  let epoch = 0;
  let refreshDefaults;
  const localizedTexts = new Map();
  const localizedLabels = new Map();
  function localizedText(element, source, values = []) {
    if (element.firstChild) localizedTexts.delete(element.firstChild);
    element.textContent = t(source, values);
    if (element.firstChild) localizedTexts.set(element.firstChild, { source, values });
  }
  function localizedLabel(element, source, values = []) {
    element.setAttribute("aria-label", t(source, typeof values === "function" ? values() : values));
    localizedLabels.set(element, { source, values });
  }
  function refreshLanguage() {
    if (sheet.hidden) return;
    refreshDefaults?.();
    for (const [text, { source, values }] of localizedTexts) {
      if (text.isConnected) text.textContent = t(source, values);
      else localizedTexts.delete(text);
    }
    for (const [element, { source, values }] of localizedLabels) {
      if (element.isConnected) element.setAttribute("aria-label", t(source, typeof values === "function" ? values() : values));
      else localizedLabels.delete(element);
    }
  }
  function pruneTranslations() {
    for (const text of localizedTexts.keys()) if (!text.isConnected) localizedTexts.delete(text);
    for (const element of localizedLabels.keys()) if (!element.isConnected) localizedLabels.delete(element);
  }
  function clearContent() {
    content.replaceChildren();
    pruneTranslations();
  }
  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function localizedNode(tag, source, className) {
    const item = node(tag, "", className);
    localizedText(item, source);
    return item;
  }
  function button(text, action, label) {
    const item = node("button", text, "reading-button");
    item.type = "button";
    if (label) localizedLabel(item, label.source, label.values);
    item.addEventListener("click", action);
    return item;
  }
  function localizedButton(source, action, label) {
    const item = button("", action, label);
    localizedText(item, source);
    return item;
  }
  function open(name) {
    if (!canOpen()) return false;
    trigger = document.getElementById("attachButton") || document.activeElement;
    epoch++;
    localizedTexts.clear();
    localizedLabels.clear();
    refreshDefaults = undefined;
    localizedText(title, name);
    clearContent();
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
    content.append(localizedNode("p", "勾選最多 3 個分頁。只讀取你選的內容，按傳送才交給 AI。比較時不另外附上目前頁面。", "reading-note"));
    const status = localizedNode("p", "正在取得分頁清單…", "reading-note");
    content.append(status);
    try {
      const result = await request("LIST_READING_TABS");
      if (current !== epoch) return;
      if (result.tabs.length) status.textContent = "";
      else localizedText(status, "這個視窗沒有可讀取的一般網頁。");
      const selected = new Map();
      for (const tab of result.tabs) {
        const row = node("label", "", "reading-tab");
        const check = node("input"); check.type = "checkbox";
        localizedLabel(check, "比較 {0}", [tab.title]);
        const text = node("span");
        text.append(node("strong", tab.title), node("small", tab.url));
        row.append(check, text); content.append(row);
        check.addEventListener("change", () => {
          if (check.checked && selected.size >= 3) { check.checked = false; notify(t("最多選擇 3 個分頁"), "error"); return; }
          if (check.checked) selected.set(tab.id, { id: tab.id, url: tab.url });
          else selected.delete(tab.id);
        });
      }
      const confirm = localizedButton("讀取並附上所選分頁", async () => {
        if (!selected.size) { notify(t("請至少勾選一個分頁"), "error"); return; }
        confirm.disabled = true;
        const checks = [...content.querySelectorAll('input[type="checkbox"]')];
        checks.forEach(check => { check.disabled = true; });
        localizedText(status, "正在讀取所選分頁…");
        try {
          const result = await request("READ_READING_TABS", { items: [...selected.values()] });
          if (current !== epoch) return;
          attach(result.pages);
          close();
          notify(t("已附上分頁快照；可預覽或移除，尚未傳送"));
        } catch (error) {
          if (current === epoch) { localizedText(status, error.message); notify(t(error.message), "error"); }
        } finally { confirm.disabled = false; checks.forEach(check => { check.disabled = false; }); }
      });
      confirm.classList.add("primary-button");
      content.append(confirm);
    } catch (error) {
      if (current === epoch) localizedText(status, error.message);
    }
  }

  function openSelectionSettings() {
    if (!open("反白文字選單")) return;
    const current = epoch;
    const hostname = selectionSiteHostname(page()?.url);
    function render() {
      clearContent();
      const saved = settings();
      const sites = parseDisabledSelectionSites(saved.selectionToolsDisabledSites);
      async function update(patch, expected) {
        const focusId = document.activeElement?.id;
        content.querySelectorAll("button,input").forEach(item => { item.disabled = true; });
        try {
          await saveSettings(patch, expected);
          notify(t("反白文字選單設定已儲存"));
        } catch (error) { notify(t(error.message), "error"); }
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
      globalLabel.append(globalToggle, localizedNode("span", "反白文字時顯示快速提問"));
      globalToggle.addEventListener("change", () => update({ selectionTools: globalToggle.checked }, { selectionTools: saved.selectionTools }));
      const siteLabel = node("label", "", "reading-tab");
      const siteToggle = node("input");
      siteToggle.type = "checkbox";
      siteToggle.id = "disableSelectionSite";
      siteToggle.checked = sites.includes(hostname);
      siteToggle.disabled = !hostname;
      const siteText = node("span");
      siteText.append(localizedNode("strong", "在此網站關閉選單"), hostname ? node("small", hostname) : localizedNode("small", "請回到一般網頁後重新開啟設定"));
      siteLabel.append(siteToggle, siteText);
      siteToggle.addEventListener("change", () => {
        const next = siteToggle.checked ? [...sites, hostname] : sites.filter(site => site !== hostname);
        update({ selectionToolsDisabledSites: next.sort().join("\n") }, { selectionToolsDisabledSites: saved.selectionToolsDisabledSites });
      });
      content.append(globalLabel, siteLabel,
        localizedNode("p", "變更立即儲存，套用至此網域的所有頁面。子網域各自設定；只關閉浮動選單，仍可在側欄使用反白文字。", "reading-note"),
        localizedNode("h3", "已關閉選單的網站"));
      if (!sites.length) content.append(localizedNode("p", "尚未關閉任何網站。", "reading-note"));
      for (const site of sites) {
        const row = node("div", "", "reading-command selection-site-row");
        const label = node("span", site);
        const restore = localizedButton("恢復", () => update({ selectionToolsDisabledSites: sites.filter(other => other !== site).join("\n") },
          { selectionToolsDisabledSites: saved.selectionToolsDisabledSites }), { source: "恢復 {0} 的反白文字選單", values: [site] });
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
    const defaults = new Map(initial ? [] : DEFAULT_QUICK_PROMPTS.map(item => [item.id, item]));
    refreshDefaults = () => {
      for (const item of items) {
        const source = defaults.get(item.id);
        if (source) { item.title = t(source.title); item.prompt = t(source.prompt); }
      }
    };
    let editing = null;
    content.append(localizedNode("p", "選擇指令帶入草稿，不會自動傳送。可調整順序；編輯後請按儲存。", "reading-note"));
    const toggleLabel = node("label", "", "reading-tab");
    const toggle = node("input"); toggle.type = "checkbox"; toggle.checked = settings().selectionTools;
    toggleLabel.append(toggle, localizedNode("span", "反白文字時顯示快速提問"));
    toggle.addEventListener("change", async () => {
      const previous = settings().selectionTools;
      toggle.disabled = true;
      try { await saveSettings({ selectionTools: toggle.checked }, { selectionTools: previous }); }
      catch (error) { toggle.checked = previous; notify(t(error.message), "error"); }
      finally { toggle.disabled = false; }
    });
    const list = node("div", "", "reading-command-list");
    const nameLabel = localizedNode("label", "指令名稱", "field");
    const name = node("input"); name.maxLength = 32; nameLabel.append(name);
    const promptLabel = localizedNode("label", "指令內容", "field");
    const prompt = node("textarea"); prompt.maxLength = 2000; prompt.rows = 4; promptLabel.append(prompt);
    function render() {
      list.replaceChildren();
      pruneTranslations();
      items.forEach((item, index) => {
        const row = node("div", "", "reading-command");
        const apply = () => { close(); usePrompt(item.prompt); };
        const source = defaults.get(item.id);
        const use = source ? localizedButton(source.title, apply) : button(item.title, apply);
        use.classList.add("command-use");
        const controls = node("div", "", "reading-command-actions");
        controls.append(localizedButton("編輯", () => { editing = item.id; name.value = item.title; prompt.value = item.prompt; name.focus(); }),
          button("↑", () => { if (index > 0) { [items[index - 1], items[index]] = [items[index], items[index - 1]]; render(); } }, { source: "上移 {0}", values: () => [item.title] }),
          button("↓", () => { if (index < items.length - 1) { [items[index + 1], items[index]] = [items[index], items[index + 1]]; render(); } }, { source: "下移 {0}", values: () => [item.title] }),
          localizedButton("移除", () => { items = items.filter(other => other.id !== item.id); if (editing === item.id) editing = null; render(); }, { source: "移除指令 {0}", values: () => [item.title] }));
        row.append(use, controls); list.append(row);
      });
    }
    const update = localizedButton("加入／更新指令", () => {
      try {
        const item = { id: editing ?? document.defaultView.crypto.randomUUID(), title: name.value.trim(), prompt: prompt.value.trim() };
        const next = editing ? items.map(old => old.id === editing ? item : old) : [...items, item];
        items = parseQuickPrompts(serializeQuickPrompts(next));
        if (editing) defaults.delete(editing);
        editing = null; name.value = ""; prompt.value = ""; render();
      } catch (error) { notify(t(error.message), "error"); }
    });
    const save = localizedButton("儲存指令", async () => {
      if (name.value.trim() || prompt.value.trim()) { notify(t("請先按「加入／更新指令」保存編輯欄內容"), "error"); return; }
      save.disabled = true;
      try {
        await saveSettings({ quickPrompts: serializeQuickPrompts(items) }, { quickPrompts: initial });
        close(); notify(t("常用指令已儲存"));
      } catch (error) { notify(t(error.message), "error"); }
      finally { save.disabled = false; }
    });
    save.classList.add("primary-button");
    content.append(toggleLabel, list, nameLabel, promptLabel, update, save);
    render();
  }
  return { openTabs, openCommands, openSelectionSettings, close, refreshLanguage, get isOpen() { return !sheet.hidden; } };
}
