"use strict";

// This local welcome page follows macOS/WebKit's preferred languages.
window.MarginaWelcomeLocalization = (() => {
  const catalogs = {
  "en": {
    "subtitle": "Safari extension · Built-in relay",
    "heading": "Keep ChatGPT beside your reading",
    "stepsLabel": "Get started",
    "settings": "Settings",
    "preferences": "Preferences",
    "stepEnable": "Enable the Margina extension in Safari {settings}",
    "stepSidebar": "Open the sidebar on a webpage and select ChatGPT",
    "stepLogin": "On first use, sign in through the official login window",
    "accountNote": "Your login is stored only in this Mac’s Keychain and remains available after closing Safari. Sign out or switch accounts in the extension. An expired login may need to be renewed.",
    "openPreferences": "Open Safari extension {settings}",
    "enabled": "The extension is enabled. Return to Safari to get started.",
    "disabled": "The extension is disabled. Enable it in Safari {settings}.",
    "unknown": "Extension status is unavailable. Check Safari {settings}.",
    "bridgeError": "Unable to open settings directly. Enable Margina in Safari’s extension settings."
  },
  "zh-Hant": {
    "subtitle": "Safari 擴充功能 · 內建中轉",
    "heading": "讓 ChatGPT 留在閱讀旁邊",
    "stepsLabel": "開始使用",
    "settings": "設定",
    "preferences": "偏好設定",
    "stepEnable": "在 Safari {settings}中啟用 Margina 擴充功能",
    "stepSidebar": "開啟網頁側欄，選擇 ChatGPT",
    "stepLogin": "第一次使用時，在官方視窗登入帳號",
    "accountNote": "登入資訊只保存在這台 Mac 的鑰匙圈，關閉 Safari 後仍可沿用。可在擴充功能登出或切換帳號；登入到期時可能需要重新登入。",
    "openPreferences": "開啟 Safari 擴充功能{settings}",
    "enabled": "擴充功能已啟用，回到 Safari 即可開始使用。",
    "disabled": "擴充功能尚未啟用，請在 Safari {settings}中開啟。",
    "unknown": "尚未確認擴充功能狀態，可到 Safari {settings}中查看。",
    "bridgeError": "無法直接開啟設定，請到 Safari 的擴充功能設定中啟用 Margina。"
  },
  "zh-Hans": {
    "subtitle": "Safari 扩展 · 内置中转",
    "heading": "让 ChatGPT 留在阅读旁边",
    "stepsLabel": "开始使用",
    "settings": "设置",
    "preferences": "偏好设置",
    "stepEnable": "在 Safari {settings}中启用 Margina 扩展",
    "stepSidebar": "打开网页侧栏，选择 ChatGPT",
    "stepLogin": "首次使用时，在官方窗口登录账号",
    "accountNote": "登录信息仅保存在这台 Mac 的钥匙串中，关闭 Safari 后仍可使用。可在扩展中退出登录或切换账号；登录过期时可能需要重新登录。",
    "openPreferences": "打开 Safari 扩展{settings}",
    "enabled": "扩展已启用，返回 Safari 即可开始使用。",
    "disabled": "扩展尚未启用，请在 Safari {settings}中打开。",
    "unknown": "尚未确认扩展状态，可到 Safari {settings}中查看。",
    "bridgeError": "无法直接打开设置，请到 Safari 的扩展设置中启用 Margina。"
  },
  "ja": {
    "subtitle": "Safari 拡張機能 · 内蔵リレー",
    "heading": "読むそばに ChatGPT を",
    "stepsLabel": "使い始める",
    "settings": "設定",
    "preferences": "環境設定",
    "stepEnable": "Safari の「{settings}」で Margina 拡張機能を有効にする",
    "stepSidebar": "ウェブページでサイドバーを開き、ChatGPT を選ぶ",
    "stepLogin": "初回は公式ログインウインドウでログインする",
    "accountNote": "ログイン情報はこの Mac のキーチェーンだけに保存され、Safari を閉じても利用できます。拡張機能でログアウトやアカウントの切り替えができます。有効期限が切れた場合は再ログインが必要です。",
    "openPreferences": "Safari 拡張機能の「{settings}」を開く",
    "enabled": "拡張機能は有効です。Safari に戻って使い始められます。",
    "disabled": "拡張機能は無効です。Safari の「{settings}」で有効にしてください。",
    "unknown": "拡張機能の状態を確認できません。Safari の「{settings}」で確認してください。",
    "bridgeError": "設定を直接開けません。Safari の拡張機能設定で Margina を有効にしてください。"
  }
};

  function supportedLanguage(value) {
    if (typeof value !== "string") return null;
    const parts = value.replaceAll("_", "-").toLowerCase().split("-");
    if (parts[0] === "en" || parts[0] === "ja") return parts[0];
    if (parts[0] !== "zh") return null;
    const script = parts.slice(1).find(part => /^[a-z]{4}$/.test(part));
    if (script) return script === "hant" ? "zh-Hant" : script === "hans" ? "zh-Hans" : null;
    return parts.slice(1).some(part => ["tw", "hk", "mo"].includes(part)) ? "zh-Hant" : "zh-Hans";
  }

  function resolveLanguage(preferred = window.MarginaPreferredLanguages || navigator.languages || [navigator.language]) {
    for (const language of preferred) {
      const supported = supportedLanguage(language);
      if (supported) return supported;
    }
    return "en";
  }

  const language = resolveLanguage();
  function text(key, values = {}) {
    return catalogs[language][key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  }
  return Object.freeze({ catalogs, resolveLanguage, language, text });
})();
