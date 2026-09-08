import { handleBackgroundMessage } from "./handlers.js";
import { handleStorageMessage } from "./storage.js";

const browserApi = globalThis.browser ?? globalThis.chrome;

async function togglePanel(tab) {
  if (!tab?.id) return;

  try {
    const installed = await browserApi.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-script.js"],
    });
    if (!installed.length || installed.some((entry) => entry.error)) {
      throw new Error("側欄程式無法載入");
    }
    const results = await browserApi.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.__safaiTogglePanel(),
    });
    if (results[0]?.result?.ok !== true) throw new Error("側欄沒有確認開啟或關閉");
    await browserApi.action.setBadgeText({ tabId: tab.id, text: "" });
    await browserApi.action.setTitle({ tabId: tab.id, title: "開啟 SafAI" });
  } catch (error) {
    await browserApi.action.setBadgeText({ tabId: tab.id, text: "!" });
    await browserApi.action.setTitle({ tabId: tab.id, title: "SafAI 無法開啟，請重新載入頁面後重試" });
    throw error;
  }
}

browserApi.action.onClicked.addListener(togglePanel);
browserApi.runtime.onMessage.addListener((message, sender) =>
  handleStorageMessage(message, sender, browserApi) ?? handleBackgroundMessage(message, sender, browserApi),
);
