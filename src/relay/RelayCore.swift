import Foundation
import Network
import Security

// Experimental, local-origin relay. Provider cookies belong only to this process.
// Neither the Safari cookie store nor extension settings are read by this service.
let relayQueue = DispatchQueue(label: "dev.safai.relay")
let relayKeyParameter = "__safai_key"
let relayMaximumBody = 32 * 1024 * 1024
let relayMaximumDocument = 16 * 1024 * 1024
#if RELAY_TESTING
let relayWriteTimeout: Double = 0.5
#else
let relayWriteTimeout: Double = 30
#endif

func relayRandomKey() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw NSError(domain: "SafAIRelay", code: 1)
    }
    return bytes.map { String(format: "%02x", $0) }.joined()
}

func relayEscapeHTML(_ value: String) -> String {
    value.replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
}

func relayConstantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let a = Array(lhs.utf8), b = Array(rhs.utf8)
    guard a.count == b.count else { return false }
    var difference: UInt8 = 0
    for index in a.indices { difference |= a[index] ^ b[index] }
    return difference == 0
}

struct RelayRequest {
    let method: String
    let target: String
    let headers: [String: String]
    let body: Data
}

struct RelayPolicy {
    var key: String
    var bridgeNonce: String
    let mainOrigin: URL
    var localOrigin: String = ""
    let hosts: Set<String> = ["chatgpt.com", "cdn.oaistatic.com", "persistent.oaistatic.com", "auth.openai.com"]

    func authorized(_ request: RelayRequest) -> Bool {
        let query = URLComponents(string: localOrigin + request.target)?.queryItems ?? []
        let keys = query.filter { $0.name == relayKeyParameter }
        if keys.count > 1 { return false }
        let supplied = request.headers["x-safai-relay"] ?? keys.first?.value ?? ""
        return relayConstantTimeEqual(supplied, key)
    }

    func upstreamURL(_ target: String) -> URL? {
        guard target.hasPrefix("/"), !target.hasPrefix("//"),
              var local = URLComponents(string: localOrigin + target), local.user == nil, local.password == nil else { return nil }
        local.queryItems = local.queryItems?.filter { $0.name != relayKeyParameter }
        if local.queryItems?.isEmpty == true { local.queryItems = nil }
        let prefix = "/__safai/upstream/"
        var upstream = URLComponents(url: mainOrigin, resolvingAgainstBaseURL: false)!
        if local.path.hasPrefix(prefix) {
            let remainder = String(local.path.dropFirst(prefix.count))
            let pieces = remainder.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
            guard let host = pieces.first.map(String.init), hosts.contains(host) else { return nil }
            upstream = URLComponents(string: "https://\(host)")!
            // Reject escaped host separators instead of reinterpreting their origin.
            guard local.percentEncodedPath.hasPrefix(prefix + host + "/") else { return nil }
            upstream.percentEncodedPath = String(local.percentEncodedPath.dropFirst((prefix + host).count))
        } else {
            upstream.percentEncodedPath = local.percentEncodedPath
        }
        upstream.percentEncodedQuery = local.percentEncodedQuery
        return upstream.url
    }

    func localURL(_ value: String, relativeTo base: URL) -> String? {
        guard let upstream = URL(string: value, relativeTo: base)?.absoluteURL,
              upstream.user == nil, upstream.password == nil,
              var parts = URLComponents(url: upstream, resolvingAgainstBaseURL: false) else { return nil }
        let main = URLComponents(url: mainOrigin, resolvingAgainstBaseURL: false)!
        let isMain = parts.scheme == main.scheme && parts.host == main.host && parts.port == main.port
        guard isMain || (parts.scheme == "https" && parts.port == nil && hosts.contains(parts.host ?? "")) else { return nil }
        var path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        if !isMain { path = "/__safai/upstream/\(parts.host!)" + path }
        parts = URLComponents(string: localOrigin + path)!
        var query = URLComponents(url: upstream, resolvingAgainstBaseURL: false)?.queryItems ?? []
        query.removeAll { $0.name == relayKeyParameter }
        query.append(URLQueryItem(name: relayKeyParameter, value: key))
        parts.queryItems = query
        parts.fragment = upstream.fragment
        return parts.string
    }

