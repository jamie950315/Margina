import { handleBackgroundMessage } from "./handlers.js";

const browserApi = globalThis.browser ?? globalThis.chrome;

async function togglePanel(tab) {
  if (!tab?.id) return;

  await browserApi.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content-script.js"],
  });
  await browserApi.tabs.sendMessage(tab.id, { type: "TOGGLE_SAFAI_PANEL" });
}

browserApi.action.onClicked.addListener(togglePanel);
browserApi.runtime.onMessage.addListener((message, sender) =>
  handleBackgroundMessage(message, sender, browserApi),
);
