import Foundation

enum RelayLoginError: Error {
    case missingSession, invalidSession, ambiguousSession
}

enum RelayLoginPolicy {
    static let navigationHosts: Set<String> = [
        "chatgpt.com", "auth.openai.com", "auth0.openai.com",
        "accounts.google.com", "login.microsoftonline.com", "login.live.com",
        "appleid.apple.com", "account.apple.com",
    ]
    static let sessionFamilies = ["__Secure-next-auth.session-token", "__Secure-authjs.session-token"]
    static let sessionResponseLimit = 512 * 1024

    static func allowsNavigation(_ url: URL?) -> Bool {
        guard let url, url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443 else { return false }
        return navigationHosts.contains(url.host?.lowercased() ?? "")
    }

    static func isChatGPTOrigin(_ url: URL?) -> Bool {
        allowsNavigation(url) && url?.host?.lowercased() == "chatgpt.com"
    }

    // Only this app's newly authenticated, isolated WK store may call this selector.
    // It deliberately excludes device IDs, anti-bot cookies, third-party SSO cookies,
    // callback URLs and unknown credential formats. Nothing here is exported to JS.
    static func sessionCookies(from cookies: [HTTPCookie], now: Date = Date()) throws -> [HTTPCookie] {
        var selected: [(family: String, index: Int?, cookie: HTTPCookie)] = []
        var totalBytes = 0
        for cookie in cookies {
            let domain = cookie.domain.lowercased()
            guard domain == "chatgpt.com" || domain == ".chatgpt.com" else { continue }
            guard let family = sessionFamilies.first(where: { cookie.name == $0 || cookie.name.hasPrefix($0 + ".") }) else { continue }
            guard cookie.isSecure, cookie.isHTTPOnly, cookie.path == "/", !cookie.value.isEmpty,
                  cookie.value.utf8.count <= 16_384 else { throw RelayLoginError.invalidSession }
            if let expiry = cookie.expiresDate, expiry <= now { continue }
            var index: Int?
            if cookie.name != family {
                let suffix = String(cookie.name.dropFirst(family.count + 1))
                guard !suffix.isEmpty, suffix.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
                      let value = Int(suffix), value < 8, String(value) == suffix else { throw RelayLoginError.invalidSession }
                index = value
            }
            totalBytes += cookie.value.utf8.count
            selected.append((family, index, cookie))
        }
        guard !selected.isEmpty else { throw RelayLoginError.missingSession }
        guard selected.count <= 8, totalBytes <= 128 * 1024 else { throw RelayLoginError.invalidSession }
        guard Set(selected.map(\.family)).count == 1,
              Set(selected.map { $0.cookie.name }).count == selected.count,
              Set(selected.map { $0.cookie.domain.lowercased() }).count == 1 else { throw RelayLoginError.ambiguousSession }
        if selected.contains(where: { $0.index == nil }) {
            guard selected.count == 1 else { throw RelayLoginError.ambiguousSession }
            return [selected[0].cookie]
        }
        let ordered = selected.sorted { $0.index! < $1.index! }
        guard ordered.map({ $0.index! }) == Array(0..<ordered.count) else { throw RelayLoginError.invalidSession }
        return ordered.map(\.cookie)
    }

    static func validSessionResponse(status: Int, data: Data, now: Date = Date()) -> Bool {
        guard status == 200, data.count <= sessionResponseLimit,
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let user = payload["user"] as? [String: Any], let identifier = user["id"] as? String,
              !identifier.isEmpty, identifier.utf8.count <= 256,
              let access = payload["accessToken"] as? String, !access.isEmpty, access.utf8.count <= 128 * 1024,
              let expires = payload["expires"] as? String else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var expiry = formatter.date(from: expires)
        if expiry == nil { formatter.formatOptions = [.withInternetDateTime]; expiry = formatter.date(from: expires) }
        return expiry.map { $0 > now } ?? false
    }
}

enum RelayLoginPhase: String {
    case signedOut, restoring, opening, waitingForUser, checking, signedIn, blocked

    var message: String {
        switch self {
        case .signedOut: return MarginaLocalization.text("signedOut")
        case .restoring: return MarginaLocalization.text("restoring")
        case .opening: return MarginaLocalization.text("opening")
        case .waitingForUser: return MarginaLocalization.text("waitingForUser")
        case .checking: return MarginaLocalization.text("checking")
        case .signedIn: return MarginaLocalization.text("signedIn")
        case .blocked: return MarginaLocalization.text("blocked")
        }
    }
}

