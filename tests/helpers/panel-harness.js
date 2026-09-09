import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../../src/panel/index.js", import.meta.url), "utf8");
const entry = source.slice(0, source.lastIndexOf("\ninitialize().catch("));
const { outputFiles } = await build({
  stdin: {
    contents: `${entry}\nexport { initialize, loadSettings, loadConversationStore, copyText, copyAttachmentImage, refreshContext, submitPrompt, newConversation, renderMessageText, buildCurrentPayload, promptSources, appendCitations, handleBridgeMessage, readingRequest, state, elements, showToast, saveActiveConversation, saveSettings, toggleSetting, openSettings, applyMode };`,
    resolveDir: new URL("../../src/panel/", import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "panelTest",
  platform: "browser",
});

export async function panelHarness({ demo = true, browser, url } = {}) {
  const html = await readFile(new URL("../../src/panel/panel.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, {
    url: url ?? `https://extension.test/panel.html${demo ? "?demo" : ""}#bridge=test-token`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.browser = browser;
  dom.window.eval(outputFiles[0].text);
  function connectBridge(respond) {
    const port = {
      start() {},
      close() {},
      postMessage(message) {
        queueMicrotask(() => port.onmessage({ data: {
          type: "RESPONSE", requestId: message.requestId, ...respond(message),
        } }));
      },
    };
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
      source: dom.window,
      data: { type: "SAFAI_BRIDGE_CONNECT", token: "test-token" },
      ports: [port],
    }));
  }
  return { dom, connectBridge, ...dom.window.panelTest };
}
