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

    init(mainOrigin: URL, resources: URL) throws {
        provider = try RelayServer(mainOrigin: mainOrigin, resources: resources, role: .provider)
        control = try RelayServer(mainOrigin: mainOrigin, resources: resources, role: .control)
        control.controlHandler = { [weak self] request, client in self?.handleControl(request, client: client) }
        provider.onReady = { [weak self] in self?.ready() }
        control.onReady = { [weak self] in self?.ready() }
    }

    func start() throws {
        try provider.start(); try control.start()
        let timer = DispatchSource.makeTimerSource(queue: relayQueue)
        timer.schedule(deadline: .now() + 60, repeating: 60)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
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
        phaseChanged?(state.phase)
    }

    private func ready() {
        guard !publishedReady, !provider.policy.localOrigin.isEmpty, !control.policy.localOrigin.isEmpty,
              let port = URL(string: control.policy.localOrigin)?.port else { return }
        publishedReady = true
        // Only the public control address is emitted, never either capability.
        if let data = try? JSONSerialization.data(withJSONObject: ["port": port, "host": control.loopbackHost]) {
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        }
        onReady?()
    }

    var providerURL: String? {
        guard provider.enabled, state.phase == .signedOut || state.phase == .signedIn else { return nil }
        return provider.policy.localURL("/", relativeTo: provider.policy.mainOrigin)
    }

    // Called only by native UI (or a private test pipe), never by an HTTP route.
    // The one-use fragment is not sent to the HTTP server or written to stdout.
    func controlLaunchURL() throws -> URL {
        let secret = try relayRandomKey()
        bootstrap = (secret, ProcessInfo.processInfo.systemUptime + 60)
        guard var components = URLComponents(string: control.policy.localOrigin + "/__safai/") else { throw RelayLoginError.invalidSession }
        components.fragment = "bootstrap=" + secret
        guard let url = components.url else { throw RelayLoginError.invalidSession }
        return url
    }

    private func status() -> [String: Any] {
        var value: [String: Any] = ["phase": state.phase.rawValue, "message": state.phase.message, "revision": state.revision]
        if let providerURL { value["providerURL"] = providerURL }
        return value
    }

    private func json(_ value: [String: Any], status: Int = 200, client: RelayClient) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { client.error(500, "無法讀取控制狀態"); return }
        client.send(status, data: data, headers: ["Content-Type": "application/json"])
    }

    private func handleControl(_ request: RelayRequest, client: RelayClient) {
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
                  relayConstantTimeEqual(request.headers["x-safai-bootstrap"] ?? "", bootstrap.secret) else { client.error(401, "請從 SafAI 原生程式重新開啟控制頁"); return }
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
        guard let presenter, let ticket = state.begin() else { return false }
        do { try provider.replaceSession(accessible: false) }
        catch {
            _ = state.opened(ticket); _ = state.checking(ticket); _ = state.complete(ticket, success: false)
            publishPhase()
            return false
        }
        publishPhase()
        let presentation = RelayLoginPresentation(attempt: ticket, opened: { [weak self] in
            relayQueue.async {
                guard let self, self.state.opened(ticket) else { return }
                self.publishPhase()
            }
        }, candidate: { [weak self] cookies, finished in
            relayQueue.async {
                guard let self, self.state.checking(ticket) else { finished(false); return }
                self.publishPhase()
                self.provider.verifyOwnedSession(cookies) { [weak self] valid in
                    guard let self, self.state.complete(ticket, success: valid) else { finished(false); return }
                    if valid { self.provider.enabled = true }
                    else { try? self.provider.replaceSession(accessible: false) }
                    self.publishPhase()
                    finished(valid)
                }
            }
        }, cancelled: { [weak self] in
            relayQueue.async { self?.cancelLogin(ticket) }
        })
        presenter(presentation)
        return true
    }

    func cancelLogin(_ ticket: Int) {
        guard state.cancel(ticket) else { return }
        do { try provider.replaceSession(accessible: true) }
        catch { provider.enabled = false }
        publishPhase()
    }
}