enum RelayIdlePolicy {
    static func shouldExit(phase: RelayLoginPhase, activity: [Date], hasActiveRequests: Bool, now: Date = Date()) -> Bool {
        // Inactivity is not user consent to discard an in-progress or confirmed
        // login. Only an unused anonymous process is automatically reclaimed.
        guard phase == .signedOut, !hasActiveRequests, let latest = activity.max() else { return false }
        return now.timeIntervalSince(latest) > 1800
    }
}

struct RelayLoginState {
    private(set) var phase: RelayLoginPhase = .signedOut
    private(set) var attempt = 0
    private(set) var revision = 0

    mutating func restore() -> Int? {
        guard phase == .signedOut else { return nil }
        attempt += 1; revision += 1; phase = .restoring
        return attempt
    }

    mutating func reset(blocked: Bool = false) {
        attempt += 1; revision += 1; phase = blocked ? .blocked : .signedOut
    }

    mutating func begin() -> Int? {
        guard phase == .signedOut || phase == .blocked else { return nil }
        attempt += 1; revision += 1; phase = .opening
        return attempt
    }
    mutating func opened(_ ticket: Int) -> Bool {
        guard ticket == attempt, phase == .opening else { return false }
        phase = .waitingForUser; revision += 1; return true
    }
    mutating func checking(_ ticket: Int) -> Bool {
        guard ticket == attempt, phase == .waitingForUser else { return false }
        phase = .checking; revision += 1; return true
    }
    mutating func complete(_ ticket: Int, success: Bool) -> Bool {
        guard ticket == attempt, phase == .checking || phase == .restoring else { return false }
        phase = success ? .signedIn : .blocked; revision += 1; return true
    }
    mutating func cancel(_ ticket: Int) -> Bool {
        guard ticket == attempt, phase != .signedOut else { return false }
        attempt += 1; revision += 1; phase = .signedOut; return true
    }
}


// Native windows and relay messages follow the system language. The extension's
// explicit language preference applies to extension UI, not the official webpage.
enum MarginaLocalization {
    static func resolveLanguage(_ preferred: [String]) -> String {
        for value in preferred {
            let parts = value.replacingOccurrences(of: "_", with: "-").lowercased().split(separator: "-").map(String.init)
            guard let base = parts.first else { continue }
            if base == "en" || base == "ja" { return base }
            guard base == "zh" else { continue }
            if let script = parts.dropFirst().first(where: { $0.count == 4 && $0.allSatisfy({ $0.isASCII && $0.isLetter }) }) {
                if script == "hant" { return "zh-Hant" }
                if script == "hans" { return "zh-Hans" }
                continue
            }
            return parts.dropFirst().contains(where: { ["tw", "hk", "mo"].contains($0) }) ? "zh-Hant" : "zh-Hans"
        }
        return "en"
    }

    static var language: String { resolveLanguage(Locale.preferredLanguages) }

    static func text(_ key: String, values: [String: String] = [:], language: String = MarginaLocalization.language) -> String {
        guard var message = catalogs[language]?[key] else {
            preconditionFailure("Missing native localization: \(language).\(key)")
        }
        for (name, value) in values { message = message.replacingOccurrences(of: "{\(name)}", with: value) }
        return message
    }

