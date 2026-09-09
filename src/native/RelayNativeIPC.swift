import Foundation
import Darwin

enum RelayNativeError: Error { case unavailable }

// This capability never crosses the Safari native-message boundary.
struct RelayNativeDescriptor: Codable {
    let version: Int
    let port: UInt16
    let secret: String

    static func location() throws -> URL {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "SafAIAppGroup") as? String,
              !group.isEmpty, !group.contains("$("),
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw RelayNativeError.unavailable
        }
        let directory = container.appendingPathComponent("SafAIRelay", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0 else { throw RelayNativeError.unavailable }
        return directory.appendingPathComponent("native.json")
    }

    static func read() throws -> Self {
        try read(at: location())
    }

    private static func read(at url: URL) throws -> Self {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0,
              ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= 4096 else { throw RelayNativeError.unavailable }
        let value = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        guard value.version == 1, value.port > 0, value.secret.count == 64,
              value.secret.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { throw RelayNativeError.unavailable }
        return value
    }

    func write() throws {
        try write(to: Self.location())
    }

    private func write(to destination: URL) throws {
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".tmp")
        let data = try JSONEncoder().encode(self)
        guard FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw RelayNativeError.unavailable }
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard rename(temporary.path, destination.path) == 0 else { throw RelayNativeError.unavailable }
    }

    #if RELAY_TESTING
    func testingWrite(to destination: URL) throws { try write(to: destination) }
    static func testingRead(at url: URL) throws -> Self { try read(at: url) }
    #endif
}

#if !SAFAI_EXTENSION
import Network

final class RelayNativeIPC {
    private let broker: RelayLoginBroker
    private let secret: String
    private var listener: NWListener?
    private var clients: [UUID: NWConnection] = [:]
    private var port: UInt16 = 0
    private var ownershipFD: Int32 = -1
    var failed: (() -> Void)?
    #if RELAY_TESTING
    private var testingDescriptorURL: URL?
    var testingReady: (() -> Void)?
    var testingCommand: ((String) -> [String: Any])?

    // Synthetic test executables only. No production path/descriptor override exists.
    init(broker: RelayLoginBroker, testingDescriptorURL: URL) throws {
        self.broker = broker
        self.testingDescriptorURL = testingDescriptorURL
        secret = try relayRandomKey()
        ownershipFD = try Self.acquireOwnership(beside: testingDescriptorURL)
    }
    #endif

    init(broker: RelayLoginBroker) throws {
        self.broker = broker
        secret = try relayRandomKey()
        ownershipFD = try Self.acquireOwnership(beside: RelayNativeDescriptor.location())
    }

