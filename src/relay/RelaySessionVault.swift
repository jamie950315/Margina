import Foundation
import Security

protocol RelaySessionPersistence {
    func load() throws -> [HTTPCookie]?
    func save(_ cookies: [HTTPCookie]) throws
    func clear() throws
}

enum RelaySessionVaultError: Error, LocalizedError {
    case invalidRecord
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidRecord: return MarginaLocalization.text("invalidRecord")
        case .keychain: return MarginaLocalization.text("keychainUnavailable")
        }
    }
}

// This codec has no filesystem or Keychain side effects. Its sole output is the
// minimum session-cookie envelope, never the complete browser cookie store.
enum RelaySessionCodec {
    static let maximumBytes = 192 * 1024
    private struct Record: Codable {
        let version: Int
        let cookies: [Cookie]
    }
    private struct Cookie: Codable {
        let name: String
        let value: String
        let domain: String
        let path: String
        let secure: Bool
        let httpOnly: Bool
        let expires: Date?
    }

    private static func validated(_ cookies: [HTTPCookie], now: Date) throws -> [HTTPCookie] {
        guard !cookies.isEmpty, cookies.count <= 8 else { throw RelaySessionVaultError.invalidRecord }
        do {
            let selected = try RelayLoginPolicy.sessionCookies(from: cookies, now: now)
            // Login selection ignores unrelated/expired cookies. A stored record
            // must instead be entirely valid; never silently load a partial token.
            guard selected.count == cookies.count else { throw RelaySessionVaultError.invalidRecord }
            return selected
        } catch { throw RelaySessionVaultError.invalidRecord }
    }

    static func encode(_ cookies: [HTTPCookie], now: Date = Date()) throws -> Data {
        let selected = try validated(cookies, now: now)
        let record = Record(version: 1, cookies: selected.map {
            Cookie(name: $0.name, value: $0.value, domain: $0.domain, path: $0.path,
                   secure: $0.isSecure, httpOnly: $0.isHTTPOnly, expires: $0.expiresDate)
        })
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(record)
            guard data.count <= maximumBytes else { throw RelaySessionVaultError.invalidRecord }
            return data
        } catch { throw RelaySessionVaultError.invalidRecord }
    }

    static func decode(_ data: Data, now: Date = Date()) throws -> [HTTPCookie] {
        guard !data.isEmpty, data.count <= maximumBytes else { throw RelaySessionVaultError.invalidRecord }
        do {
            let record = try JSONDecoder().decode(Record.self, from: data)
            guard record.version == 1, !record.cookies.isEmpty, record.cookies.count <= 8 else {
                throw RelaySessionVaultError.invalidRecord
            }
            let cookies: [HTTPCookie] = try record.cookies.map { cookie in
                guard cookie.name.utf8.count <= 128, cookie.value.utf8.count <= 16_384,
                      cookie.domain == "chatgpt.com" || cookie.domain == ".chatgpt.com",
                      cookie.path == "/", cookie.secure, cookie.httpOnly else {
                    throw RelaySessionVaultError.invalidRecord
                }
                var properties: [HTTPCookiePropertyKey: Any] = [
                    .name: cookie.name, .value: cookie.value, .domain: cookie.domain,
                    .path: cookie.path, .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE",
                ]
                if let expiry = cookie.expires { properties[.expires] = expiry }
                guard let result = HTTPCookie(properties: properties) else { throw RelaySessionVaultError.invalidRecord }
                return result
            }
            return try validated(cookies, now: now)
        } catch { throw RelaySessionVaultError.invalidRecord }
    }
}

// Injection is only for synthetic unit tests. Production uses the macOS login
// Keychain, whose ACL and lock protect access. Keep the owner's signing identity
// stable across upgrades. There is no cloud synchronization or plaintext fallback.
struct RelayKeychainOperations {
    var copy: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var add: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var update: (CFDictionary, CFDictionary) -> OSStatus
    var delete: (CFDictionary) -> OSStatus

    static let system = RelayKeychainOperations(copy: SecItemCopyMatching, add: SecItemAdd,
                                               update: SecItemUpdate, delete: SecItemDelete)
}

// Only a revocation boolean lives in preferences, never cookies or account data.
// It prevents a denied Keychain deletion from reviving a logged-out session after
// restart. A new explicitly completed login can clear it after a successful save.
struct RelaySessionRevocationStore {
    var read: () -> Bool
    var write: (Bool) throws -> Void

    static func standard(service: String, account: String) -> Self {
        let key = "SafAI.sessionRevoked." + service + "." + account
        return Self(read: { UserDefaults.standard.bool(forKey: key) }, write: { revoked in
            UserDefaults.standard.set(revoked, forKey: key)
            guard UserDefaults.standard.synchronize() else { throw RelaySessionVaultError.invalidRecord }
        })
    }
}

final class RelaySessionVault: RelaySessionPersistence {
    private let service: String
    private let account: String
    private let operations: RelayKeychainOperations
    private let revocation: RelaySessionRevocationStore
    private let lock = NSLock()

    init(service: String = "dev.jamie.safai.chatgpt-session", account: String = "primary",
         operations: RelayKeychainOperations = .system, revocation: RelaySessionRevocationStore? = nil) {
        self.service = service
        self.account = account
        self.operations = operations
        self.revocation = revocation ?? .standard(service: service, account: account)
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    func load() throws -> [HTTPCookie]? {
        lock.lock(); defer { lock.unlock() }
        guard !revocation.read() else { return nil }
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = operations.copy(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw RelaySessionVaultError.keychain(status) }
        guard let data = result as? Data else { throw RelaySessionVaultError.invalidRecord }
        return try RelaySessionCodec.decode(data)
    }

    func save(_ cookies: [HTTPCookie]) throws {
        let data = try RelaySessionCodec.encode(cookies)
        lock.lock(); defer { lock.unlock() }
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = operations.update(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let item = query.merging(attributes) { _, new in new }
            status = operations.add(item as CFDictionary, nil)
            // Another instance may have created the item between update/add.
            if status == errSecDuplicateItem {
                status = operations.update(query as CFDictionary, attributes as CFDictionary)
            }
        }
        guard status == errSecSuccess else { throw RelaySessionVaultError.keychain(status) }
        try revocation.write(false)
    }

    func clear() throws {
        lock.lock(); defer { lock.unlock() }
        try revocation.write(true)
        let status = operations.delete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw RelaySessionVaultError.keychain(status)
        }
    }
}
