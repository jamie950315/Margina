import Foundation

@main
struct SyntheticLoginServer {
    static func main() throws {
        guard CommandLine.arguments.count == 3,
              let origin = URL(string: CommandLine.arguments[1]), origin.scheme == "http", origin.host == "127.0.0.1" else { exit(1) }
        let broker = try RelayLoginBroker(mainOrigin: origin, resources: URL(fileURLWithPath: CommandLine.arguments[2]))
        broker.phaseChanged = { phase in
            if let data = try? JSONSerialization.data(withJSONObject: ["event": "loginStateChanged", "phase": phase.rawValue]) {
                FileHandle.standardOutput.write(data + Data("\n".utf8))
            }
        }
        broker.presenter = { presentation in
            presentation.opened()
            let cookie = HTTPCookie(properties: [.name: "__Secure-next-auth.session-token", .value: "synthetic-login-fixture", .domain: ".chatgpt.com", .path: "/", .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE", .expires: Date(timeIntervalSinceNow: 3600)])!
            presentation.candidate([cookie]) { _ in }
        }
        broker.onReady = {
            if let url = try? broker.controlLaunchURL(), let data = try? JSONSerialization.data(withJSONObject: ["launchURL": url.absoluteString]) {
                FileHandle(fileDescriptor: 3).write(data + Data("\n".utf8))
            }
        }
        try broker.start()
        withExtendedLifetime(broker) { dispatchMain() }
    }
}
