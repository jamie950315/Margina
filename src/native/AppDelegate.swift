import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private var broker: RelayLoginBroker?
    private var nativeIPC: RelayNativeIPC?
    private let login = RelayLoginWindow()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let menu = NSApp.mainMenu { Self.localizeMenu(menu) }
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

    private static func localizeMenu(_ menu: NSMenu) {
        let keys = ["About Margina": "aboutApp", "Hide Margina": "hideApp",
                    "Hide Others": "hideOthers", "Show All": "showAll",
                    "Quit Margina": "quitApp", "Help": "help", "Margina Help": "appHelp"]
        if let key = keys[menu.title] { menu.title = MarginaLocalization.text(key) }
        for item in menu.items {
            if let key = keys[item.title] { item.title = MarginaLocalization.text(key) }
            if let submenu = item.submenu { localizeMenu(submenu) }
        }
    }

    private static func showFailure() {
        let alert = NSAlert()
        alert.messageText = MarginaLocalization.text("appStartFailed")
        alert.informativeText = MarginaLocalization.text("appStartHelp")
        alert.runModal()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        relayQueue.sync { nativeIPC?.stop() }
    }
}
