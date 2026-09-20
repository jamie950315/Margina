import Foundation
import Security
import Darwin

enum SettingsVaultError: Error {
    case invalidSettings
    case storage(OSStatus)
    case lock
}

struct SettingsKeychainOperations {
    var copy: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var add: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var update: (CFDictionary, CFDictionary) -> OSStatus

    static let system = SettingsKeychainOperations(copy: SecItemCopyMatching,
                                                    add: SecItemAdd,
                                                    update: SecItemUpdate)
}

enum SettingsCodec {
    static let maximumBytes = 128 * 1024
    static let defaultContextWindowTokens = 262_144
    static let minimumContextWindowTokens = 8_192
    static let maximumContextWindowTokens = 2_097_152
    private static let stringLimits = [
        "mode": 16,
        "baseUrl": 16_384,
        "apiKey": 16_384,
        "model": 16_384,
        "quickPrompts": 26_000,
    ]
    private static let booleanKeys: Set<String> = [
        "includePage", "includeSelection", "stream", "selectionTools",
    ]
    private static let numericKeys: Set<String> = ["contextWindowTokens"]
    private static let allowedKeys = Set(stringLimits.keys).union(booleanKeys).union(numericKeys)

    static func encode(_ settings: [String: Any]) throws -> Data {
        guard Set(settings.keys) == allowedKeys else { throw SettingsVaultError.invalidSettings }
        for (key, limit) in stringLimits {
            guard let value = settings[key] as? String, value.utf16.count <= limit else {
                throw SettingsVaultError.invalidSettings
            }
        }
        guard let mode = settings["mode"] as? String, mode == "api" || mode == "chatgpt" else {
            throw SettingsVaultError.invalidSettings
        }
        guard let baseURL = settings["baseUrl"] as? String, !baseURL.isEmpty,
              let model = settings["model"] as? String, !model.isEmpty else {
            throw SettingsVaultError.invalidSettings
        }
        for key in booleanKeys {
            guard let value = settings[key] as? NSNumber,
                  CFGetTypeID(value) == CFBooleanGetTypeID() else {
                throw SettingsVaultError.invalidSettings
            }
        }
        guard let contextWindowTokens = settings["contextWindowTokens"] as? NSNumber,
              CFGetTypeID(contextWindowTokens) != CFBooleanGetTypeID(),
              contextWindowTokens.doubleValue.isFinite,
              contextWindowTokens.doubleValue.rounded() == contextWindowTokens.doubleValue,
              contextWindowTokens.int64Value >= Int64(minimumContextWindowTokens),
              contextWindowTokens.int64Value <= Int64(maximumContextWindowTokens) else {
            throw SettingsVaultError.invalidSettings
        }
        guard JSONSerialization.isValidJSONObject(settings) else { throw SettingsVaultError.invalidSettings }
        let data = try JSONSerialization.data(withJSONObject: settings, options: [.sortedKeys])
        guard !data.isEmpty, data.count <= maximumBytes else { throw SettingsVaultError.invalidSettings }
        return data
    }

    static func decode(_ data: Data) throws -> [String: Any] {
        guard !data.isEmpty, data.count <= maximumBytes,
              var settings = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SettingsVaultError.invalidSettings
        }
        let keys = Set(settings.keys)
        let legacyKeys = allowedKeys.subtracting(numericKeys)
        guard keys == allowedKeys || keys == legacyKeys else { throw SettingsVaultError.invalidSettings }
        if settings["contextWindowTokens"] == nil {
            settings["contextWindowTokens"] = defaultContextWindowTokens
        }
        _ = try encode(settings)
        return settings
    }
}

final class SettingsVault {
    private let service: String
    private let account: String
    private let operations: SettingsKeychainOperations
    private let lockURL: URL

    init(account: String,
         service: String = "dev.jamie.safai.settings",
         operations: SettingsKeychainOperations = .system,
         lockURL: URL? = nil) throws {
        guard !account.isEmpty, account.utf8.count <= 160 else { throw SettingsVaultError.invalidSettings }
        self.account = account
        self.service = service
        self.operations = operations
        if let lockURL {
            self.lockURL = lockURL
        } else {
            guard let container = FileManager.default.urls(for: .applicationSupportDirectory,
                                                            in: .userDomainMask).first else {
                throw SettingsVaultError.lock
            }
            let directory = container.appendingPathComponent("SafAI", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
            } catch { throw SettingsVaultError.lock }
            self.lockURL = directory.appendingPathComponent("settings.lock", isDirectory: false)
        }
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    private func withLock<T>(_ body: () throws -> T) throws -> T {
        let descriptor = open(lockURL.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else { throw SettingsVaultError.lock }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw SettingsVaultError.lock }
        defer { flock(descriptor, LOCK_UN) }
        return try body()
    }

    private func loadSettings() throws -> [String: Any]? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = operations.copy(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SettingsVaultError.storage(status) }
        guard let data = result as? Data else { throw SettingsVaultError.invalidSettings }
        return try SettingsCodec.decode(data)
    }

    func read() throws -> [String: Any]? {
        try withLock {
            return try loadSettings()
        }
    }

    func write(_ settings: [String: Any], expected: [String: Any]?) throws -> Bool {
        let next = try SettingsCodec.encode(settings)
        let expectedData = try expected.map(SettingsCodec.encode)
        return try withLock {
            let currentData = try loadSettings().map(SettingsCodec.encode)
            guard currentData == expectedData else { return false }
            let attributes: [String: Any] = [
                kSecValueData as String: next,
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ]
            var status = operations.update(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                let item = query.merging(attributes) { _, new in new }
                status = operations.add(item as CFDictionary, nil)
            }
            guard status == errSecSuccess else { throw SettingsVaultError.storage(status) }
            return true
        }
    }
}
