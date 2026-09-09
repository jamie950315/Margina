import Foundation

private final class SyntheticPersistence: RelaySessionPersistence {
    static var cookie: HTTPCookie {
        HTTPCookie(properties: [.name: "__Secure-next-auth.session-token", .value: "synthetic-persistence-fixture",
            .domain: ".chatgpt.com", .path: "/", .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE",
            .expires: Date(timeIntervalSinceNow: 3600)])!
    }
    var saved: [HTTPCookie]? = [SyntheticPersistence.cookie]
    var saveFails = false
    var clearFails = false
    var saves = 0
    var clears = 0
    var loads = 0
    func load() throws -> [HTTPCookie]? { loads += 1; return saved }
    func save(_ cookies: [HTTPCookie]) throws {
        saves += 1
        if saveFails { throw RelaySessionVaultError.invalidRecord }
        saved = cookies
    }
    func clear() throws {
        clears += 1
        if clearFails { throw RelaySessionVaultError.invalidRecord }
        saved = nil
    }
}

@main struct PersistenceServer {
    static func main() throws {
        guard CommandLine.arguments.count == 3, let origin = URL(string: CommandLine.arguments[1]),
              origin.scheme == "http", origin.host == "127.0.0.1" else { exit(1) }
        let persistence = SyntheticPersistence()
        let broker = try RelayLoginBroker(mainOrigin: origin, resources: URL(fileURLWithPath: CommandLine.arguments[2]), persistence: persistence)
        let output = FileHandle(fileDescriptor: 3)
        func emit(_ value: [String: Any]) {
            guard let data = try? JSONSerialization.data(withJSONObject: value) else { exit(2) }
            output.write(data + Data("\n".utf8))
        }
        broker.presenter = { presentation in
            presentation.opened()
            presentation.candidate([SyntheticPersistence.cookie]) { _ in }
        }
        broker.onReady = { emit(["ready": true]) }
        var buffered = Data()
        FileHandle.standardInput.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { exit(0) }
            relayQueue.async {
                buffered.append(data)
                while let end = buffered.firstIndex(of: 10) {
                    let line = buffered.prefix(upTo: end); buffered.removeSubrange(...end)
                    guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                          let action = request["action"] as? String, let id = request["id"] as? Int else { exit(3) }
                    if let value = request["saveFails"] as? Bool { persistence.saveFails = value }
                    if let value = request["clearFails"] as? Bool { persistence.clearFails = value }
                    if action == "shutdown" { broker.shutdown(); broker.shutdown() }
                    if action == "refresh" { broker.refreshPersistedSession() }
                    var reply = broker.nativeCommand(action)
                    reply["id"] = id
                    reply["saves"] = persistence.saves; reply["clears"] = persistence.clears
                    reply["loads"] = persistence.loads; reply["saved"] = persistence.saved != nil
                    emit(reply)
                }
            }
        }
        try broker.start()
        withExtendedLifetime(broker) { dispatchMain() }
    }
}