    static let catalogs: [String: [String: String]] = [
        "en": [
            "aboutApp": "About Margina",
            "hideApp": "Hide Margina",
            "hideOthers": "Hide Others",
            "showAll": "Show All",
            "quitApp": "Quit Margina",
            "help": "Help",
            "appHelp": "Margina Help",
            "invalidRecord": "The saved login is invalid or unreadable. Sign in again.",
            "keychainUnavailable": "Unable to access the macOS Keychain. Unlock it and check Margina’s access permissions.",
            "signedOut": "Signed out. Enter account details only in the official login window.",
            "restoring": "Checking the saved login. Conversations have not been loaded.",
            "opening": "Opening the official login window.",
            "waitingForUser": "Sign in on the official page, then choose “Finish login and return”.",
            "checking": "Checking this login for the local relay. No conversation has been sent.",
            "signedIn": "Login confirmed. Conversation and attachment features still need separate verification.",
            "blocked": "Relay login is unconfirmed. No automatic retry or new login session was started.",
            "loginWindowTitle": "Margina — Official login (isolated session)",
            "connecting": "Connecting to https://chatgpt.com",
            "retentionPersistent": "Your login is stored securely in this Mac’s Keychain. Sign out or switch accounts in the Margina extension.",
            "retentionTemporary": "This test login lasts only until the relay closes.",
            "passwordNotice": "Enter passwords only on the official HTTPS page below. They are not sent to a local address.",
            "finishNotice": "Sign in on the official page, then use the button at the bottom right. This sends no conversation.",
            "cancel": "Cancel",
            "finishLogin": "Finish login and return",
            "returnToChatGPT": "Sign in on the official page and return to chatgpt.com first.",
            "loginChecking": "Checking login. Page interaction is paused; no conversation is being sent.",
            "loginUnconfirmed": "Official login is unconfirmed. Finish signing in and try the button again. Complete any requested verification yourself.",
            "relayChecking": "The official page confirmed login. Independently checking the relay connection.",
            "relayUnconfirmed": "Official login finished, but the relay could not confirm it. No automatic retry was made. Cancel and report this status.",
            "unsupportedLogin": "This login format is not supported. No other cookies or verification data were copied. Cancel and report this status.",
            "navigationBlocked": "Blocked an unapproved login origin, download or external app. No security prompts were bypassed.",
            "httpsChecking": "Checking the official HTTPS connection…",
            "officialOrigin": "Official address · https://{host}",
            "connectionIncomplete": "The official page connection did not complete. Certificate and other security checks were preserved.",
            "popupTitle": "Margina — Official login service: {host}",
            "uploadsUnavailable": "This window is only for login and does not accept file uploads.",
            "relayTest": "Margina relay test",
            "openControl": "Open relay controls",
            "openLogin": "Open official login",
            "quitRelay": "Quit relay test",
            "edit": "Edit",
            "cut": "Cut",
            "copy": "Copy",
            "paste": "Paste",
            "selectAll": "Select All",
            "signedInPersistent": "Signed in. This account remains available after closing Safari.",
            "relayStoppedSaved": "The Margina relay stopped. The saved login is retained.",
            "logoutFailed": "This account is no longer in use, but its saved login could not be removed. Unlock the macOS Keychain and sign out again.",
            "restoreFailed": "Unable to read the saved login. Check that the macOS Keychain is unlocked. If the login is invalid, sign in again or sign out.",
            "refreshFailed": "The updated login could not be stored securely. Conversations are paused. Check the macOS Keychain and sign in again.",
            "saveFailed": "Login was confirmed but could not be stored securely in the macOS Keychain. Conversations remain disabled. Check the Keychain and sign in again.",
            "savedLoginUnconfirmed": "The saved login could not be confirmed. This may be a connection, official verification or expiry issue. Conversations have not loaded. Sign in again or sign out.",
            "controlReadFailed": "Unable to read control status",
            "relayStopped": "The Margina relay stopped",
            "invalidURL": "Invalid URL",
            "previewMissing": "Relay test page not found",
            "reopenControl": "Reopen relay controls from the Margina app",
            "controlMissing": "Control action not found",
            "requestTimeout": "Request read timed out",
            "requestTooLarge": "Request too large",
            "invalidRequest": "Invalid request format",
            "invalidHeader": "Invalid header format",
            "duplicateHeader": "Duplicate or invalid header",
            "unsupportedUpload": "Unsupported upload encoding",
            "invalidLength": "Request too large or invalid length",
            "uploadBusy": "Relay uploads are busy. Try again later.",
            "headersTooLarge": "Headers too large",
            "relayStatusTitle": "Margina relay status",
            "chatUnavailable": "ChatGPT cannot be displayed yet",
            "noAutomaticAction": "No automatic retry, login or conversation send was performed.",
            "localOnly": "Only local connections are accepted",
            "foreignOrigin": "Requests from other websites are rejected",
            "unsupportedAction": "Unsupported operation",
            "controlNotReady": "Control interface is not ready",
            "sessionInvalidReopen": "The local relay session is invalid. Reopen it from the test entry point.",
            "relayReadFailed": "Unable to read relay status",
            "upstreamNotAllowed": "Relay access to this website is not allowed",
            "loginIsolationIncompletePreview": "Login-page origin isolation is incomplete, so loading stopped. Do not enter credentials in this prototype.",
            "websocketUnavailable": "This prototype does not support WebSocket yet",
            "controlDirectOnly": "Open the control interface directly",
            "controlOriginInvalid": "Invalid control authorization origin",
            "controlAuthorizationInvalid": "Invalid control authorization",
            "controlSessionInvalid": "Invalid control session",
            "loginPostOnly": "Login controls accept only POST",
            "loginOriginInvalid": "Invalid login control origin",
            "loginBodyRejected": "Login controls do not accept account details or other content",
            "providerControlRejected": "ChatGPT pages cannot access login controls",
            "sessionInvalid": "Invalid local relay session",
            "sessionChecking": "Checking the login session. Please wait.",
            "loginIsolationIncomplete": "Login-page origin isolation is incomplete. Do not enter credentials.",
            "relayComponentMissing": "Relay component not found",
            "browserVerification": "ChatGPT requires browser verification. The relay did not bypass it or use Safari’s login data.",
            "staticResponseRejected": "A static resource returned disallowed content or a redirect. Loading stopped.",
            "redirectRejected": "Login or navigation would reach an unapproved website. Relay access stopped.",
            "responseTooLarge": "The upstream response exceeds the relay size limit",
            "upstreamFailed": "The upstream connection failed or was interrupted. No automatic retry was made.",
            "invalidUTF8": "The upstream page is not valid UTF-8",
            "appStartFailed": "Unable to start the Margina relay",
            "appStartHelp": "Check that the app is fully installed and its signature is valid, then reopen Margina. Your login will not be deleted.",
        ],
        "zh-Hant": [
            "aboutApp": "關於 Margina",
            "hideApp": "隱藏 Margina",
            "hideOthers": "隱藏其他 App",
            "showAll": "顯示全部",
            "quitApp": "結束 Margina",
            "help": "輔助說明",
            "appHelp": "Margina 輔助說明",
            "invalidRecord": "儲存的登入資料已失效或無法讀取，請重新登入。",
            "keychainUnavailable": "無法存取 macOS 鑰匙圈；請解鎖鑰匙圈並確認 Margina 的存取權限。",
            "signedOut": "尚未登入。請只在官方登入視窗輸入帳號資料。",
            "restoring": "正在確認已儲存的登入資料，尚未載入對話。",
            "opening": "正在開啟官方登入視窗。",
            "waitingForUser": "請在官方網頁完成登入，再按「完成登入並返回」。",
            "checking": "正在確認這次登入能否供本機中轉使用；尚未傳送對話。",
            "signedIn": "已確認本次登入。對話與附件功能仍需另外驗證。",
            "blocked": "尚未確認中轉登入；沒有自動重試，也未發布新的登入工作階段。",
            "loginWindowTitle": "Margina — 官方登入（隔離工作階段）",
            "connecting": "正在連線至 https://chatgpt.com",
            "retentionPersistent": "登入資訊會安全保存在這台 Mac 的鑰匙圈；可從 Margina 擴充功能登出或切換帳號。",
            "retentionTemporary": "此測試登入只保留到中轉程式關閉。",
            "passwordNotice": "密碼只在下方官方 HTTPS 網頁輸入，不會送到本機網址。",
            "finishNotice": "請在官方網頁完成登入，再按右下方按鈕。這不會傳送任何對話。",
            "cancel": "取消",
            "finishLogin": "完成登入並返回",
            "returnToChatGPT": "請先在官方網頁完成登入，並回到 chatgpt.com。",
            "loginChecking": "正在確認登入；網頁操作暫停，沒有傳送對話。",
            "loginUnconfirmed": "尚未確認官方登入。請完成登入後再按一次；若官方要求驗證，請由你親自操作。",
            "relayChecking": "官方頁面已確認登入，正在獨立確認中轉連線。",
            "relayUnconfirmed": "官方登入已完成，但中轉未能確認這次登入。未自動重試；請按取消後回報此狀態。",
            "unsupportedLogin": "這次登入資料的格式尚未支援；未複製其他 Cookie 或驗證資料。請取消並回報此狀態。",
            "navigationBlocked": "已停止前往未核准的登入來源、下載或外部 App；沒有略過任何安全提示。",
            "httpsChecking": "正在確認官方 HTTPS 連線…",
            "officialOrigin": "官方網址  ·  https://{host}",
            "connectionIncomplete": "官方網頁連線未完成；沒有略過憑證或其他安全檢查。",
            "popupTitle": "Margina — 官方登入服務：{host}",
            "uploadsUnavailable": "此視窗只用於登入，不接受檔案上傳。",
            "relayTest": "Margina 中轉測試",
            "openControl": "開啟中轉控制頁",
            "openLogin": "開啟官方登入",
            "quitRelay": "結束中轉測試",
            "edit": "編輯",
            "cut": "剪下",
            "copy": "複製",
            "paste": "貼上",
            "selectAll": "全選",
            "signedInPersistent": "已登入；關閉 Safari 後仍會保留這個帳號。",
            "relayStoppedSaved": "Margina 中轉已停止；已儲存的登入資料仍保留。",
            "logoutFailed": "已停止使用這個帳號，但無法完成移除儲存的登入資料。請解鎖 macOS 鑰匙圈後再次登出。",
            "restoreFailed": "無法讀取已儲存的登入資料。請確認 macOS 鑰匙圈已解鎖；若資料已失效，可重新登入或登出。",
            "refreshFailed": "更新登入資料時無法安全保存，已暫停對話。請確認 macOS 鑰匙圈後重新登入。",
            "saveFailed": "登入已確認，但無法安全保存到 macOS 鑰匙圈，尚未啟用對話。請確認鑰匙圈後重新登入。",
            "savedLoginUnconfirmed": "暫時無法確認已儲存的登入。可能是連線、官方驗證或登入到期；尚未載入對話。可重新登入或登出。",
            "controlReadFailed": "無法讀取控制狀態",
            "relayStopped": "Margina 中轉已停止",
            "invalidURL": "網址格式無效",
            "previewMissing": "找不到中轉測試頁",
            "reopenControl": "請從 Margina 原生程式重新開啟控制頁",
            "controlMissing": "找不到控制操作",
            "requestTimeout": "讀取請求逾時",
            "requestTooLarge": "請求過大",
            "invalidRequest": "請求格式無效",
            "invalidHeader": "標頭格式無效",
            "duplicateHeader": "重複或無效的標頭",
            "unsupportedUpload": "不支援此上傳編碼",
            "invalidLength": "請求過大或長度無效",
            "uploadBusy": "中轉上傳忙碌中，請稍後再試",
            "headersTooLarge": "標頭過大",
            "relayStatusTitle": "Margina 中轉狀態",
            "chatUnavailable": "尚無法顯示 ChatGPT",
            "noAutomaticAction": "沒有自動重試、登入或傳送對話。",
            "localOnly": "只接受本機連線",
            "foreignOrigin": "拒絕其他網站的請求",
            "unsupportedAction": "不支援此操作",
            "controlNotReady": "控制介面尚未就緒",
            "sessionInvalidReopen": "本機中轉工作階段無效，請從測試入口重新開啟",
            "relayReadFailed": "無法讀取中轉狀態",
            "upstreamNotAllowed": "未允許此網站的中轉",
            "loginIsolationIncompletePreview": "登入頁的獨立來源隔離尚未完成，已停止載入；請勿在此原型輸入帳號密碼",
            "websocketUnavailable": "此原型尚未支援 WebSocket",
            "controlDirectOnly": "控制介面必須直接開啟",
            "controlOriginInvalid": "控制頁授權來源無效",
            "controlAuthorizationInvalid": "控制頁授權無效",
            "controlSessionInvalid": "控制工作階段無效",
            "loginPostOnly": "登入控制只接受 POST",
            "loginOriginInvalid": "登入控制來源無效",
            "loginBodyRejected": "登入控制不接受帳號資料或其他內容",
            "providerControlRejected": "ChatGPT 網頁不能使用登入控制介面",
            "sessionInvalid": "本機中轉工作階段無效",
            "sessionChecking": "登入工作階段正在確認，請稍候",
            "loginIsolationIncomplete": "登入頁的獨立來源隔離尚未完成；請勿輸入帳號密碼",
            "relayComponentMissing": "找不到中轉元件",
            "browserVerification": "ChatGPT 需要瀏覽器驗證；中轉未自動通過驗證，也未借用 Safari 的登入資料",
            "staticResponseRejected": "靜態資源回傳了不允許的內容或跳轉，已停止載入",
            "redirectRejected": "登入或導覽將前往尚未允許的網站；已停止中轉",
            "responseTooLarge": "上游回應超過中轉大小限制",
            "upstreamFailed": "上游連線失敗或中斷，沒有自動重試",
            "invalidUTF8": "上游網頁不是有效 UTF-8",
            "appStartFailed": "無法啟動 Margina 中轉服務",
            "appStartHelp": "請確認 App 完整安裝且簽章有效，再重新開啟 Margina。登入資料不會因此刪除。",
        ],
        "zh-Hans": [
            "aboutApp": "关于 Margina",
            "hideApp": "隐藏 Margina",
            "hideOthers": "隐藏其他 App",
            "showAll": "显示全部",
            "quitApp": "退出 Margina",
            "help": "帮助",
            "appHelp": "Margina 帮助",
            "invalidRecord": "保存的登录信息已失效或无法读取，请重新登录。",
            "keychainUnavailable": "无法访问 macOS 钥匙串；请解锁钥匙串并确认 Margina 的访问权限。",
            "signedOut": "尚未登录。请仅在官方登录窗口输入账号信息。",
            "restoring": "正在确认保存的登录信息，尚未加载对话。",
            "opening": "正在打开官方登录窗口。",
            "waitingForUser": "请在官方网页完成登录，再点击“完成登录并返回”。",
            "checking": "正在确认本次登录能否用于本机中转；尚未发送对话。",
            "signedIn": "已确认本次登录。对话和附件功能仍需另行验证。",
            "blocked": "尚未确认中转登录；未自动重试，也未启用新的登录会话。",
            "loginWindowTitle": "Margina — 官方登录（隔离会话）",
            "connecting": "正在连接 https://chatgpt.com",
            "retentionPersistent": "登录信息将安全保存在这台 Mac 的钥匙串中；可在 Margina 扩展中退出登录或切换账号。",
            "retentionTemporary": "本次测试登录仅保留到中转程序关闭。",
            "passwordNotice": "密码仅在下方的官方 HTTPS 网页输入，不会发送到本机地址。",
            "finishNotice": "请在官方网页完成登录，再点击右下方按钮。这不会发送任何对话。",
            "cancel": "取消",
            "finishLogin": "完成登录并返回",
            "returnToChatGPT": "请先在官方网页完成登录，并返回 chatgpt.com。",
            "loginChecking": "正在确认登录；网页操作已暂停，没有发送对话。",
            "loginUnconfirmed": "尚未确认官方登录。请完成登录后再次点击；如官方要求验证，请亲自完成。",
            "relayChecking": "官方网页已确认登录，正在独立确认中转连接。",
            "relayUnconfirmed": "官方登录已完成，但中转未能确认本次登录。未自动重试；请取消并反馈此状态。",
            "unsupportedLogin": "本次登录信息的格式尚不支持；未复制其他 Cookie 或验证信息。请取消并反馈此状态。",
            "navigationBlocked": "已阻止未批准的登录来源、下载或外部 App；未跳过任何安全提示。",
            "httpsChecking": "正在确认官方 HTTPS 连接…",
            "officialOrigin": "官方地址 · https://{host}",
            "connectionIncomplete": "官方网页连接未完成；未跳过证书或其他安全检查。",
            "popupTitle": "Margina — 官方登录服务：{host}",
            "uploadsUnavailable": "此窗口仅用于登录，不接受文件上传。",
            "relayTest": "Margina 中转测试",
            "openControl": "打开中转控制页",
            "openLogin": "打开官方登录",
            "quitRelay": "退出中转测试",
            "edit": "编辑",
            "cut": "剪切",
            "copy": "复制",
            "paste": "粘贴",
            "selectAll": "全选",
            "signedInPersistent": "已登录；关闭 Safari 后仍会保留此账号。",
            "relayStoppedSaved": "Margina 中转已停止；保存的登录信息仍保留。",
            "logoutFailed": "已停止使用此账号，但未能移除保存的登录信息。请解锁 macOS 钥匙串后再次退出登录。",
            "restoreFailed": "无法读取保存的登录信息。请确认 macOS 钥匙串已解锁；如信息已失效，可重新登录或退出登录。",
            "refreshFailed": "更新的登录信息无法安全保存，已暂停对话。请确认 macOS 钥匙串后重新登录。",
            "saveFailed": "登录已确认，但无法安全保存到 macOS 钥匙串，尚未启用对话。请确认钥匙串后重新登录。",
            "savedLoginUnconfirmed": "暂时无法确认保存的登录信息。可能是连接、官方验证或登录过期；尚未加载对话。可重新登录或退出登录。",
            "controlReadFailed": "无法读取控制状态",
            "relayStopped": "Margina 中转已停止",
            "invalidURL": "地址格式无效",
            "previewMissing": "找不到中转测试页",
            "reopenControl": "请从 Margina 原生 App 重新打开控制页",
            "controlMissing": "找不到控制操作",
            "requestTimeout": "读取请求超时",
            "requestTooLarge": "请求过大",
            "invalidRequest": "请求格式无效",
            "invalidHeader": "标头格式无效",
            "duplicateHeader": "重复或无效的标头",
            "unsupportedUpload": "不支持此上传编码",
            "invalidLength": "请求过大或长度无效",
            "uploadBusy": "中转上传繁忙，请稍后再试",
            "headersTooLarge": "标头过大",
            "relayStatusTitle": "Margina 中转状态",
            "chatUnavailable": "暂时无法显示 ChatGPT",
            "noAutomaticAction": "未自动重试、登录或发送对话。",
            "localOnly": "仅接受本机连接",
            "foreignOrigin": "拒绝其他网站的请求",
            "unsupportedAction": "不支持此操作",
            "controlNotReady": "控制界面尚未就绪",
            "sessionInvalidReopen": "本机中转会话无效，请从测试入口重新打开",
            "relayReadFailed": "无法读取中转状态",
            "upstreamNotAllowed": "未允许此网站的中转",
            "loginIsolationIncompletePreview": "登录页的独立来源隔离尚未完成，已停止加载；请勿在此原型输入账号密码",
            "websocketUnavailable": "此原型尚不支持 WebSocket",
            "controlDirectOnly": "控制界面必须直接打开",
            "controlOriginInvalid": "控制页授权来源无效",
            "controlAuthorizationInvalid": "控制页授权无效",
            "controlSessionInvalid": "控制会话无效",
            "loginPostOnly": "登录控制仅接受 POST",
            "loginOriginInvalid": "登录控制来源无效",
            "loginBodyRejected": "登录控制不接受账号信息或其他内容",
            "providerControlRejected": "ChatGPT 网页不能使用登录控制界面",
            "sessionInvalid": "本机中转会话无效",
            "sessionChecking": "正在确认登录会话，请稍候",
            "loginIsolationIncomplete": "登录页的独立来源隔离尚未完成；请勿输入账号密码",
            "relayComponentMissing": "找不到中转组件",
            "browserVerification": "ChatGPT 需要浏览器验证；中转未自动通过验证，也未使用 Safari 的登录信息",
            "staticResponseRejected": "静态资源返回了不允许的内容或重定向，已停止加载",
            "redirectRejected": "登录或导航将前往尚未允许的网站；已停止中转",
            "responseTooLarge": "上游响应超过中转大小限制",
            "upstreamFailed": "上游连接失败或中断，未自动重试",
            "invalidUTF8": "上游网页不是有效 UTF-8",
            "appStartFailed": "无法启动 Margina 中转服务",
            "appStartHelp": "请确认 App 已完整安装且签名有效，再重新打开 Margina。登录信息不会因此删除。",
        ],
        "ja": [
            "aboutApp": "Margina について",
            "hideApp": "Margina を隠す",
            "hideOthers": "ほかを隠す",
            "showAll": "すべてを表示",
            "quitApp": "Margina を終了",
            "help": "ヘルプ",
            "appHelp": "Margina ヘルプ",
            "invalidRecord": "保存したログイン情報が無効か読み取れません。再ログインしてください。",
            "keychainUnavailable": "macOS キーチェーンにアクセスできません。ロックを解除し、Margina のアクセス権を確認してください。",
            "signedOut": "ログアウトしています。アカウント情報は公式ログインウインドウだけに入力してください。",
            "restoring": "保存したログイン情報を確認しています。会話はまだ読み込んでいません。",
            "opening": "公式ログインウインドウを開いています。",
            "waitingForUser": "公式ページでログインし、「ログインを完了して戻る」を押してください。",
            "checking": "ローカルリレーで使えるログインか確認しています。会話は送信していません。",
            "signedIn": "ログインを確認しました。会話と添付機能は別途検証が必要です。",
            "blocked": "リレーのログインを確認できません。自動再試行や新しいログインセッションの公開は行っていません。",
            "loginWindowTitle": "Margina — 公式ログイン（独立したセッション）",
            "connecting": "https://chatgpt.com に接続しています",
            "retentionPersistent": "ログイン情報はこの Mac のキーチェーンに安全に保存されます。Margina 拡張機能でログアウトやアカウントの切り替えができます。",
            "retentionTemporary": "このテストのログインはリレーを閉じるまで保持されます。",
            "passwordNotice": "パスワードは下の公式 HTTPS ページだけに入力してください。ローカルのアドレスには送信されません。",
            "finishNotice": "公式ページでログインし、右下のボタンを押してください。会話は送信されません。",
            "cancel": "キャンセル",
            "finishLogin": "ログインを完了して戻る",
            "returnToChatGPT": "公式ページでログインしてから chatgpt.com に戻ってください。",
            "loginChecking": "ログインを確認しています。ページ操作を一時停止しています。会話は送信していません。",
            "loginUnconfirmed": "公式ログインを確認できません。ログインを完了してからもう一度押してください。公式の確認操作が求められた場合は、ご自身で行ってください。",
            "relayChecking": "公式ページでログインを確認しました。リレー接続を別途確認しています。",
            "relayUnconfirmed": "公式ログインは完了しましたが、リレーで確認できませんでした。自動再試行は行っていません。キャンセルして、この状態を報告してください。",
            "unsupportedLogin": "このログイン形式には対応していません。他の Cookie や認証データはコピーしていません。キャンセルして、この状態を報告してください。",
            "navigationBlocked": "許可されていないログイン先、ダウンロード、外部 App への移動を停止しました。セキュリティ確認は回避していません。",
            "httpsChecking": "公式 HTTPS 接続を確認しています…",
            "officialOrigin": "公式アドレス · https://{host}",
            "connectionIncomplete": "公式ページへの接続を完了できませんでした。証明書やその他のセキュリティ確認は保持しています。",
            "popupTitle": "Margina — 公式ログインサービス：{host}",
            "uploadsUnavailable": "このウインドウはログイン専用です。ファイルのアップロードはできません。",
            "relayTest": "Margina リレーテスト",
            "openControl": "リレー操作ページを開く",
            "openLogin": "公式ログインを開く",
            "quitRelay": "リレーテストを終了",
            "edit": "編集",
            "cut": "カット",
            "copy": "コピー",
            "paste": "ペースト",
            "selectAll": "すべてを選択",
            "signedInPersistent": "ログインしました。Safari を閉じてもこのアカウントは保持されます。",
            "relayStoppedSaved": "Margina リレーを停止しました。保存したログイン情報は保持しています。",
            "logoutFailed": "このアカウントの使用は停止しましたが、保存したログイン情報を削除できませんでした。macOS キーチェーンのロックを解除し、再度ログアウトしてください。",
            "restoreFailed": "保存したログイン情報を読み取れません。macOS キーチェーンのロックを確認してください。情報が無効なら再ログインまたはログアウトできます。",
            "refreshFailed": "更新したログイン情報を安全に保存できないため、会話を一時停止しました。macOS キーチェーンを確認して再ログインしてください。",
            "saveFailed": "ログインは確認しましたが、macOS キーチェーンに安全に保存できません。会話はまだ有効にしていません。キーチェーンを確認して再ログインしてください。",
            "savedLoginUnconfirmed": "保存したログイン情報を確認できません。接続、公式の確認、有効期限が原因の可能性があります。会話は読み込んでいません。再ログインまたはログアウトできます。",
            "controlReadFailed": "操作状態を読み取れません",
            "relayStopped": "Margina リレーを停止しました",
            "invalidURL": "URL の形式が無効です",
            "previewMissing": "リレーテストページが見つかりません",
            "reopenControl": "Margina App から操作ページを開き直してください",
            "controlMissing": "操作が見つかりません",
            "requestTimeout": "リクエストの読み取りがタイムアウトしました",
            "requestTooLarge": "リクエストが大きすぎます",
            "invalidRequest": "リクエストの形式が無効です",
            "invalidHeader": "ヘッダーの形式が無効です",
            "duplicateHeader": "ヘッダーが重複しているか無効です",
            "unsupportedUpload": "このアップロード形式には対応していません",
            "invalidLength": "リクエストが大きすぎるか長さが無効です",
            "uploadBusy": "リレーのアップロードが混み合っています。後でお試しください。",
            "headersTooLarge": "ヘッダーが大きすぎます",
            "relayStatusTitle": "Margina リレーの状態",
            "chatUnavailable": "ChatGPT をまだ表示できません",
            "noAutomaticAction": "自動再試行、ログイン、会話の送信は行っていません。",
            "localOnly": "ローカル接続だけを受け付けます",
            "foreignOrigin": "他のウェブサイトからのリクエストは拒否します",
            "unsupportedAction": "この操作には対応していません",
            "controlNotReady": "操作インターフェースの準備ができていません",
            "sessionInvalidReopen": "ローカルリレーのセッションが無効です。テストの入口から開き直してください。",
            "relayReadFailed": "リレーの状態を読み取れません",
            "upstreamNotAllowed": "このウェブサイトへのリレーアクセスは許可されていません",
            "loginIsolationIncompletePreview": "ログインページのオリジン分離が未完成のため、読み込みを停止しました。この試作版に認証情報を入力しないでください。",
            "websocketUnavailable": "この試作版はまだ WebSocket に対応していません",
            "controlDirectOnly": "操作インターフェースを直接開いてください",
            "controlOriginInvalid": "操作ページの認証元が無効です",
            "controlAuthorizationInvalid": "操作ページの認証が無効です",
            "controlSessionInvalid": "操作セッションが無効です",
            "loginPostOnly": "ログイン操作は POST だけを受け付けます",
            "loginOriginInvalid": "ログイン操作の送信元が無効です",
            "loginBodyRejected": "ログイン操作はアカウント情報やその他の内容を受け付けません",
            "providerControlRejected": "ChatGPT のページからログイン操作にアクセスすることはできません",
            "sessionInvalid": "ローカルリレーのセッションが無効です",
            "sessionChecking": "ログインセッションを確認しています。お待ちください。",
            "loginIsolationIncomplete": "ログインページのオリジン分離が未完成です。認証情報を入力しないでください。",
            "relayComponentMissing": "リレーの構成要素が見つかりません",
            "browserVerification": "ChatGPT によるブラウザの確認が必要です。リレーは確認を回避せず、Safari のログイン情報も使用していません。",
            "staticResponseRejected": "静的リソースが許可されていない内容やリダイレクトを返したため、読み込みを停止しました。",
            "redirectRejected": "ログインまたは移動先が許可されていないウェブサイトのため、リレーアクセスを停止しました。",
            "responseTooLarge": "上流の応答がリレーのサイズ制限を超えています",
            "upstreamFailed": "上流への接続が失敗したか中断されました。自動再試行は行っていません。",
            "invalidUTF8": "上流のページが有効な UTF-8 ではありません",
            "appStartFailed": "Margina リレーを起動できません",
            "appStartHelp": "App が完全にインストールされ、署名が有効なことを確認してから Margina を開き直してください。ログイン情報は削除されません。",
        ],
    ]
}
