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
        case .signedOut: return "尚未登入。請只在官方登入視窗輸入帳號資料。"
        case .restoring: return "正在確認已儲存的登入資料，尚未載入對話。"
        case .opening: return "正在開啟官方登入視窗。"
        case .waitingForUser: return "請在官方網頁完成登入，再按「完成登入並返回」。"
        case .checking: return "正在確認這次登入能否供本機中轉使用；尚未傳送對話。"
        case .signedIn: return "已確認本次登入。對話與附件功能仍需另外驗證。"
        case .blocked: return "尚未確認中轉登入；沒有自動重試，也未發布新的登入工作階段。"
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
