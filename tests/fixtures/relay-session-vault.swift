import Foundation
import Security

@main struct VaultChecks {
    static func cookie(name: String = "__Secure-next-auth.session-token", domain: String = ".chatgpt.com",
                       value: String = "synthetic-session-only", expiry: Date? = Date().addingTimeInterval(3600)) -> HTTPCookie {
        var properties: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .domain: domain,
            .path: "/", .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE"]
        if let expiry { properties[.expires] = expiry }
        return HTTPCookie(properties: properties)!
    }
    static func rejects(_ work: () throws -> Void) {
        do { try work(); fatalError("expected rejection") } catch {}
    }
    static func main() throws {
        let source = cookie()
        let data = try RelaySessionCodec.encode([source])
        let decoded = try RelaySessionCodec.decode(data)
        precondition(decoded.count == 1 && decoded[0].name == source.name && decoded[0].value == source.value)
        precondition(decoded[0].isSecure && decoded[0].isHTTPOnly && decoded[0].domain == source.domain)
        let chunks = [cookie(name: "__Secure-authjs.session-token.1"), cookie(name: "__Secure-authjs.session-token.0")]
        let ordered = try RelaySessionCodec.decode(RelaySessionCodec.encode(chunks))
        precondition(ordered[0].name.hasSuffix(".0") && ordered[1].name.hasSuffix(".1"))
        let sessionOnly = try RelaySessionCodec.decode(RelaySessionCodec.encode([cookie(expiry: nil)]))
        precondition(sessionOnly[0].expiresDate == nil)
        rejects { _ = try RelaySessionCodec.encode([]) }
        rejects { _ = try RelaySessionCodec.encode([cookie(domain: "evil.example")]) }
        rejects { _ = try RelaySessionCodec.encode([source, cookie(name: "device-id")]) }
        rejects { _ = try RelaySessionCodec.encode([cookie(expiry: Date().addingTimeInterval(-1))]) }
        rejects { _ = try RelaySessionCodec.encode([cookie(name: "__Secure-authjs.session-token.1")]) }
        rejects { _ = try RelaySessionCodec.encode([source, source]) }
        rejects { _ = try RelaySessionCodec.decode(data, now: Date().addingTimeInterval(7200)) }
        rejects { _ = try RelaySessionCodec.decode(Data("corrupt".utf8)) }
        rejects { _ = try RelaySessionCodec.decode(Data(repeating: 0, count: RelaySessionCodec.maximumBytes + 1)) }
        for patch: (inout [String: Any]) -> Void in [
            { $0["version"] = 2 },
            { var c = $0["cookies"] as! [[String: Any]]; c[0]["value"] = String(repeating: "x", count: 16_385); $0["cookies"] = c },
            { var c = $0["cookies"] as! [[String: Any]]; c[0]["secure"] = false; $0["cookies"] = c },
            { var c = $0["cookies"] as! [[String: Any]]; c[0]["httpOnly"] = false; $0["cookies"] = c },
            { var c = $0["cookies"] as! [[String: Any]]; c[0]["domain"] = "other.example"; $0["cookies"] = c },
            { var c = $0["cookies"] as! [[String: Any]]; c[0]["path"] = "/other"; $0["cookies"] = c },
        ] {
            var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            patch(&object)
            rejects { _ = try RelaySessionCodec.decode(JSONSerialization.data(withJSONObject: object)) }
        }

        // All system calls are replaced; no real Keychain item is read or written.
        var stored: Data?
        var denied = false
        var calls = 0
        func validate(_ query: CFDictionary) {
            let q = query as! [String: Any]
            precondition(q[kSecAttrService as String] as? String == "dev.jamie.safai.chatgpt-session")
            precondition(q[kSecAttrAccount as String] as? String == "primary")
            precondition(q[kSecAttrSynchronizable as String] as? Bool == false)
            calls += 1
        }
        let operations = RelayKeychainOperations(copy: { query, result in
            validate(query)
            if denied { return errSecInteractionNotAllowed }
            guard let stored else { return errSecItemNotFound }
            result?.pointee = stored as CFData
            return errSecSuccess
        }, add: { query, _ in
            validate(query)
            if denied { return errSecAuthFailed }
            let q = query as! [String: Any]
            precondition(q[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
            stored = q[kSecValueData as String] as? Data
            return errSecSuccess
        }, update: { query, attributes in
            validate(query)
            if denied { return errSecAuthFailed }
            guard stored != nil else { return errSecItemNotFound }
            stored = (attributes as! [String: Any])[kSecValueData as String] as? Data
            return errSecSuccess
        }, delete: { query in
            validate(query)
            if denied { return errSecAuthFailed }
            stored = nil
            return errSecSuccess
        })
        var revoked = false
        let revocation = RelaySessionRevocationStore(read: { revoked }, write: { revoked = $0 })
        let vault = RelaySessionVault(operations: operations, revocation: revocation)
        let absent = try vault.load(); precondition(absent == nil)
        try vault.save([source])
        let loaded = try vault.load(); precondition(loaded?.first?.value == source.value)
        try vault.save(chunks)
        let updated = try vault.load(); precondition(updated?.count == 2)
        denied = true
        rejects { _ = try vault.load() }
        rejects { try vault.save([source]) }
        rejects { try vault.clear() }
        let suppressed = try vault.load(); precondition(suppressed == nil && revoked)
        let recreated = RelaySessionVault(operations: operations, revocation: revocation)
        let suppressedAfterRestart = try recreated.load(); precondition(suppressedAfterRestart == nil)
        denied = false
        try vault.save([source]); precondition(!revoked)
        stored = Data("corrupt".utf8)
        rejects { _ = try vault.load() }
        try vault.clear()
        let cleared = try vault.load(); precondition(cleared == nil && calls > 8)
        var deletionAttempted = false
        var failingRevocationOperations = operations
        failingRevocationOperations.delete = { _ in deletionAttempted = true; return errSecSuccess }
        let failedMarkerVault = RelaySessionVault(operations: failingRevocationOperations,
            revocation: RelaySessionRevocationStore(read: { false }, write: { _ in throw RelaySessionVaultError.invalidRecord }))
        rejects { try failedMarkerVault.clear() }
        precondition(!deletionAttempted, "revocation must be durable before attempting Keychain deletion")
        print("SESSION_VAULT_CHECKS_PASSED")
    }
}
