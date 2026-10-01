import Foundation

struct RelayLoginPresentation {
    let attempt: Int
    let opened: () -> Void
    let candidate: ([HTTPCookie], @escaping (Bool) -> Void) -> Void
    let cancelled: () -> Void
}

// All broker state is owned by relayQueue. The presenter itself runs on the main queue.
final class RelayLoginBroker {
    let provider: RelayServer
    let control: RelayServer
    private(set) var state = RelayLoginState()
    var presenter: ((RelayLoginPresentation) -> Void)?
    var dismissLogin: (() -> Void)?
    var onReady: (() -> Void)?
    var phaseChanged: ((RelayLoginPhase) -> Void)?
    var willExitForIdle: (() -> Void)?
    private var publishedReady = false
    private var bootstrap: (secret: String, expires: TimeInterval)?
    private var loginActivity = Date()
    private var idleTimer: DispatchSourceTimer?
    #if RELAY_TESTING
    var testingIdleTimerActive: Bool { idleTimer != nil }
    #endif
    private let persistence: RelaySessionPersistence?
    private var persistenceError: String?
    private var savedRecord: Data?
    private var startupRestoreStarted = false
    private(set) var stopped = false

    init(mainOrigin: URL, resources: URL, persistence: RelaySessionPersistence? = nil) throws {
        self.persistence = persistence
        provider = try RelayServer(mainOrigin: mainOrigin, resources: resources, role: .provider)
        control = try RelayServer(mainOrigin: mainOrigin, resources: resources, role: .control)
        control.controlHandler = { [weak self] request, client in self?.handleControl(request, client: client) }
        provider.onReady = { [weak self] in self?.ready() }
        control.onReady = { [weak self] in self?.ready() }
        provider.sessionCookiesChanged = { [weak self] in self?.refreshPersistedSession() }
        if persistence != nil { provider.enabled = false }
    }

    func start() throws {
        guard !stopped else { throw RelayLoginError.invalidSession }
        try provider.start(); try control.start()
        updateIdleTimer()
    }

