import Foundation

@main
struct LoginPolicyChecks {
    static func require(_ condition: Bool, _ label: String) {
        if !condition { print("FAILED", label); exit(1) }
    }
    static func cookie(_ name: String = "__Secure-next-auth.session-token", domain: String = ".chatgpt.com", secure: Bool = true, httpOnly: Bool = true, path: String = "/", expiry: Date = Date(timeIntervalSinceNow: 3600), value: String = "synthetic-session-only") -> HTTPCookie {
        var properties: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .domain: domain, .path: path, .expires: expiry]
        if secure { properties[.secure] = "TRUE" }
        if httpOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        return HTTPCookie(properties: properties)!
    }
    static func rejects(_ cookies: [HTTPCookie], _ label: String) {
        do { _ = try RelayLoginPolicy.sessionCookies(from: cookies); require(false, label) }
        catch { }
    }
    static func main() throws {
        for value in ["https://chatgpt.com/", "https://auth.openai.com/log-in", "https://accounts.google.com/", "https://login.microsoftonline.com/", "https://appleid.apple.com/"] {
            require(RelayLoginPolicy.allowsNavigation(URL(string: value)), "official navigation")
        }
        for value in ["http://chatgpt.com/", "https://chatgpt.com.evil.invalid/", "https://someone@chatgpt.com/", "https://chatgpt.com:8443/", "file:///tmp/login", "javascript:alert(1)", "http://127.0.0.1/", "https://unapproved.invalid/", "about:blank"] {
            require(!RelayLoginPolicy.allowsNavigation(URL(string: value)), "navigation boundary")
        }
        require(!RelayLoginPolicy.allowsNavigation(nil), "missing navigation URL")
        require(RelayLoginPolicy.isChatGPTOrigin(URL(string: "https://chatgpt.com/")), "session probe origin")
        require(!RelayLoginPolicy.isChatGPTOrigin(URL(string: "https://auth.openai.com/")), "auth host is not session authority")
        require(cookie().isHTTPOnly, "fixture HTTP-only flag")
        let selection = try RelayLoginPolicy.sessionCookies(from: [cookie(), cookie("cf_clearance"), cookie("__cf_bm"), cookie("oai-did", httpOnly: false), cookie("third_party", domain: "accounts.google.com")])
        require(selection.count == 1 && selection[0].name == "__Secure-next-auth.session-token", "only supported session credential selected")
        let chunks = try RelayLoginPolicy.sessionCookies(from: [cookie("__Secure-next-auth.session-token.1"), cookie("__Secure-next-auth.session-token.0")])
        require(chunks.map(\.name) == ["__Secure-next-auth.session-token.0", "__Secure-next-auth.session-token.1"], "chunk ordering")
        rejects([], "missing session")
        rejects([cookie(domain: "evil.chatgpt.com")], "cookie scope")
        rejects([cookie(secure: false)], "secure required")
        rejects([cookie(httpOnly: false)], "HTTP-only required")
        rejects([cookie(path: "/auth")], "cookie path")
        rejects([cookie(expiry: Date(timeIntervalSinceNow: -60))], "expired session")
        rejects([cookie(value: "")], "empty session")
        rejects([cookie(), cookie()], "duplicate cookie")
        rejects([cookie(), cookie("__Secure-next-auth.session-token.0")], "mixed chunked and unchunked")
        rejects([cookie("__Secure-next-auth.session-token.0"), cookie("__Secure-next-auth.session-token.2")], "missing chunk")
        rejects([cookie("__Secure-next-auth.session-token.00")], "noncanonical chunk")
        rejects([cookie("__Secure-next-auth.session-token.invalid")], "invalid chunk")
        rejects([cookie("__Secure-next-auth.session-token.0"), cookie("__Secure-next-auth.session-token.1", domain: "chatgpt.com")], "ambiguous chunk scope")
        rejects([cookie(), cookie("__Secure-authjs.session-token")], "ambiguous credential families")
        // Foundation itself rejects oversized cookies on this macOS version.
        let oversized = HTTPCookie(properties: [.name: "__Secure-next-auth.session-token", .value: String(repeating: "x", count: 16_385), .domain: ".chatgpt.com", .path: "/", .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE"])
        if let oversized { rejects([oversized], "credential length limit") }

        let future = ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: 3600))
        let payload: [String: Any] = ["user": ["id": "synthetic-user"], "accessToken": "synthetic-access-not-real", "expires": future]
        let valid = try JSONSerialization.data(withJSONObject: payload)
        require(RelayLoginPolicy.validSessionResponse(status: 200, data: valid), "verified session schema")
        require(!RelayLoginPolicy.validSessionResponse(status: 403, data: valid), "HTTP rejection")
        require(!RelayLoginPolicy.validSessionResponse(status: 200, data: Data("{}".utf8)), "anonymous response")
        require(!RelayLoginPolicy.validSessionResponse(status: 200, data: Data("<html>verification</html>".utf8)), "HTML is not authentication")
        for field in ["user", "accessToken", "expires"] {
            var changed = payload; changed.removeValue(forKey: field)
            require(!RelayLoginPolicy.validSessionResponse(status: 200, data: try JSONSerialization.data(withJSONObject: changed)), "missing authenticated field")
        }
        var expired = payload; expired["expires"] = "2000-01-01T00:00:00Z"
        require(!RelayLoginPolicy.validSessionResponse(status: 200, data: try JSONSerialization.data(withJSONObject: expired)), "expired response")
        var state = RelayLoginState()
        let first = state.begin()!
        require(state.begin() == nil, "one login at a time")
        require(state.opened(first), "window opened")
        require(state.checking(first), "explicit completion")
        require(!state.checking(first), "no duplicate completion")
        require(state.cancel(first), "cancel candidate")
        require(!state.complete(first, success: true), "late success cannot revive cancelled attempt")
        let second = state.begin()!
        require(second != first, "fresh attempt")
        require(!state.cancel(first), "old cancellation cannot affect new attempt")
        require(state.opened(second) && state.checking(second) && state.complete(second, success: true), "authenticated transition")
        require(state.phase == .signedIn && state.begin() == nil, "no implicit account replacement")
        print("LOGIN_POLICY_CHECKS_PASSED")
    }
}
