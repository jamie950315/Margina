import { extensionOrigin } from "../core/bridge.js";
import { sanitizePageUrl } from "../content/page-reader.js";

const types = new Set(["LIST_READING_TABS", "READ_READING_TABS", "LOCATE_TAB_SOURCE", "GET_READING_PREFERENCES", "PREPARE_LONG_TABS", "READ_LONG_TAB_BATCH", "VALIDATE_LONG_TAB", "RELEASE_LONG_TAB"]);

class ReadingError extends Error {}

function isWebUrl(value) {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

function isPanel(sender, api) {
  if (sender?.id !== api.runtime.id || sender.tab?.incognito) return false;
  try {
    const expected = new URL(api.runtime.getURL("panel.html"));
    const actual = new URL(sender.url);
    return extensionOrigin(actual.href) === extensionOrigin(expected.href) && actual.pathname === expected.pathname;
  } catch { return false; }
}

function isTopContent(sender, api) {
  return sender?.id === api.runtime.id && sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) && !sender.tab.incognito && isWebUrl(sender.url) && sender.url === sender.tab.url;
}

async function currentWindow(sender, api) {
  const tab = Number.isInteger(sender.tab?.id)
    ? await api.tabs.get(sender.tab.id)
    : (await api.tabs.query({ active: true, currentWindow: true }))[0];
  if (!Number.isInteger(tab?.windowId) || tab.incognito) throw new ReadingError("目前視窗無法讀取分頁");
  return tab.windowId;
}

function eligible(tab, windowId) {
  return Number.isInteger(tab?.id) && tab.windowId === windowId && !tab.incognito && isWebUrl(tab.url);
}

async function checkedTab(item, windowId, api) {
  if (!Number.isInteger(item?.id) || typeof item.url !== "string" || !isWebUrl(item.url) || sanitizePageUrl(item.url) !== item.url) {
    throw new ReadingError("分頁來源無效，請重新選取");
  }
  let tab;
  try { tab = await api.tabs.get(item.id); }
  catch { throw new ReadingError("無法查詢所選分頁，請重新選取"); }
  if (!eligible(tab, windowId) || sanitizePageUrl(tab.url) !== item.url || (tab.pendingUrl && tab.pendingUrl !== tab.url)) {
    throw new ReadingError("分頁已關閉、移動或換頁，請重新選取");
  }
  const parsedUrl = new URL(tab.url);
  // WebExtension match patterns address hosts, not TCP ports. Safari rejects
  // an origin containing :8767 even though navigation URLs retain their port.
  const origin = `${parsedUrl.protocol}//${parsedUrl.hostname}/*`;
  let allowed;
  try { allowed = await api.permissions.contains({ origins: [origin] }); }
  catch { throw new ReadingError("Safari 無法檢查網站權限，請重新開啟側欄"); }
  if (!allowed) throw new ReadingError("尚未取得網站存取權，請在 Safari 中允許 SafAI 存取所有網站");
  return tab;
}

async function checkUnchanged(before, item, windowId, api) {
  const after = await checkedTab(item, windowId, api);
  if (after.url !== before.url) throw new ReadingError("分頁正在換頁，請稍後重新選取");
}

async function installReader(tabId, api) {
  let results;
  try { results = await api.scripting.executeScript({ target: { tabId }, files: ["reader-script.js"] }); }
  catch { throw new ReadingError("Safari 無法載入分頁閱讀工具，請重新整理所選分頁並確認網站權限"); }
  if (!results?.some((entry) => entry.frameId === 0 && !entry.error)) throw new ReadingError("無法讀取這個分頁，請重新整理後再試");
  return results.find((entry) => entry.frameId === 0)?.documentId;
}

function mainResult(results, documentId) {
  const entry = results?.find((candidate) => candidate.frameId === 0);
  if (!entry || entry.error || (documentId && entry.documentId && documentId !== entry.documentId)) {
    throw new ReadingError("分頁讀取失敗或正在換頁，請重新選取");
  }
  return entry.result;
}

async function readPages(items, windowId, api) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 3 || new Set(items.map((item) => item?.id)).size !== items.length) {
    throw new ReadingError("請選取一至三個不同分頁");
  }
  // Validate the entire selection before reading any document.
  const selected = await Promise.all(items.map((item) => checkedTab(item, windowId, api)));
  const pages = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    await checkUnchanged(selected[index], item, windowId, api);
    const documentId = await installReader(item.id, api);
    let results;
    try { results = await api.scripting.executeScript({ target: { tabId: item.id }, func: () => globalThis.__safaiReadPage() }); }
    catch { throw new ReadingError("Safari 無法執行分頁閱讀工具，請重新整理所選分頁"); }
    const page = mainResult(results, documentId);
    await checkUnchanged(selected[index], item, windowId, api);
    if (typeof page?.text !== "string" || !page.text.trim() || page.url !== item.url) throw new ReadingError("分頁沒有可讀取的文字，或內容已變更");
    const text = page.text.slice(0, 16_000);
    const originalChars = Number.isSafeInteger(page.originalChars) && page.originalChars >= page.text.length
      ? page.originalChars : page.text.length;
    pages.push({
      tabId: item.id, title: String(page.title ?? "").slice(0, 512), url: item.url, text,
      truncated: page.truncated === true || originalChars > text.length,
      originalChars,
    });
  }
  // A previously read tab may navigate while a later one is being read.
  await Promise.all(items.map((item, index) => checkUnchanged(selected[index], item, windowId, api)));
  return { ok: true, pages };
}

