import Foundation
import Security

private func settings(model: String = "synthetic-model") -> [String: Any] {
    ["mode": "api", "baseUrl": "https://synthetic.invalid/v1", "apiKey": "synthetic-key",
     "model": model, "includePage": true, "includeSelection": true, "stream": true,
     "selectionTools": true, "quickPrompts": "", "contextWindowTokens": 262_144]
}

private func rejects(_ operation: () throws -> Void) {
    do { try operation(); fatalError("expected rejection") } catch {}
}

private func query(service: String, account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
     kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false]
}

private func memoryChecks(lockURL: URL) throws {
    var records: [String: Data] = [:]
    var denied = false
    func validate(_ dictionary: CFDictionary) -> ([String: Any], String) {
        let value = dictionary as! [String: Any]
        precondition(value[kSecAttrService as String] as? String == "synthetic.settings")
        precondition(value[kSecAttrSynchronizable as String] as? Bool == false)
        return (value, value[kSecAttrAccount as String] as! String)
    }
    let operations = SettingsKeychainOperations(copy: { dictionary, result in
        let (_, account) = validate(dictionary)
        if denied { return errSecInteractionNotAllowed }
        guard let data = records[account] else { return errSecItemNotFound }
        result?.pointee = data as CFData
        return errSecSuccess
    }, add: { dictionary, _ in
        let (value, account) = validate(dictionary)
        if denied { return errSecAuthFailed }
        precondition(value[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        guard records[account] == nil else { return errSecDuplicateItem }
        records[account] = value[kSecValueData as String] as? Data
        return errSecSuccess
    }, update: { dictionary, attributes in
        let (_, account) = validate(dictionary)
        if denied { return errSecAuthFailed }
        guard records[account] != nil else { return errSecItemNotFound }
        records[account] = (attributes as! [String: Any])[kSecValueData as String] as? Data
        return errSecSuccess
    })

    let first = try SettingsVault(account: "profile.first", service: "synthetic.settings",
                                  operations: operations, lockURL: lockURL)
    let second = try SettingsVault(account: "profile.second", service: "synthetic.settings",
                                   operations: operations, lockURL: lockURL)
    let initiallyAbsent = try first.read(); precondition(initiallyAbsent == nil)
    let initialWrite = try first.write(settings(), expected: nil); precondition(initialWrite)
    let initialRead = try first.read(); precondition(initialRead?["model"] as? String == "synthetic-model")
    let unexpectedCreate = try first.write(settings(model: "conflict"), expected: nil); precondition(!unexpectedCreate)
    let update = try first.write(settings(model: "updated"), expected: settings()); precondition(update)
    let staleUpdate = try first.write(settings(model: "stale"), expected: settings()); precondition(!staleUpdate)
    let secondAbsent = try second.read(); precondition(secondAbsent == nil, "profiles must use separate Keychain accounts")
    let secondWrite = try second.write(settings(model: "other-profile"), expected: nil); precondition(secondWrite)
    let firstRead = try first.read(); precondition(firstRead?["model"] as? String == "updated")
    let secondRead = try second.read(); precondition(secondRead?["model"] as? String == "other-profile")
    precondition(FileManager.default.fileExists(atPath: lockURL.path), "lock file must remain durable")

    var legacy = settings(model: "legacy-model")
    legacy.removeValue(forKey: "contextWindowTokens")
    records["profile.legacy"] = try JSONSerialization.data(withJSONObject: legacy, options: [.sortedKeys])
    let legacyVault = try SettingsVault(account: "profile.legacy", service: "synthetic.settings",
                                        operations: operations, lockURL: lockURL)
    guard let normalizedLegacy = try legacyVault.read() else { fatalError("legacy record missing") }
    precondition(normalizedLegacy["contextWindowTokens"] as? Int == 262_144)
    precondition(normalizedLegacy["apiKey"] as? String == "synthetic-key")
    precondition(normalizedLegacy["model"] as? String == "legacy-model")
    let storedAfterRead = try JSONSerialization.jsonObject(with: records["profile.legacy"]!) as! [String: Any]
    precondition(storedAfterRead["contextWindowTokens"] == nil, "read must not rewrite the Keychain record")
    var legacyUpdate = normalizedLegacy
    legacyUpdate["contextWindowTokens"] = 131_072
    let legacyWritten = try legacyVault.write(legacyUpdate, expected: normalizedLegacy)
    precondition(legacyWritten, "normalized expected settings must match a legacy stored record")
    guard let migratedData = records["profile.legacy"],
          let migrated = try JSONSerialization.jsonObject(with: migratedData) as? [String: Any] else {
        fatalError("migrated record missing")
    }
    precondition(migrated["contextWindowTokens"] as? Int == 131_072)
    precondition(migrated["apiKey"] as? String == "synthetic-key")
    precondition(migrated["model"] as? String == "legacy-model")

    var invalid = settings(); invalid["extra"] = "value"
    rejects { _ = try SettingsCodec.encode(invalid) }
    invalid = settings(); invalid.removeValue(forKey: "stream")
    rejects { _ = try SettingsCodec.encode(invalid) }
    invalid = settings(); invalid["stream"] = 1
    rejects { _ = try SettingsCodec.encode(invalid) }
    invalid = settings(); invalid["mode"] = "other"
    rejects { _ = try SettingsCodec.encode(invalid) }
    invalid = settings(); invalid["quickPrompts"] = String(repeating: "x", count: 26_001)
    rejects { _ = try SettingsCodec.encode(invalid) }
    invalid = settings(); invalid["apiKey"] = String(repeating: "x", count: 16_385)
    rejects { _ = try SettingsCodec.encode(invalid) }
    for value: Any in [8_191, 2_097_153, 12.5, true, "262144"] {
        invalid = settings(); invalid["contextWindowTokens"] = value
        rejects { _ = try SettingsCodec.encode(invalid) }
    }
    invalid = settings(); invalid["quickPrompts"] = String(repeating: "界", count: 26_000)
    let unicodeData = try SettingsCodec.encode(invalid); precondition(unicodeData.count <= SettingsCodec.maximumBytes)
    rejects { _ = try SettingsCodec.decode(Data("corrupt".utf8)) }
    rejects { _ = try SettingsCodec.decode(Data(repeating: 0, count: SettingsCodec.maximumBytes + 1)) }

    records["profile.first"] = Data("corrupt".utf8)
    rejects { _ = try first.read() }
    records["profile.first"] = nil
    denied = true
    rejects { _ = try first.read() }
    rejects { _ = try first.write(settings(), expected: nil) }
}

@main struct SettingsVaultChecks {
    static func main() throws {
        guard CommandLine.arguments.count >= 3 else { fatalError("usage: action lock-path [service]") }
        let action = CommandLine.arguments[1]
        let lockURL = URL(fileURLWithPath: CommandLine.arguments[2])
        if action == "memory" {
            try memoryChecks(lockURL: lockURL)
            print("SETTINGS_VAULT_MEMORY_CHECKS_PASSED")
            return
        }
        guard CommandLine.arguments.count == 4 else { fatalError("missing synthetic service") }
        let service = CommandLine.arguments[3]
        let account = "profile.synthetic"
        if action == "cleanup" {
            let status = SecItemDelete(query(service: service, account: account) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { fatalError("cleanup failed: \(status)") }
            return
        }
        let vault = try SettingsVault(account: account, service: service, lockURL: lockURL)
        if action == "write-real" {
            _ = SecItemDelete(query(service: service, account: account) as CFDictionary)
            let written = try vault.write(settings(), expected: nil); precondition(written)
            print("SETTINGS_VAULT_REAL_WRITE_PASSED")
        } else if action == "read-real" {
            let initial = try vault.read(); precondition(initial?["model"] as? String == "synthetic-model")
            let updated = try vault.write(settings(model: "durable-model"), expected: settings()); precondition(updated)
            let final = try vault.read(); precondition(final?["model"] as? String == "durable-model")
            print("SETTINGS_VAULT_REAL_READ_PASSED")
        } else {
            fatalError("unknown action")
        }
    }
}
