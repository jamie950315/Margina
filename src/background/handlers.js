export async function handleBackgroundMessage(message, sender, browserApi) {
  try {
    if (message?.type === "CAPTURE_VISIBLE_TAB") {
      if (
        !sender?.tab ||
        !browserApi?.tabs?.captureVisibleTab ||
        !browserApi?.tabs?.query
      ) {
        return { ok: false, error: "找不到目前分頁" };
      }
      let tabSwitched = false;
      const watchTabSwitch = (activeInfo) => {
        if (activeInfo.windowId === sender.tab.windowId) tabSwitched = true;
      };
      browserApi.tabs.onActivated?.addListener(watchTabSwitch);

      try {
        const [activeBefore] = await browserApi.tabs.query({
          active: true,
          windowId: sender.tab.windowId,
        });
        if (activeBefore?.id !== sender.tab.id) {
          return { ok: false, error: "目前分頁已切換，請重新擷取" };
        }

        const dataUrl = await browserApi.tabs.captureVisibleTab(sender.tab.windowId, {
          format: "png",
        });
        const [activeAfter] = await browserApi.tabs.query({
          active: true,
          windowId: sender.tab.windowId,
        });
        if (tabSwitched || activeAfter?.id !== sender.tab.id) {
          return { ok: false, error: "擷取期間分頁已切換，截圖已丟棄" };
        }
        return { ok: true, dataUrl };
      } finally {
        browserApi.tabs.onActivated?.removeListener(watchTabSwitch);
      }
    }

    if (message?.type === "OPEN_CHATGPT") {
      await browserApi.tabs.create({ url: "https://chatgpt.com/", active: true });
      return { ok: true };
    }
  } catch (error) {
    return { ok: false, error: error?.message || "擴充功能操作失敗" };
  }

  return undefined;
}