export function handleReadingMessage(message, sender, api) {
  if (!types.has(message?.type)) return undefined;
  const preferences = message.type === "GET_READING_PREFERENCES";
  if (!(preferences ? isTopContent(sender, api) : isPanel(sender, api))) {
    return Promise.resolve({ ok: false, error: "不允許這個來源讀取分頁" });
  }
  return (async () => {
    try {
      if (preferences) {
        const result = await api.storage.local.get("settings");
        if (result.settings !== undefined && (!result.settings || typeof result.settings !== "object" ||
            (result.settings.selectionTools !== undefined && typeof result.settings.selectionTools !== "boolean"))) {
          throw new ReadingError("選取工具設定格式錯誤，請重新設定");
        }
        return { ok: true, selectionTools: result.settings?.selectionTools !== false };
      }
      const windowId = await currentWindow(sender, api);
      if (message.type === "LIST_READING_TABS") {
        const tabs = (await api.tabs.query({ windowId })).filter((tab) => eligible(tab, windowId))
          .map((tab) => ({ id: tab.id, title: String(tab.title ?? "").slice(0, 512), url: sanitizePageUrl(tab.url) }));
        return { ok: true, tabs };
      }
      if (message.type === "READ_READING_TABS") return await readPages(message.items, windowId, api);
      if (message.type === "PREPARE_LONG_TABS") {
        const items = message.items;
        if (!Array.isArray(items) || items.length < 1 || items.length > 3 || new Set(items.map(item => item?.id)).size !== items.length) {
          throw new ReadingError("請選取一至三個不同分頁");
        }
        const selected = await Promise.all(items.map(item => checkedTab(item, windowId, api)));
        const plans = [];
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          await checkUnchanged(selected[index], item, windowId, api);
          const documentId = await installReader(item.id, api);
          const plan = mainResult(await api.scripting.executeScript({
            target: { tabId: item.id },
            func: options => globalThis.__safaiPrepareLong(options),
            args: [{ query: String(message.query ?? "").slice(0, 16_000), annotations: [], budgetChars: 16_000, prefix: `T${index + 1}P` }],
          }), documentId);
          await checkUnchanged(selected[index], item, windowId, api);
          if (!plan?.snapshotId || plan.url !== item.url || !plan.context || !Number.isSafeInteger(plan.batchCount) || plan.batchCount < 1) {
            throw new ReadingError("分頁沒有可讀取的長文，或內容已變更");
          }
          plans.push({ ...plan, tabId: item.id });
        }
        await Promise.all(items.map((item, index) => checkUnchanged(selected[index], item, windowId, api)));
        for (const plan of plans) {
          const result = mainResult(await api.scripting.executeScript({ target: { tabId: plan.tabId },
            func: options => globalThis.__safaiValidateLong(options), args: [{ snapshotId: plan.snapshotId }] }));
          if (result?.ok !== true) throw new ReadingError("分頁內容已變更，請重新讀取");
        }
        await Promise.all(items.map((item, index) => checkUnchanged(selected[index], item, windowId, api)));
        return { ok: true, plans };
      }
      if (["READ_LONG_TAB_BATCH", "VALIDATE_LONG_TAB", "RELEASE_LONG_TAB"].includes(message.type)) {
        if (typeof message.snapshotId !== "string" || !/^[a-f0-9]{32}$/.test(message.snapshotId)) throw new ReadingError("長文讀取已失效，請重新選取");
        if (message.type === "READ_LONG_TAB_BATCH" && (!Number.isInteger(message.index) || message.index < 0 || message.index > 2_000)) throw new ReadingError("長文段落編號無效");
        const item = { id: message.tabId, url: message.url };
        const before = await checkedTab(item, windowId, api);
        const documentId = await installReader(item.id, api);
        const result = mainResult(await api.scripting.executeScript({
          target: { tabId: item.id },
          func: (type, options) => {
            if (type === "READ_LONG_TAB_BATCH") return globalThis.__safaiReadLongBatch(options);
            if (type === "VALIDATE_LONG_TAB") return globalThis.__safaiValidateLong(options);
            return globalThis.__safaiReleaseLong(options);
          },
          args: [message.type, { snapshotId: message.snapshotId, index: message.index }],
        }), documentId);
        await checkUnchanged(before, item, windowId, api);
        if (!result || (message.type !== "READ_LONG_TAB_BATCH" && result.ok !== true)) throw new ReadingError("長文內容已變更，請重新讀取");
        return message.type === "READ_LONG_TAB_BATCH" ? { ok: true, batch: result } : { ok: true };
      }
      if (typeof message.quote !== "string" || !message.quote.trim() || message.quote.length > 1_200) throw new ReadingError("原文引用無效");
      const item = { id: message.tabId, url: message.url };
      const before = await checkedTab(item, windowId, api);
      const documentId = await installReader(item.id, api);
      const result = mainResult(await api.scripting.executeScript({
        target: { tabId: item.id },
        func: (source) => globalThis.__safaiLocateQuote(source),
        args: [{ quote: message.quote, url: item.url }],
      }), documentId);
      await checkUnchanged(before, item, windowId, api);
      if (result?.ok !== true) throw new ReadingError("找不到原文，網頁內容可能已變更");
      await api.tabs.update(item.id, { active: true });
      return { ok: true };
    } catch (error) {
      // Browser errors can contain private URLs; never forward their raw messages.
      return { ok: false, error: error instanceof ReadingError ? error.message : "無法存取分頁，請確認網站權限並重新選取" };
    }
  })();
}
