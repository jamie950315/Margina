import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private var broker: RelayLoginBroker?
    private var nativeIPC: RelayNativeIPC?
    private let login = RelayLoginWindow()

    func applicationDidFinishLaunching(_ notification: Notification) {
        login.persistsSession = true
        do {
            guard let resources = Bundle.main.resourceURL?.appendingPathComponent("Relay", isDirectory: true) else { throw RelayNativeError.unavailable }
            let broker = try RelayLoginBroker(mainOrigin: URL(string: "https://chatgpt.com")!, resources: resources, persistence: RelaySessionVault())
            let ipc = try RelayNativeIPC(broker: broker)
            broker.presenter = { [weak self] presentation in DispatchQueue.main.async { self?.login.present(presentation) } }
            broker.dismissLogin = { [weak self] in DispatchQueue.main.async { self?.login.dismiss() } }
            login.returned = {
                guard let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") else { return }
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                NSWorkspace.shared.openApplication(at: safari, configuration: configuration) { _, _ in }
            }
            ipc.failed = { DispatchQueue.main.async { Self.showFailure() } }
            self.broker = broker; self.nativeIPC = ipc
            relayQueue.async {
                do { try broker.start(); try ipc.start() }
                catch { ipc.stop(); DispatchQueue.main.async { Self.showFailure() } }
            }
        } catch { Self.showFailure() }
    }

    private static func showFailure() {
        let alert = NSAlert()
        alert.messageText = "無法啟動 Margina 中轉服務"
        alert.informativeText = "請確認 App 完整安裝且簽章有效，再重新開啟 Margina。登入資料不會因此刪除。"
        alert.runModal()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        relayQueue.sync { nativeIPC?.stop() }
    }
}