    // One group has one broker/Keychain writer even when another app copy is
    // launched. Never unlink this file: replacing its inode defeats flock.
    private static func acquireOwnership(beside descriptor: URL) throws -> Int32 {
        let path = descriptor.deletingLastPathComponent().appendingPathComponent("native.lock").path
        let fd = Darwin.open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw RelayNativeError.unavailable }
        var metadata = stat()
        guard fstat(fd, &metadata) == 0,
              metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              metadata.st_uid == getuid(), metadata.st_nlink == 1,
              metadata.st_mode & mode_t(0o777) == mode_t(0o600), metadata.st_size == 0,
              flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(fd)
            throw RelayNativeError.unavailable
        }
        return fd
    }

    private func releaseOwnership() {
        guard ownershipFD >= 0 else { return }
        flock(ownershipFD, LOCK_UN)
        Darwin.close(ownershipFD)
        ownershipFD = -1
    }

    deinit {
        // Deinitialization can happen off the broker queue. Keep ownership until
        // that queue has permanently disabled its final persistence writer.
        let fd = ownershipFD
        if fd >= 0 {
            let owner = broker
            relayQueue.async {
                owner.shutdown()
                flock(fd, LOCK_UN)
                Darwin.close(fd)
            }
        }
    }

    func start() throws {
        guard ownershipFD >= 0, listener == nil else { throw RelayNativeError.unavailable }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let server = try NWListener(using: parameters)
        listener = server
        server.stateUpdateHandler = { [weak self] state in
            guard let self, self.listener === server, self.ownershipFD >= 0 else { return }
            if case .ready = state, let port = server.port?.rawValue {
                self.port = port
                do {
                    let descriptor = RelayNativeDescriptor(version: 1, port: port, secret: self.secret)
                    #if RELAY_TESTING
                    if let url = self.testingDescriptorURL { try descriptor.testingWrite(to: url) }
                    else { try descriptor.write() }
                    self.testingReady?()
                    #else
                    try descriptor.write()
                    #endif
                }
                catch { self.stop(); self.failed?() }
            } else if case .failed = state { self.stop(); self.failed?() }
        }
        server.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        server.start(queue: relayQueue)
    }

    func stop() {
        broker.shutdown()
        defer { releaseOwnership() }
        listener?.cancel(); listener = nil
        for connection in clients.values { connection.cancel() }
        clients.removeAll()
        #if RELAY_TESTING
        if let url = testingDescriptorURL {
            if let current = try? RelayNativeDescriptor.testingRead(at: url), current.secret == secret { try? FileManager.default.removeItem(at: url) }
            return
        }
        #endif
        if let current = try? RelayNativeDescriptor.read(), current.secret == secret,
           let url = try? RelayNativeDescriptor.location() { try? FileManager.default.removeItem(at: url) }
    }

    private func accept(_ connection: NWConnection) {
        guard listener != nil, ownershipFD >= 0, clients.count < 16 else { connection.cancel(); return }
        let id = UUID()
        clients[id] = connection
        connection.start(queue: relayQueue)
        relayQueue.asyncAfter(deadline: .now() + 5) { [weak self] in self?.close(id) }
        receive(connection, id: id, data: Data())
    }

    private func close(_ id: UUID) { clients.removeValue(forKey: id)?.cancel() }

    private func receive(_ connection: NWConnection, id: UUID, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] bytes, _, complete, error in
            guard let self, self.clients[id] != nil else { return }
            var data = data
            if let bytes { data.append(bytes) }
            guard data.count <= 4096, error == nil else { self.close(id); return }
            if let boundary = data.range(of: Data("\r\n\r\n".utf8)) {
                guard boundary.upperBound == data.endIndex,
                      let header = String(data: data[..<boundary.lowerBound], encoding: .utf8) else { self.close(id); return }
                self.handle(header, connection: connection, id: id)
            } else if complete { self.close(id) }
            else { self.receive(connection, id: id, data: data) }
        }
    }

    private func handle(_ header: String, connection: NWConnection, id: UUID) {
        let lines = header.components(separatedBy: "\r\n")
        let request = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false)
        guard request.count == 3, request[0] == "POST", request[2] == "HTTP/1.1" else { close(id); return }
        var fields: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { close(id); return }
            let name = line[..<colon].lowercased()
            guard fields[name] == nil else { close(id); return }
            fields[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let action = String(request[1].dropFirst())
        guard request[1] == "/" + action, ["status", "login", "logout", "switch", "reconnect"].contains(action),
              fields["host"] == "127.0.0.1:\(port)", fields["origin"] == nil,
              fields["transfer-encoding"] == nil, fields["content-length"] == "0",
              relayConstantTimeEqual(fields["x-safai-native"] ?? "", secret) else { close(id); return }
        #if RELAY_TESTING
        let result = testingCommand?(action) ?? broker.nativeCommand(action)
        #else
        let result = broker.nativeCommand(action)
        #endif
        guard let body = try? JSONSerialization.data(withJSONObject: result), body.count <= 16384 else { close(id); return }
        var response = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: \(body.count)\r\n\r\n".utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { [weak self] _ in self?.close(id) })
    }
}
#endif
