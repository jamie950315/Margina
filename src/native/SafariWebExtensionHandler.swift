import SafariServices
import AppKit

private final class NativeResponse: NSObject, URLSessionDataDelegate {
    private var body = Data()
    private var response: HTTPURLResponse?
    private let completion: (Data?, HTTPURLResponse?, Error?) -> Void
    init(completion: @escaping (Data?, HTTPURLResponse?, Error?) -> Void) { self.completion = completion }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard response.expectedContentLength <= 16384 else { completionHandler(.cancel); return }
        self.response = response as? HTTPURLResponse
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard data.count <= 16384 - body.count else { dataTask.cancel(); return }
        body.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        completion(error == nil ? body : nil, response, error)
        session.invalidateAndCancel()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        guard let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] else {
            finish(context, value: ["error": "不支援的 SafAI 操作"]); return
        }
        if message["action"] as? String == "settings.read" {
            handleSettingsRead(message, item: item, context: context); return
        }
        if message["action"] as? String == "settings.write" {
            handleSettingsWrite(message, item: item, context: context); return
        }
        guard
              message.count == 1, let action = message["action"] as? String,
              ["status", "login", "logout", "switch", "reconnect"].contains(action) else {
            finish(context, value: ["error": "不支援的 SafAI 操作"]); return
        }
        // Resolve this extension's actual containing app, never a globally registered duplicate.
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard app.pathExtension == "app", Bundle(url: app)?.bundleIdentifier == "dev.jamie.safai" else {
            finish(context, value: ["error": "找不到 SafAI App"]); return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.allowsRunningApplicationSubstitution = false
        NSWorkspace.shared.openApplication(at: app, configuration: configuration) { [self] _, error in
            guard error == nil else { finish(context, value: ["error": "無法開啟 SafAI App"]); return }
            connect(action, context: context, attempts: 20)
        }
    }

    private func settingsVault(for item: NSExtensionItem?) throws -> SettingsVault {
        if #available(macOS 14.0, *) {
            // Safari omits SFExtensionProfileKey for normal browsing (the default
            // profile). A supplied identifier distinguishes every named profile.
            guard let value = item?.userInfo?[SFExtensionProfileKey] else {
                return try SettingsVault(account: "default")
            }
            let identifier: String
            if let value = value as? UUID { identifier = value.uuidString.lowercased() }
            else if let value = value as? NSUUID { identifier = value.uuidString.lowercased() }
            else if let value = value as? String { identifier = value.lowercased() }
            else { throw SettingsVaultError.invalidSettings }
            guard identifier.range(of: #"^[a-z0-9-]{1,128}$"#, options: .regularExpression) != nil else {
                throw SettingsVaultError.invalidSettings
            }
            return try SettingsVault(account: "profile." + identifier)
        }
        return try SettingsVault(account: "default")
    }

    private func handleSettingsRead(_ message: [String: Any], item: NSExtensionItem?, context: NSExtensionContext) {
        guard message.count == 1 else {
            finish(context, value: ["error": "無法讀取 SafAI 設定，請再試一次"]); return
        }
        do {
            let settings = try settingsVault(for: item).read()
            finish(context, value: ["ok": true, "settings": settings ?? NSNull()])
        } catch {
            finish(context, value: ["error": "無法讀取 SafAI 設定，請再試一次"])
        }
    }

    private func handleSettingsWrite(_ message: [String: Any], item: NSExtensionItem?, context: NSExtensionContext) {
        guard message.count == 3, Set(message.keys) == ["action", "settings", "expected"],
              let settings = message["settings"] as? [String: Any] else {
            finish(context, value: ["error": "無法儲存 SafAI 設定，請再試一次"]); return
        }
        let expected: [String: Any]?
        if message["expected"] is NSNull { expected = nil }
        else if let value = message["expected"] as? [String: Any] { expected = value }
        else {
            finish(context, value: ["error": "無法儲存 SafAI 設定，請再試一次"]); return
        }
        do {
            guard try settingsVault(for: item).write(settings, expected: expected) else {
                finish(context, value: ["code": "SETTINGS_CONFLICT", "error": "設定已在另一個 Safari 視窗變更，請重新載入後再試一次"])
                return
            }
            finish(context, value: ["ok": true, "settings": settings])
        } catch {
            finish(context, value: ["error": "無法儲存 SafAI 設定，請再試一次"])
        }
    }

    private func finish(_ context: NSExtensionContext, value: [String: Any]) {
        let response = NSExtensionItem()
        var value = value
        if value["ok"] == nil { value["ok"] = false }
        response.userInfo = [SFExtensionMessageKey: value]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private func connect(_ action: String, context: NSExtensionContext, attempts: Int) {
        guard let descriptor = try? RelayNativeDescriptor.read(),
              let url = URL(string: "http://127.0.0.1:\(descriptor.port)/\(action)") else {
            retry(action, context: context, attempts: attempts); return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data()
        request.setValue("0", forHTTPHeaderField: "Content-Length")
        request.setValue(descriptor.secret, forHTTPHeaderField: "X-SafAI-Native")
        request.timeoutInterval = 2
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.connectionProxyDictionary = [:]
        let delegate = NativeResponse { [self] data, response, error in
            if let error = error as? URLError, error.code == .cannotConnectToHost {
                // No TCP connection means no action was delivered. A stale descriptor
                // may remain briefly while the newly launched app starts its listener.
                retry(action, context: context, attempts: attempts); return
            }
            guard error == nil, let response, response.statusCode == 200,
                  response.url == url, let data, data.count <= 16384,
                  let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let accepted = envelope["accepted"] as? Bool, let value = envelope["state"] as? [String: Any] else {
                // Mutating actions are never replayed after an uncertain HTTP outcome.
                finish(context, value: ["error": "SafAI 中轉服務尚未就緒，請再試一次"]); return
            }
            // Explicit allowlist prevents future private broker fields crossing into JS.
            var result: [String: Any] = ["ok": accepted]
            for key in ["phase", "message", "revision", "providerURL", "error"] { if let value = value[key] { result[key] = value } }
            finish(context, value: result)
        }
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        session.dataTask(with: request).resume()
    }

    private func retry(_ action: String, context: NSExtensionContext, attempts: Int) {
        guard attempts > 0 else { finish(context, value: ["error": "無法連接 SafAI，請重新開啟 App"]); return }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { [self] in connect(action, context: context, attempts: attempts - 1) }
    }
}
