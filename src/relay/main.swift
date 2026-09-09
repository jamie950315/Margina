import Foundation
#if !RELAY_TESTING
import AppKit
#endif

var upstream = URL(string: "https://chatgpt.com")!
var resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
var openLogin = false
var arguments = Array(CommandLine.arguments.dropFirst())
while !arguments.isEmpty {
    let flag = arguments.removeFirst()
    if flag == "--resources", !arguments.isEmpty {
        resources = URL(fileURLWithPath: arguments.removeFirst(), isDirectory: true)
    } else if flag == "--open-login" {
        openLogin = true
    } else {
        #if RELAY_TESTING
        if flag == "--test-origin", !arguments.isEmpty,
           let url = URL(string: arguments.removeFirst()), url.scheme == "http", url.host == "127.0.0.1", url.port != nil, url.user == nil, url.password == nil {
            upstream = url
            continue
        }
        #endif
        FileHandle.standardError.write(Data("Unknown or invalid relay argument\n".utf8))
        exit(1)
    }
}
do {
    let broker = try RelayLoginBroker(mainOrigin: upstream, resources: resources)
    #if RELAY_TESTING
    // Native HTTP tests exercise control isolation without creating a real login window.
    broker.presenter = { presentation in presentation.opened() }
    broker.onReady = {
        if let url = try? broker.controlLaunchURL(), let data = try? JSONSerialization.data(withJSONObject: ["launchURL": url.absoluteString]) {
            // Private test pipe only. The production binary has no token-export flag.
            FileHandle(fileDescriptor: 3).write(data + Data("\n".utf8))
        }
    }
    try broker.start()
    withExtendedLifetime(broker) { dispatchMain() }
    #else
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    relayInstallApplicationMenu()
    let login = RelayLoginWindow()
    let actions = RelayApplicationActions(broker: broker)
    broker.phaseChanged = { phase in
        // A bounded enum only: no account identity, cookies, keys, URLs or messages.
        if let data = try? JSONSerialization.data(withJSONObject: ["event": "loginStateChanged", "phase": phase.rawValue]) {
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        }
    }
    broker.willExitForIdle = { FileHandle.standardOutput.write(Data("{\"event\":\"anonymousIdleExit\"}\n".utf8)) }
    login.pageVisible = { FileHandle.standardOutput.write(Data("{\"event\":\"officialLoginPageVisible\"}\n".utf8)) }
    broker.presenter = { presentation in DispatchQueue.main.async { login.present(presentation) } }
    broker.dismissLogin = { DispatchQueue.main.async { login.dismiss() } }
    login.returned = { actions.openControl() }
    broker.onReady = { DispatchQueue.main.async { if openLogin { actions.openLogin() } else { actions.openControl() } } }
    try broker.start()
    withExtendedLifetime((broker, login, actions)) { app.run() }
    #endif
} catch {
    FileHandle.standardError.write(Data("Unable to start local relay\n".utf8))
    exit(1)
}