    func publicStatic(_ request: RelayRequest) -> Bool {
        guard request.method == "GET" || request.method == "HEAD",
              let parts = URLComponents(string: localOrigin + request.target),
              parts.query == nil else { return false }
        return parts.percentEncodedPath.range(of: #"^/cdn/assets/[A-Za-z0-9_-]+[.-][A-Za-z0-9._-]+\.(js|css|woff2|woff|svg|png|webp|ico)$"#, options: .regularExpression) != nil
    }

    func documentPolicy(_ original: String, nonce: String) -> String {
        let removed: Set<String> = ["frame-ancestors", "report-uri", "report-to", "upgrade-insecure-requests", "block-all-mixed-content"]
        var directives = original.split(separator: ";").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !removed.contains($0.split(separator: " ").first.map(String.init)?.lowercased() ?? "") }
        if directives.isEmpty { directives = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "object-src 'none'"] }
        let nonceValue = "'nonce-\(nonce)'"
        if let index = directives.firstIndex(where: { $0.hasPrefix("script-src ") }) {
            if !directives[index].contains(nonceValue) { directives[index] = directives[index].replacingOccurrences(of: "'none'", with: "") + " " + nonceValue }
        } else {
            let fallback = directives.first(where: { $0.hasPrefix("default-src ") }).map { String($0.dropFirst("default-src ".count)) } ?? "'self'"
            directives.append("script-src " + fallback.replacingOccurrences(of: "'none'", with: "") + " " + nonceValue)
        }
        if let index = directives.firstIndex(where: { $0.hasPrefix("script-src-elem ") }) {
            if !directives[index].contains(nonceValue) { directives[index] = directives[index].replacingOccurrences(of: "'none'", with: "") + " " + nonceValue }
        }
        return directives.joined(separator: "; ")
    }

    func rewriteDocument(_ original: String, nonce: String) -> String {
        let bridge = "<script nonce=\"\(nonce)\" src=\"/__safai/bridge.js?\(relayKeyParameter)=\(key)\"></script>"
        if let range = original.range(of: #"<head(?:\s[^>]*)?>"#, options: [.regularExpression, .caseInsensitive]) {
            var result = original
            result.insert(contentsOf: bridge, at: range.upperBound)
            return result
        }
        return bridge + original
    }
}

final class RelayClient {
    let id = UUID()
    let connection: NWConnection
    weak var server: RelayServer?
    var buffer = Data()
    var task: URLSessionDataTask?
    var responded = false
    var completed = false
    var deadline: DispatchWorkItem?
    var writeDeadline: DispatchWorkItem?
    var lifetimeDeadline: DispatchWorkItem?
    var pendingWrites = 0
    var headersChecked = false
    var reservedBodyBytes = 0

