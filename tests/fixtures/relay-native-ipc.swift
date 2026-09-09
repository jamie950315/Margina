import Foundation
import Darwin

// All credentials and persistence here are synthetic and memory-only.
final class IPCMemorySession: RelaySessionPersistence {
    private var cookies: [HTTPCookie]?
    func load() throws -> [HTTPCookie]? { cookies }
    func save(_ value: [HTTPCookie]) throws { cookies = value }
    func clear() throws { cookies = nil }
}

@main
struct NativeIPCFixture {
    static func main() {
        do { try run() } catch { exit(2) }
    }
    static func run() throws {
        guard CommandLine.arguments.count == 5,
              let origin = URL(string: CommandLine.arguments[1]), origin.scheme == "http", origin.host == "127.0.0.1" else { exit(1) }
        let descriptor = URL(fileURLWithPath: CommandLine.arguments[3])
        let broker = try RelayLoginBroker(mainOrigin: origin, resources: URL(fileURLWithPath: CommandLine.arguments[2]), persistence: IPCMemorySession())
        let ipc = try RelayNativeIPC(broker: broker, testingDescriptorURL: descriptor)
        if CommandLine.arguments[4] == "oversized" {
            ipc.testingCommand = { _ in ["accepted": true, "state": ["message": String(repeating: "x", count: 16385)]] }
        }
        broker.presenter = { presentation in
            presentation.opened()
            let cookie = HTTPCookie(properties: [.name: "__Secure-next-auth.session-token", .value: "synthetic-native-ipc-session", .domain: ".chatgpt.com", .path: "/", .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE", .expires: Date(timeIntervalSinceNow: 3600)])!
            presentation.candidate([cookie]) { _ in }
        }
        ipc.testingReady = {
            // The parent reads only its private temporary descriptor after this signal.
            FileHandle(fileDescriptor: 3).write(Data("ready\n".utf8))
        }
        ipc.failed = { exit(2) }
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: relayQueue)
        termination.setEventHandler { ipc.stop(); exit(0) }
        termination.resume()
        try broker.start()
        try ipc.start()
        withExtendedLifetime((broker, ipc, termination)) { dispatchMain() }
    }
}