    private func updateIdleTimer() {
        // Confirmed and in-progress accounts cannot be reclaimed by this policy.
        // Keep their otherwise idle native process free of periodic checks.
        guard !stopped, state.phase == .signedOut else {
            idleTimer?.cancel(); idleTimer = nil
            return
        }
        guard idleTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: relayQueue)
        timer.schedule(deadline: .now() + 60, repeating: 60, leeway: .seconds(10))
        timer.setEventHandler { [weak self] in
            guard let self, !self.stopped else { return }
            let active = !self.provider.clients.isEmpty || !self.control.clients.isEmpty || !self.provider.probes.isEmpty
            guard RelayIdlePolicy.shouldExit(phase: self.state.phase, activity: [self.provider.lastActivity, self.control.lastActivity, self.loginActivity], hasActiveRequests: active) else { return }
            self.willExitForIdle?()
            self.provider.session.invalidateAndCancel(); self.control.session.invalidateAndCancel()
            exit(0)
        }
        timer.resume(); idleTimer = timer
    }

    private func publishPhase() {
        loginActivity = Date()
        updateIdleTimer()
        phaseChanged?(state.phase)
    }

    private func ready() {
        guard !stopped, !publishedReady, !provider.policy.localOrigin.isEmpty, !control.policy.localOrigin.isEmpty,
              let port = URL(string: control.policy.localOrigin)?.port else { return }
        publishedReady = true
        restoreSavedSession()
        // Only the public control address is emitted, never either capability.
        if let data = try? JSONSerialization.data(withJSONObject: ["port": port, "host": control.loopbackHost]) {
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        }
        onReady?()
    }

    var providerURL: String? {
        guard !stopped, provider.enabled, state.phase == .signedIn || (persistence == nil && state.phase == .signedOut) else { return nil }
        return provider.policy.localURL("/", relativeTo: provider.policy.mainOrigin)
    }

    // Called only by native UI (or a private test pipe), never by an HTTP route.
    // The one-use fragment is not sent to the HTTP server or written to stdout.
    func controlLaunchURL() throws -> URL {
        guard !stopped else { throw RelayLoginError.invalidSession }
        let secret = try relayRandomKey()
        bootstrap = (secret, ProcessInfo.processInfo.systemUptime + 60)
        guard var components = URLComponents(string: control.policy.localOrigin + "/__safai/") else { throw RelayLoginError.invalidSession }
        components.fragment = "bootstrap=" + secret
        guard let url = components.url else { throw RelayLoginError.invalidSession }
        return url
    }

    private func status() -> [String: Any] {
        var value: [String: Any] = ["phase": state.phase.rawValue, "message": state.phase.message, "revision": state.revision]
        value["persistent"] = persistence != nil
        value["stopped"] = stopped
        if persistence != nil, state.phase == .signedIn { value["message"] = "已登入；關閉 Safari 後仍會保留這個帳號。" }
        if let persistenceError { value["message"] = persistenceError; value["error"] = true }
        if let providerURL { value["providerURL"] = providerURL }
        return value
    }

    // Accessible only through the containing app's authenticated native bridge.
    func nativeStatus() -> [String: Any] { status() }

    func nativeCommand(_ action: String) -> [String: Any] {
        guard !stopped else { return ["accepted": false, "state": status()] }
        let accepted: Bool
        switch action {
        case "status": accepted = true
        case "login": accepted = beginLogin()
        case "reconnect": accepted = retrySavedSession()
        case "logout": accepted = logout()
        case "switch": accepted = logout() && beginLogin()
        default: accepted = false
        }
        return ["accepted": accepted, "state": status()]
    }

    // Explicit user action only. Status polling must never retry provider calls.
    @discardableResult
    func retrySavedSession() -> Bool {
        guard !stopped, persistence != nil, [.signedIn, .blocked, .signedOut].contains(state.phase) else { return false }
        state.reset()
        persistenceError = nil
        revokeProvider()
        startupRestoreStarted = false
        restoreSavedSession()
        // A missing saved record leaves the reset state signed out without a
        // publishPhase call from restoration, so restore its reclamation timer.
        updateIdleTimer()
        return true
    }

    // Must complete before the containing app releases its single-owner lock.
    // Unlike logout this preserves the saved account, but permanently retires
    // every capability, callback and persistence path in this broker instance.
    func shutdown() {
        dispatchPrecondition(condition: .onQueue(relayQueue))
        guard !stopped else { return }
        stopped = true
        state.reset()
        persistenceError = "Margina 中轉已停止；已儲存的登入資料仍保留。"
        bootstrap = nil
        idleTimer?.cancel(); idleTimer = nil
        for server in [provider, control] {
            server.enabled = false
            server.onReady = nil
            server.controlHandler = nil
            server.sessionCookiesChanged = nil
            server.listener?.newConnectionHandler = { connection in connection.cancel() }
            server.listener?.stateUpdateHandler = nil
            server.listener?.cancel(); server.listener = nil
            for client in Array(server.clients.values) { client.finish() }
            let abandoned = Array(server.probes.values)
            server.probes.removeAll(); server.transfers.removeAll()
            server.session.invalidateAndCancel()
            for probe in abandoned { probe.completion(false) }
        }
        savedRecord = nil
        dismissLogin?()
        presenter = nil
        onReady = nil
        publishPhase()
    }

    private func revokeProvider() {
        do { try provider.replaceSession(accessible: false) }
        catch { provider.enabled = false; provider.session.invalidateAndCancel() }
        savedRecord = nil
    }

    // Invalidate the ticket before cancelling probes: replaceSession invokes old
    // completions synchronously and none may re-save a just-logged-out account.
    @discardableResult
    func logout() -> Bool {
        guard !stopped else { return false }
        state.reset()
        persistenceError = nil
        revokeProvider()
        dismissLogin?()
        do { try persistence?.clear() }
        catch {
            state.reset(blocked: true)
            persistenceError = "已停止使用這個帳號，但無法完成移除儲存的登入資料。請解鎖 macOS 鑰匙圈後再次登出。"
            publishPhase()
            return false
        }
        publishPhase()
        return true
    }

    private func restoreSavedSession() {
        guard !stopped, !startupRestoreStarted, let persistence else { return }
        startupRestoreStarted = true
        do {
            guard let cookies = try persistence.load(), let ticket = state.restore() else { return }
            publishPhase()
            provider.verifyOwnedSession(cookies) { [weak self] valid in
                guard let self, !self.stopped, self.state.attempt == ticket, self.state.phase == .restoring else { return }
                self.finishVerification(ticket: ticket, valid: valid, restoring: true) { _ in }
            }
        } catch {
            state.reset(blocked: true)
            persistenceError = "無法讀取已儲存的登入資料。請確認 macOS 鑰匙圈已解鎖；若資料已失效，可重新登入或登出。"
            revokeProvider()
            publishPhase()
        }
    }

    private func saveCurrentSession() throws {
        guard !stopped else { throw RelayLoginError.invalidSession }
        guard let persistence else { return }
        let cookies = try RelayLoginPolicy.sessionCookies(from: provider.session.configuration.httpCookieStorage?.cookies ?? [])
        let record = try RelaySessionCodec.encode(cookies)
        if record != savedRecord { try persistence.save(cookies); savedRecord = record }
    }

    // Root calls this after a current-session upstream response finishes. A stale
    // response must already be excluded by RelayServer's URLSession identity check.
    func refreshPersistedSession() {
        guard !stopped, persistence != nil, state.phase == .signedIn else { return }
        do { try saveCurrentSession() }
        catch {
            state.reset(blocked: true)
            persistenceError = "更新登入資料時無法安全保存，已暫停對話。請確認 macOS 鑰匙圈後重新登入。"
            revokeProvider()
            publishPhase()
        }
    }

    private func finishVerification(ticket: Int, valid: Bool, restoring: Bool, finished: @escaping (Bool) -> Void) {
        guard !stopped, state.attempt == ticket, state.phase == .checking || state.phase == .restoring else { finished(false); return }
        var accepted = valid
        if accepted {
            do { try saveCurrentSession() }
            catch {
                accepted = false
                persistenceError = "登入已確認，但無法安全保存到 macOS 鑰匙圈，尚未啟用對話。請確認鑰匙圈後重新登入。"
            }
        } else if restoring {
            // A transport failure is not proof of expiry; keep the saved record
            // and report uncertainty, without silently retrying or exposing access.
            persistenceError = "暫時無法確認已儲存的登入。可能是連線、官方驗證或登入到期；尚未載入對話。可重新登入或登出。"
        }
        guard state.complete(ticket, success: accepted) else { finished(false); return }
        if accepted { provider.enabled = true }
        else { revokeProvider() }
        publishPhase()
        finished(accepted)
    }

    private func json(_ value: [String: Any], status: Int = 200, client: RelayClient) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { client.error(500, "無法讀取控制狀態"); return }
        client.send(status, data: data, headers: ["Content-Type": "application/json"])
    }

    private func handleControl(_ request: RelayRequest, client: RelayClient) {
        guard !stopped else { client.error(503, "Margina 中轉已停止"); return }
        guard let path = URLComponents(string: control.policy.localOrigin + request.target)?.path else { client.error(400, "網址格式無效"); return }
        if path == "/__safai/" {
            do {
                let html = try String(contentsOf: control.resources.appendingPathComponent("preview.html"), encoding: .utf8)
                client.send(200, data: Data(html.utf8), headers: ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src \(provider.policy.localOrigin); frame-ancestors 'none'; base-uri 'none'; form-action 'none'"])
            } catch { client.error(500, "找不到中轉測試頁"); }
        } else if path == "/__safai/preview.js" {
            control.resource("preview.js", client: client)
        } else if path == "/__safai/bootstrap" {
            guard let bootstrap, ProcessInfo.processInfo.systemUptime <= bootstrap.expires,
                  relayConstantTimeEqual(request.headers["x-safai-bootstrap"] ?? "", bootstrap.secret) else { client.error(401, "請從 Margina 原生程式重新開啟控制頁"); return }
            self.bootstrap = nil
            json(["controlKey": control.policy.key], client: client)
        } else if path == "/__safai/status" {
            json(status(), client: client)
        } else if path == "/__safai/login/start" {
            let started = beginLogin()
            json(["accepted": started, "state": status()], status: started ? 202 : 409, client: client)
        } else if path == "/__safai/login/cancel" {
            cancelLogin(state.attempt)
            dismissLogin?()
            json(status(), client: client)
        } else { client.error(404, "找不到控制操作"); }
    }

    @discardableResult
    func beginLogin() -> Bool {
        guard !stopped, let presenter, let ticket = state.begin() else { return false }
        persistenceError = nil
        do { try provider.replaceSession(accessible: false) }
        catch {
            _ = state.opened(ticket); _ = state.checking(ticket); _ = state.complete(ticket, success: false)
            publishPhase()
            return false
        }
        publishPhase()
        let presentation = RelayLoginPresentation(attempt: ticket, opened: { [weak self] in
            relayQueue.async {
                guard let self, !self.stopped, self.state.opened(ticket) else { return }
                self.publishPhase()
            }
        }, candidate: { [weak self] cookies, finished in
            relayQueue.async {
                guard let self, !self.stopped, self.state.checking(ticket) else { finished(false); return }
                self.publishPhase()
                self.provider.verifyOwnedSession(cookies) { [weak self] valid in
                    guard let self else { finished(false); return }
                    self.finishVerification(ticket: ticket, valid: valid, restoring: false, finished: finished)
                }
            }
        }, cancelled: { [weak self] in
            relayQueue.async { self?.cancelLogin(ticket) }
        })
        presenter(presentation)
        return true
    }

    func cancelLogin(_ ticket: Int) {
        guard !stopped, state.cancel(ticket) else { return }
        do { try provider.replaceSession(accessible: persistence == nil) }
        catch { provider.enabled = false }
        publishPhase()
    }
}