    init(_ connection: NWConnection, server: RelayServer) { self.connection = connection; self.server = server }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.finish() }
            if case .cancelled = state { self?.finish() }
        }
        connection.start(queue: relayQueue)
        let work = DispatchWorkItem { [weak self] in self?.error(408, "讀取請求逾時") }
        deadline = work
        relayQueue.asyncAfter(deadline: .now() + 15, execute: work)
        let lifetime = DispatchWorkItem { [weak self] in self?.finish() }
        lifetimeDeadline = lifetime
        relayQueue.asyncAfter(deadline: .now() + 600, execute: lifetime)
        receive()
    }

    func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, failure in
            guard let self, !self.completed else { return }
            if let data { self.buffer.append(data) }
            if self.buffer.count > relayMaximumBody + 32_768 { self.error(413, "請求過大"); return }
            if let end = self.buffer.range(of: Data("\r\n\r\n".utf8)) {
                guard end.lowerBound <= 32_768, let head = String(data: self.buffer[..<end.lowerBound], encoding: .utf8) else { self.error(400, "請求格式無效"); return }
                let lines = head.components(separatedBy: "\r\n")
                let requestLine = lines[0].split(separator: " ", omittingEmptySubsequences: false)
                guard requestLine.count == 3, requestLine[2] == "HTTP/1.1", lines.count <= 101 else { self.error(400, "請求格式無效"); return }
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":"), line.first != " ", line.first != "\t" else { self.error(400, "標頭格式無效"); return }
                    let name = String(line[..<colon]).lowercased()
                    guard name.range(of: #"^[a-z0-9!#$%&'*+.^_`|~-]+$"#, options: .regularExpression) != nil, headers[name] == nil else { self.error(400, "重複或無效的標頭"); return }
                    headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                }
                guard headers["transfer-encoding"] == nil else { self.error(400, "不支援此上傳編碼"); return }
                let size = headers["content-length"] ?? "0"
                guard size.range(of: #"^[0-9]+$"#, options: .regularExpression) != nil, let count = Int(size), count <= relayMaximumBody else { self.error(413, "請求過大或長度無效"); return }
                if !self.headersChecked {
                    let request = RelayRequest(method: String(requestLine[0]), target: String(requestLine[1]), headers: headers, body: Data())
                    guard let server = self.server, server.preflight(request, client: self) else { return }
                    guard server.pendingRequestBytes + count <= 128 * 1024 * 1024 else { self.error(503, "中轉上傳忙碌中，請稍後再試"); return }
                    self.headersChecked = true
                    self.reservedBodyBytes = count
                    server.pendingRequestBytes += count
                }
                if self.buffer.count >= end.upperBound + count {
                    self.deadline?.cancel()
                    let request = RelayRequest(method: String(requestLine[0]), target: String(requestLine[1]), headers: headers, body: self.buffer.subdata(in: end.upperBound..<(end.upperBound + count)))
                    self.buffer = Data()
                    self.server?.handle(request, client: self)
                    return
                }
            } else if self.buffer.count > 32_768 { self.error(431, "標頭過大"); return }
            if failure != nil || complete { self.finish(); return }
            self.receive()
        }
    }

    func sendHead(_ status: Int, headers: [String: String], length: Int? = nil) {
        guard !responded, !completed else { return }
        responded = true
        var values = headers
        values["Connection"] = "close"
        values["Cache-Control"] = "no-store"
        values["Referrer-Policy"] = "no-referrer"
        values["X-Content-Type-Options"] = "nosniff"
        if let length { values["Content-Length"] = String(length) } else { values["Transfer-Encoding"] = "chunked" }
        var head = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status))\r\n"
        for (name, value) in values where !value.contains("\r") && !value.contains("\n") { head += "\(name): \(value)\r\n" }
        head += "\r\n"
        willWrite()
        connection.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] error in self?.didWrite(error) })
    }

    func send(_ status: Int, data: Data, headers: [String: String]) {
        guard !responded, !completed else { return }
        sendHead(status, headers: headers, length: data.count)
        willWrite()
        connection.send(content: data, completion: .contentProcessed { [weak self] error in self?.didWrite(error); self?.finish() })
    }

    func stream(_ data: Data, completion: @escaping () -> Void) {
        guard !completed else { completion(); return }
        var framed = Data(String(data.count, radix: 16).utf8)
        framed.append(Data("\r\n".utf8)); framed.append(data); framed.append(Data("\r\n".utf8))
        willWrite()
        connection.send(content: framed, completion: .contentProcessed { [weak self] error in
            self?.didWrite(error)
            completion()
        })
    }

    func endStream() {
        guard !completed else { return }
        willWrite()
        connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { [weak self] error in self?.didWrite(error); self?.finish() })
    }

    func willWrite() {
        pendingWrites += 1
        if pendingWrites == 1 { armWriteDeadline() }
    }

    func didWrite(_ error: NWError?) {
        pendingWrites = max(0, pendingWrites - 1)
        if error != nil { finish(); return }
        if pendingWrites == 0 { writeDeadline?.cancel() }
        else { armWriteDeadline() }
    }

    func armWriteDeadline() {
        writeDeadline?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.finish() }
        writeDeadline = work
        relayQueue.asyncAfter(deadline: .now() + relayWriteTimeout, execute: work)
    }

    func error(_ status: Int, _ message: String) {
        if responded { finish(); return }
        let body = "<!doctype html><meta charset=\"utf-8\"><title>SafAI 中轉狀態</title><h1>尚無法顯示 ChatGPT</h1><p>\(relayEscapeHTML(message))</p><p>沒有自動重試、登入或傳送對話。</p>"
        send(status, data: Data(body.utf8), headers: ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'"])
    }

    func finish() {
        guard !completed else { return }
        completed = true
        deadline?.cancel()
        lifetimeDeadline?.cancel()
        writeDeadline?.cancel()
        server?.pendingRequestBytes -= reservedBodyBytes
        buffer = Data()
        task?.cancel()
        connection.cancel()
        server?.clients.removeValue(forKey: id)
    }
}

