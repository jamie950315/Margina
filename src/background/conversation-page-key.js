function documentUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("無法識別目前網頁");
  url.username = url.password = "";
  return url.href;
}

export function handleConversationPageKey(message, sender, api) {
  if (message?.type !== "GET_CONVERSATION_PAGE_KEY") return undefined;
  return (async () => {
    try {
      if (sender?.id !== api.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || sender.tab.incognito) {
        throw new Error("不允許這個來源識別網頁對話");
      }
      const url = documentUrl(message.url);
      const tab = await api.tabs.get(sender.tab.id);
      if (tab.incognito || url !== documentUrl(sender.url) || url !== documentUrl(tab.url)) {
        throw new Error("網頁已切換，請重新讀取目前頁面");
      }
      // Keep query/hash distinctions local without persisting the navigation URL.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
      const pageKey = `page:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
      return { ok: true, pageKey };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  })();
}
