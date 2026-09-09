import AppKit
import WebKit

private final class RelayInputBlocker: NSView {
    override var acceptsFirstResponder: Bool { true }
    override func mouseDown(with event: NSEvent) { }
    override func keyDown(with event: NSEvent) { }
    override func scrollWheel(with event: NSEvent) { }
}

// Real HTTPS pages run here, not through the loopback relay. The view has no
// injected scripts or native message handlers, and never uses Safari's data store.
final class RelayLoginWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var presentation: RelayLoginPresentation?
    private var window: NSWindow?
    private var webView: WKWebView?
    private var store: WKWebsiteDataStore?
    private var popups: [ObjectIdentifier: NSWindow] = [:]
    private var originLabel: NSTextField?
    private var statusLabel: NSTextField?
    private var doneButton: NSButton?
    private var blocker: RelayInputBlocker?
    private var checking = false
    private var closing = false
    private var reportedPage = false
    var returned: (() -> Void)?
    var pageVisible: (() -> Void)?

    func present(_ presentation: RelayLoginPresentation) {
        dispatchPrecondition(condition: .onQueue(.main))
        dismiss(notify: true)
        self.presentation = presentation
        reportedPage = false
        let store = WKWebsiteDataStore.nonPersistent()
        self.store = store
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        self.webView = view
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 940, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "SafAI — 官方登入（隔離工作階段）"
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 660, height: 580)
        window.delegate = self
        self.window = window
        let content = NSView()
        window.contentView = content
        let origin = NSTextField(labelWithString: "正在連線至 https://chatgpt.com")
        origin.font = .systemFont(ofSize: 14, weight: .semibold)
        origin.isSelectable = true
        originLabel = origin
        let notice = NSTextField(wrappingLabelWithString: "密碼只在下方官方 HTTPS 網頁輸入，不會送到本機網址。此測試登入只保留到中轉程式關閉。")
        notice.font = .systemFont(ofSize: 12)
        notice.textColor = .secondaryLabelColor
        let status = NSTextField(wrappingLabelWithString: "請在官方網頁完成登入，再按右下方按鈕。這不會傳送任何對話。")
        status.font = .systemFont(ofSize: 12)
        statusLabel = status
        let cancel = NSButton(title: "取消", target: self, action: #selector(cancelLogin))
        cancel.bezelStyle = .rounded
        let done = NSButton(title: "完成登入並返回", target: self, action: #selector(completeLogin))
        done.bezelStyle = .rounded
        done.isEnabled = false
        // No Return key equivalent: Enter in the webpage must submit its own login form.
        doneButton = done
        let blocker = RelayInputBlocker()
        blocker.isHidden = true
        self.blocker = blocker
        for element in [origin, notice, view, status, cancel, done, blocker] {
            element.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(element)
        }
        NSLayoutConstraint.activate([
            origin.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            origin.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            origin.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            notice.topAnchor.constraint(equalTo: origin.bottomAnchor, constant: 6),
            notice.leadingAnchor.constraint(equalTo: origin.leadingAnchor),
            notice.trailingAnchor.constraint(equalTo: origin.trailingAnchor),
            view.topAnchor.constraint(equalTo: notice.bottomAnchor, constant: 14),
            view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            view.bottomAnchor.constraint(equalTo: status.topAnchor, constant: -14),
            status.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            status.trailingAnchor.constraint(equalTo: cancel.leadingAnchor, constant: -16),
            status.centerYAnchor.constraint(equalTo: done.centerYAnchor),
            status.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
            done.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            done.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -14),
            cancel.trailingAnchor.constraint(equalTo: done.leadingAnchor, constant: -10),
            cancel.centerYAnchor.constraint(equalTo: done.centerYAnchor),
            blocker.topAnchor.constraint(equalTo: view.topAnchor),
            blocker.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            blocker.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            blocker.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        presentation.opened()
        view.load(URLRequest(url: URL(string: "https://chatgpt.com/auth/login")!))
    }

    @objc private func cancelLogin() { dismiss(notify: true) }

    func dismiss(notify: Bool = true) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !closing else { return }
        closing = true
        let previous = presentation
        presentation = nil
        webView?.stopLoading()
        for popup in Array(popups.values) { popup.close() }
        popups.removeAll()
        window?.close()
        window = nil; webView = nil; store = nil
        originLabel = nil; statusLabel = nil; doneButton = nil; blocker = nil
        checking = false; closing = false
        if notify { previous?.cancelled() }
    }

    func windowWillClose(_ notification: Notification) {
        guard let closingWindow = notification.object as? NSWindow else { return }
        if closingWindow === window {
            if !closing { dismiss(notify: true) }
        } else {
            popups = popups.filter { $0.value !== closingWindow }
        }
    }

    @objc private func completeLogin() {
        guard !checking, let view = webView, let presentation, let store,
              RelayLoginPolicy.isChatGPTOrigin(view.url) else {
            statusLabel?.stringValue = "請先在官方網頁完成登入，並回到 chatgpt.com。"
            return
        }
        checking = true
        for popup in Array(popups.values) { popup.close() }
        webView?.stopLoading()
        doneButton?.isEnabled = false
        blocker?.isHidden = false
        window?.makeFirstResponder(blocker)
        statusLabel?.stringValue = "正在確認登入；網頁操作暫停，沒有傳送對話。"
        // The isolated world uses an unmodified fetch implementation. Only a boolean
        // leaves the page; account data and access tokens do not enter the native UI.
        let script = """
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch('/api/auth/session', {cache:'no-store',credentials:'include',signal:controller.signal,redirect:'error'});
          if (!response.ok) return false;
          const session = await response.json();
          return typeof session?.accessToken === 'string' && session.accessToken.length > 0 && typeof session?.user?.id === 'string' && session.user.id.length > 0;
        } finally { clearTimeout(timer); }
        """
        Task { @MainActor [weak self] in
            let value = try? await view.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .defaultClient)
            guard let self, self.presentation?.attempt == presentation.attempt, self.checking,
                  self.webView === view, RelayLoginPolicy.isChatGPTOrigin(view.url) else { return }
            guard value as? Bool == true else {
                self.resumeAfterUnconfirmedLogin("尚未確認官方登入。請完成登入後再按一次；若官方要求驗證，請由你親自操作。")
                return
            }
            let cookies: [HTTPCookie]
            if #available(macOS 27.0, *) {
                cookies = await store.httpCookieStore.cookies(for: URL(string: "https://chatgpt.com/api/auth/session")!)
            } else {
                // This is only the newly created, app-owned nonpersistent store.
                cookies = await store.httpCookieStore.allCookies()
            }
            guard self.presentation?.attempt == presentation.attempt, self.checking else { return }
            do {
                let accepted = try RelayLoginPolicy.sessionCookies(from: cookies)
                self.statusLabel?.stringValue = "官方頁面已確認登入，正在獨立確認中轉連線。"
                presentation.candidate(accepted) { [weak self] valid in
                    DispatchQueue.main.async {
                        guard let self, self.presentation?.attempt == presentation.attempt else { return }
                        if valid { self.dismiss(notify: false); self.returned?() }
                        else {
                            self.statusLabel?.stringValue = "官方登入已完成，但中轉未能確認這次登入。未自動重試；請按取消後回報此狀態。"
                            // Keep Done disabled: a failed transport must not silently retry.
                        }
                    }
                }
            } catch {
                self.resumeAfterUnconfirmedLogin("這次登入資料的格式尚未支援；未複製其他 Cookie 或驗證資料。請取消並回報此狀態。")
            }
        }
    }

    private func resumeAfterUnconfirmedLogin(_ message: String) {
        checking = false
        blocker?.isHidden = true
        statusLabel?.stringValue = message
        doneButton?.isEnabled = RelayLoginPolicy.isChatGPTOrigin(webView?.url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard !checking, !navigationAction.shouldPerformDownload, let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.targetFrame?.isMainFrame == false {
            // The official page's own CSP governs its HTTPS verification subframes.
            let https = url.scheme == "https" && url.user == nil && url.password == nil && (url.port == nil || url.port == 443)
            decisionHandler(https ? .allow : .cancel)
            return
        }
        guard RelayLoginPolicy.allowsNavigation(url) else {
            statusLabel?.stringValue = "已停止前往未核准的登入來源、下載或外部 App；沒有略過任何安全提示。"
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.canShowMIMEType, let url = navigationResponse.response.url else { decisionHandler(.cancel); return }
        if let response = navigationResponse.response as? HTTPURLResponse,
           response.value(forHTTPHeaderField: "Content-Disposition")?.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment") == true { decisionHandler(.cancel); return }
        let allowed = navigationResponse.isForMainFrame ? RelayLoginPolicy.allowsNavigation(url) : url.scheme == "https" && url.user == nil && url.password == nil && (url.port == nil || url.port == 443)
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === self.webView { originLabel?.stringValue = "正在確認官方 HTTPS 連線…"; doneButton?.isEnabled = false }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if webView === self.webView, RelayLoginPolicy.allowsNavigation(webView.url), let host = webView.url?.host {
            originLabel?.stringValue = "官方網址  ·  https://\(host)"
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === self.webView {
            doneButton?.isEnabled = !checking && RelayLoginPolicy.isChatGPTOrigin(webView.url)
            if !reportedPage, window?.isVisible == true, RelayLoginPolicy.allowsNavigation(webView.url) {
                reportedPage = true; pageVisible?()
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled {
            statusLabel?.stringValue = "官方網頁連線未完成；沒有略過憑證或其他安全檢查。"
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard !checking, popups.count < 1, RelayLoginPolicy.allowsNavigation(navigationAction.request.url), let store else { return nil }
        configuration.websiteDataStore = store
        let popupView = WKWebView(frame: .zero, configuration: configuration)
        popupView.navigationDelegate = self; popupView.uiDelegate = self
        let popup = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 700), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        popup.title = "SafAI — 官方登入服務：\(navigationAction.request.url?.host ?? "")"
        popup.isReleasedWhenClosed = false; popup.delegate = self; popup.contentView = popupView
        popups[ObjectIdentifier(popupView)] = popup
        popup.center(); popup.makeKeyAndOrderFront(nil)
        return popupView
    }

    func webViewDidClose(_ webView: WKWebView) { popups[ObjectIdentifier(webView)]?.close() }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        statusLabel?.stringValue = "此視窗只用於登入，不接受檔案上傳。"
        completionHandler(nil)
    }
}

final class RelayApplicationActions: NSObject {
    let broker: RelayLoginBroker
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

    init(broker: RelayLoginBroker) {
        self.broker = broker
        super.init()
        item.button?.title = "SafAI 中轉測試"
        let menu = NSMenu()
        let open = menu.addItem(withTitle: "開啟中轉控制頁", action: #selector(openControl), keyEquivalent: "")
        open.target = self
        let login = menu.addItem(withTitle: "開啟官方登入", action: #selector(openLogin), keyEquivalent: "")
        login.target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "結束中轉測試", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
    }

    @objc func openControl() {
        relayQueue.async { [weak self] in
            guard let self, let url = try? self.broker.controlLaunchURL() else { return }
            DispatchQueue.main.async {
                guard let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") else { return }
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                // Use native IPC, not a shell command or a logged URL.
                NSWorkspace.shared.open([url], withApplicationAt: safari, configuration: configuration) { _, _ in }
            }
        }
    }

    @objc func openLogin() { relayQueue.async { [weak self] in self?.broker.beginLogin() } }
}

func relayInstallApplicationMenu() {
    let menu = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "結束中轉測試", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu; menu.addItem(appItem)
    let editItem = NSMenuItem(title: "編輯", action: nil, keyEquivalent: "")
    let edit = NSMenu(title: "編輯")
    for (title, action, key) in [("剪下", "cut:", "x"), ("複製", "copy:", "c"), ("貼上", "paste:", "v"), ("全選", "selectAll:", "a")] {
        edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
    }
    editItem.submenu = edit; menu.addItem(editItem)
    NSApp.mainMenu = menu
}