final class RelayTransfer {
    let client: RelayClient
    let url: URL
    let method: String
    let staticOnly: Bool
    var status = 0
    var headers: [String: String] = [:]
    var document = false
    var body = Data()
    var received = 0
    init(client: RelayClient, url: URL, method: String, staticOnly: Bool) { self.client = client; self.url = url; self.method = method; self.staticOnly = staticOnly }
}

enum RelayServerRole { case provider, control }

struct RelayTaskKey: Hashable {
    let session: ObjectIdentifier
    let task: Int
    init(_ session: URLSession, _ task: URLSessionTask) { self.session = ObjectIdentifier(session); self.task = task.taskIdentifier }
}

final class RelaySessionProbe {
    let url: URL
    let completion: (Bool) -> Void
    var body = Data()
    var status = 0
    var accepted = false
    init(url: URL, completion: @escaping (Bool) -> Void) { self.url = url; self.completion = completion }
}

final class RelayServer: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    var policy: RelayPolicy
    let resources: URL
    let role: RelayServerRole
    let loopbackHost: String
    var enabled = true
    var onReady: (() -> Void)?
    var controlHandler: ((RelayRequest, RelayClient) -> Void)?
    var listener: NWListener?
    var clients: [UUID: RelayClient] = [:]
    var pendingRequestBytes = 0
    var requestCount = 0
    var challengeCount = 0
    var deviceHeaderPresent = false
    var deviceCookiePresent = false
    var deviceMismatchObserved = false
    var transfers: [RelayTaskKey: RelayTransfer] = [:]
    var probes: [RelayTaskKey: RelaySessionProbe] = [:]
    var session: URLSession!
    var lastActivity = Date()
    var idleTimer: DispatchSourceTimer?

    init(mainOrigin: URL, resources: URL, role: RelayServerRole = .provider) throws {
        self.policy = RelayPolicy(key: try relayRandomKey(), bridgeNonce: try relayRandomKey(), mainOrigin: mainOrigin)
        self.resources = resources
        self.role = role
        self.loopbackHost = "safai-\(role == .control ? "control" : "provider")-\(UUID().uuidString.lowercased()).localhost"
        super.init()
        session = makeSession()
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 600
        configuration.httpMaximumConnectionsPerHost = 6
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }

    func start() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            if case .ready = state, let port = listener.port {
                self.policy.localOrigin = "http://\(self.loopbackHost):\(port.rawValue)"
                self.onReady?()
            }
            if case .failed = state { FileHandle.standardError.write(Data("Relay listener failed\n".utf8)); exit(1) }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self, self.clients.count < 32 else { connection.cancel(); return }
            let client = RelayClient(connection, server: self)
            self.clients[client.id] = client
            client.start()
        }
        listener.start(queue: relayQueue)
        let timer = DispatchSource.makeTimerSource(queue: relayQueue)
        timer.schedule(deadline: .now() + 60, repeating: 60)
        timer.setEventHandler { [weak self] in
            if let self, Date().timeIntervalSince(self.lastActivity) > 1800 { self.session.invalidateAndCancel(); exit(0) }
        }
        timer.resume(); idleTimer = timer
    }

    func handle(_ request: RelayRequest, client: RelayClient) {
        guard preflight(request, client: client) else { return }
        guard request.headers["host"] == String(policy.localOrigin.dropFirst("http://".count)) else { client.error(403, "只接受本機連線"); return }
        guard let local = URLComponents(string: policy.localOrigin + request.target), local.host == loopbackHost else { client.error(400, "網址格式無效"); return }
        let origin = request.headers["origin"]
        guard origin == nil || origin == policy.localOrigin else { client.error(403, "拒絕其他網站的請求"); return }
        guard ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].contains(request.method) else { client.error(405, "不支援此操作"); return }
        if role == .control {
            guard let controlHandler else { client.error(503, "控制介面尚未就緒"); return }
            lastActivity = Date()
            controlHandler(request, client)
            return
        }
        let authorized = policy.authorized(request)
        guard authorized || policy.publicStatic(request) else { client.error(401, "本機中轉工作階段無效，請從測試入口重新開啟"); return }
        lastActivity = Date()
        if local.path == "/__safai/bridge.js", request.method == "GET" { resource("browser.js", client: client); return }
        if local.path == "/__safai/status", request.method == "GET" {
            let status: [String: Any] = ["requests": requestCount, "challenges": challengeCount, "device_header_present": deviceHeaderPresent, "device_cookie_present": deviceCookiePresent, "device_mismatch_observed": deviceMismatchObserved]
            if let data = try? JSONSerialization.data(withJSONObject: status) { client.send(200, data: data, headers: ["Content-Type": "application/json"]) }
            else { client.error(500, "無法讀取中轉狀態"); }
            return
        }
        guard let upstream = policy.upstreamURL(request.target) else { client.error(403, "未允許此網站的中轉"); return }
        guard upstream.host != "auth.openai.com" else { client.error(501, "登入頁的獨立來源隔離尚未完成，已停止載入；請勿在此原型輸入帳號密碼"); return }
        if request.headers["upgrade"] != nil { client.error(501, "此原型尚未支援 WebSocket"); return }
        var outgoing = URLRequest(url: upstream)
        outgoing.httpMethod = request.method
        if !request.body.isEmpty { outgoing.httpBody = request.body }
        let basic: Set<String> = ["accept", "accept-language", "content-type", "authorization", "range", "if-range", "last-event-id"]
        for (name, value) in request.headers where basic.contains(name) || name.hasPrefix("oai-") || name.hasPrefix("openai-") || name.hasPrefix("x-openai-") {
            if value.utf8.count <= 8192 { outgoing.setValue(value, forHTTPHeaderField: name) }
        }
        if origin != nil {
            var parts = URLComponents(url: upstream, resolvingAgainstBaseURL: false)!
            parts.path = ""; parts.query = nil; parts.fragment = nil
            outgoing.setValue(parts.string, forHTTPHeaderField: "Origin")
        }
        // No incoming Cookie/Referer/Host/control headers are forwarded.
        // Static modules use a separate cookie-free request policy.
        if !authorized { outgoing.httpShouldHandleCookies = false }
        requestCount += 1
        if let deviceHeader = request.headers["oai-device-id"], upstream.host == policy.mainOrigin.host {
            deviceHeaderPresent = true
            if let cookie = session.configuration.httpCookieStorage?.cookies(for: upstream)?.first(where: { $0.name == "oai-did" }) {
                deviceCookiePresent = true
                if deviceHeader != cookie.value { deviceMismatchObserved = true }
            }
        }
        let task = session.dataTask(with: outgoing)
        client.task = task
        let staticOnly = policy.publicStatic(request) || upstream.host == "cdn.oaistatic.com" || upstream.host == "persistent.oaistatic.com"
        transfers[RelayTaskKey(session, task)] = RelayTransfer(client: client, url: upstream, method: request.method, staticOnly: staticOnly)
        task.resume()
    }

    func preflight(_ request: RelayRequest, client: RelayClient) -> Bool {
        guard request.headers["host"] == String(policy.localOrigin.dropFirst("http://".count)) else { client.error(403, "只接受本機連線"); return false }
        guard request.target.hasPrefix("/"), !request.target.hasPrefix("//"), let local = URLComponents(string: policy.localOrigin + request.target), local.host == loopbackHost else { client.error(400, "網址格式無效"); return false }
        guard request.headers["origin"] == nil || request.headers["origin"] == policy.localOrigin else { client.error(403, "拒絕其他網站的請求"); return false }
        guard ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].contains(request.method) else { client.error(405, "不支援此操作"); return false }
        if role == .control {
            if local.path == "/__safai/" {
                guard request.method == "GET", request.headers["sec-fetch-dest"] == nil || request.headers["sec-fetch-dest"] == "document" else { client.error(403, "控制介面必須直接開啟"); return false }
                return true
            }
            if local.path == "/__safai/preview.js", request.method == "GET" { return true }
            if local.path == "/__safai/bootstrap" {
                guard request.method == "POST", request.headers["origin"] == policy.localOrigin,
                      request.headers["content-length"] == nil || request.headers["content-length"] == "0" else { client.error(403, "控制頁授權來源無效"); return false }
                guard request.headers["x-safai-bootstrap"]?.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil else { client.error(401, "控制頁授權無效"); return false }
                return true
            }
            guard relayConstantTimeEqual(request.headers["x-safai-control"] ?? "", policy.key) else { client.error(401, "控制工作階段無效"); return false }
            if local.path == "/__safai/status", request.method == "GET" { return true }
            if local.path == "/__safai/login/start" || local.path == "/__safai/login/cancel" {
                guard request.method == "POST" else { client.error(405, "登入控制只接受 POST"); return false }
                guard request.headers["origin"] == policy.localOrigin else { client.error(403, "登入控制來源無效"); return false }
                guard request.headers["content-length"] == nil || request.headers["content-length"] == "0" else { client.error(400, "登入控制不接受帳號資料或其他內容"); return false }
                return true
            }
            client.error(404, "找不到控制操作"); return false
        }
        if local.path == "/__safai/" || local.path == "/__safai/preview.js" || local.path == "/__safai/bootstrap" || local.path.hasPrefix("/__safai/login/") {
            client.error(403, "ChatGPT 網頁不能使用登入控制介面"); return false
        }
        guard policy.authorized(request) || policy.publicStatic(request) else { client.error(401, "本機中轉工作階段無效"); return false }
        guard enabled else { client.error(503, "登入工作階段正在確認，請稍候"); return false }
        if local.path == "/__safai/bridge.js", request.method == "GET" { return true }
        guard let upstream = policy.upstreamURL(request.target) else { client.error(403, "未允許此網站的中轉"); return false }
        guard upstream.host != "auth.openai.com" else { client.error(501, "登入頁的獨立來源隔離尚未完成；請勿輸入帳號密碼"); return false }
        return true
    }

    func resource(_ name: String, client: RelayClient) {
        do { client.send(200, data: try Data(contentsOf: resources.appendingPathComponent(name)), headers: ["Content-Type": "application/javascript; charset=utf-8"]) }
        catch { client.error(500, "找不到中轉元件"); }
    }

    func replaceSession(accessible: Bool) throws {
        enabled = false
        for client in Array(clients.values) { client.finish() }
        let abandoned = Array(probes.values)
        probes.removeAll(); transfers.removeAll()
        session.invalidateAndCancel()
        session = makeSession()
        policy.key = try relayRandomKey()
        policy.bridgeNonce = try relayRandomKey()
        deviceHeaderPresent = false; deviceCookiePresent = false; deviceMismatchObserved = false
        enabled = accessible
        for probe in abandoned { probe.completion(false) }
    }

    func verifyOwnedSession(_ cookies: [HTTPCookie], completion: @escaping (Bool) -> Void) {
        do {
            let accepted = try RelayLoginPolicy.sessionCookies(from: cookies)
            try replaceSession(accessible: false)
            guard let storage = session.configuration.httpCookieStorage else { completion(false); return }
            for cookie in accepted { storage.setCookie(cookie) }
            let url = policy.mainOrigin.appendingPathComponent("api/auth/session")
            var request = URLRequest(url: url)
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let task = session.dataTask(with: request)
            probes[RelayTaskKey(session, task)] = RelaySessionProbe(url: url, completion: completion)
            task.resume()
        } catch { completion(false) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Redirects must pass through the allow-list and URL rewriter, not escape to an arbitrary host.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        relayQueue.async { [weak self] in
            guard let self, self.session === session, let response = response as? HTTPURLResponse else { completionHandler(.cancel); return }
            let key = RelayTaskKey(session, dataTask)
            if let probe = self.probes[key] {
                let type = response.value(forHTTPHeaderField: "Content-Type")?.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces) ?? ""
                probe.status = response.statusCode
                probe.accepted = response.url == probe.url && response.statusCode == 200 && type == "application/json" && response.value(forHTTPHeaderField: "cf-mitigated") != "challenge" && response.expectedContentLength <= RelayLoginPolicy.sessionResponseLimit
                completionHandler(probe.accepted ? .allow : .cancel)
                return
            }
            guard let transfer = self.transfers[key] else { completionHandler(.cancel); return }
            transfer.status = response.statusCode
            if response.value(forHTTPHeaderField: "cf-mitigated") == "challenge" {
                self.challengeCount += 1
                transfer.client.error(502, "ChatGPT 需要瀏覽器驗證；中轉未自動通過驗證，也未借用 Safari 的登入資料")
                completionHandler(.cancel); return
            }
            let type = response.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
            if transfer.staticOnly {
                let mime = type.lowercased().split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
                let accepted = ["application/javascript", "text/javascript", "application/x-javascript", "text/css", "application/octet-stream", "application/font-woff", "application/font-woff2"].contains(mime) || mime.hasPrefix("font/") || mime.hasPrefix("image/")
                guard accepted, response.value(forHTTPHeaderField: "Location") == nil else {
                    transfer.client.error(502, "靜態資源回傳了不允許的內容或跳轉，已停止載入")
                    completionHandler(.cancel); return
                }
                if mime == "image/svg+xml" { transfer.headers["Content-Security-Policy"] = "default-src 'none'; sandbox" }
            }
            transfer.headers["Content-Type"] = type
            transfer.document = type.lowercased().contains("text/html")
            if let location = response.value(forHTTPHeaderField: "Location") {
                guard let rewritten = self.policy.localURL(location, relativeTo: transfer.url) else {
                    transfer.client.error(502, "登入或導覽將前往尚未允許的網站；已停止中轉")
                    completionHandler(.cancel); return
                }
                transfer.headers["Location"] = rewritten
            }
            if !transfer.staticOnly, let policy = response.value(forHTTPHeaderField: "Content-Security-Policy") { transfer.headers["Content-Security-Policy"] = policy }
            if !transfer.document || transfer.method == "HEAD" {
                transfer.client.sendHead(transfer.status, headers: transfer.headers)
            }
            completionHandler(.allow)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        dataTask.suspend()
        relayQueue.async { [weak self] in
            guard let self, self.session === session else { dataTask.cancel(); return }
            let key = RelayTaskKey(session, dataTask)
            if let probe = self.probes[key] {
                guard probe.body.count + data.count <= RelayLoginPolicy.sessionResponseLimit else { probe.accepted = false; dataTask.cancel(); return }
                probe.body.append(data); dataTask.resume(); return
            }
            guard let transfer = self.transfers[key], !transfer.client.completed else { dataTask.cancel(); return }
            transfer.received += data.count
            guard transfer.received <= (transfer.document ? relayMaximumDocument : relayMaximumBody) else {
                transfer.client.error(502, "上游回應超過中轉大小限制"); dataTask.cancel(); return
            }
            if transfer.document {
                transfer.body.append(data)
                dataTask.resume()
            } else {
                transfer.client.stream(data) { dataTask.resume() }
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        relayQueue.async { [weak self] in
            guard let self else { return }
            let key = RelayTaskKey(session, task)
            if let probe = self.probes.removeValue(forKey: key) {
                probe.completion(self.session === session && error == nil && probe.accepted && RelayLoginPolicy.validSessionResponse(status: probe.status, data: probe.body))
                return
            }
            guard self.session === session, let transfer = self.transfers.removeValue(forKey: key), !transfer.client.completed else { return }
            if error != nil { transfer.client.error(502, "上游連線失敗或中斷，沒有自動重試"); return }
            if transfer.document && transfer.method != "HEAD" {
                guard let html = String(data: transfer.body, encoding: .utf8) else { transfer.client.error(502, "上游網頁不是有效 UTF-8"); return }
                let nonce = self.policy.bridgeNonce
                transfer.headers["Content-Security-Policy"] = self.policy.documentPolicy(transfer.headers["Content-Security-Policy"] ?? "", nonce: nonce)
                let body = self.policy.rewriteDocument(html, nonce: nonce)
                transfer.client.send(transfer.status, data: Data(body.utf8), headers: transfer.headers)
            } else { transfer.client.endStream() }
        }
    }
}
