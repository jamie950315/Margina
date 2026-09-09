# Bundled ChatGPT relay

SafAI's production packaging includes the Safari extension and a native ChatGPT relay in one macOS App. The relay runs locally using AppKit, WebKit, Foundation, Network and Security; an end user does not install Node.js, a proxy, certificates or a separate server. The OpenAI-compatible API mode remains independent.

The formal integration is under installed-Safari verification. The native App has restored a real, user-authorized saved account, including after a full App restart. Do not equate that result with completed sidebar conversation or attachment verification; see the status section below.

## Account workflow

1. Select ChatGPT in the extension and choose official login. Account entry happens only in the temporary native window on allowlisted official HTTPS pages, never at a local hostname.
2. After returning to ChatGPT, press the native completion button. Native code selects only the newly created app-owned ChatGPT session cookies and independently checks the session before enabling the relay.
3. Confirmed session cookies are saved in the local macOS Keychain. Reopening the App rechecks the saved session before exposing account access. Closing Safari or the App's window is not logout.
4. Use the extension's logout or switch-account controls when needed. Logout revokes active access before removing the saved account. If removal fails, a separate revocation marker prevents that account from being restored on restart.
5. Explicit reconnect retries a saved-session check without deleting the account or opening a login window. A transient failure remains visible and does not trigger automatic authentication or model retries.

Only the minimum secure, HTTP-only ChatGPT session-cookie envelope is stored. Passwords, API access tokens returned by the session probe, device identifiers, verification cookies and third-party login cookies are not persisted. This does not import an existing Safari session, synchronize account data to the cloud or export credentials to plaintext files.

## Sidebar and draft handling

The exact extension panel calls Safari native messaging directly for fixed account actions, following [Apple's app-to-extension messaging model](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension). Page/content-script messages cannot invoke those controls. The native handler wakes its own containing App and returns bounded public state plus a provider-frame capability only when signed in.

The real provider website is presented through a separate local origin in the sidebar. A source-checked, nonce-bound MessageChannel accepts only an explicit `PREPARE_DRAFT` operation for the user's text and selected images. It cannot submit the conversation, inspect account history or invoke account controls. Existing provider drafts are not overwritten. The user reviews the resulting draft and finishes sending in ChatGPT.

A successful draft acknowledgement means the page accepted the draft operation, not that an image upload completed. SafAI keeps the original attachments available; users must check ChatGPT's upload state before sending. Failed or uncertain handoffs preserve the local draft and attachments rather than automatically repeating an operation.

## Native ownership and security boundaries

- The containing App owns the account and Keychain access. A signed App Group holds only a private local endpoint descriptor/capability, never login cookies. The shared directory is owner-only and the descriptor is 0600, bounded and atomically replaced. No native IPC secret is returned to extension JavaScript.
- A regular, owned, empty 0600 lock file uses exclusive nonblocking `flock` to allow only one formal broker across App copies. Opening rejects symlinks, unsafe permissions, hard links and nonregular files. The lock is never unlinked. Shutdown invalidates pending operations and permanently stops account writes before releasing ownership.
- Private native IPC listens on 127.0.0.1. It accepts only fixed authenticated POST actions, an exact Host, no Origin and an empty body. Duplicate headers, transfer encoding and malformed requests are rejected. Limits are 4 KiB per request, 16 KiB per response, 16 simultaneous clients and a five-second client lifetime. Native response reads are bounded and redirects are denied.
- Provider and development-control listeners use separate ports, keys and per-process unique `.localhost` names. Exact Host/Origin checks remain. The provider capability is session-local to the extension/provider frame, never saved in settings or exposed to the host webpage.
- The provider cookie jar is separate from Safari. Incoming browser Cookie, Referer, Host and relay-control headers are not forwarded upstream; Set-Cookie is not exposed to the local document. Fresh session checks are bounded and do not follow redirects. Old URLSession callbacks cannot validate or overwrite a newer account.
- Official login uses a separate app-owned, nonpersistent WKWebView with restricted navigation and popups. The native completion button freezes interaction before transferring only validated session cookies. The login window has no JavaScript native-message handler and denies downloads, external app schemes, camera/microphone and file uploads.
- Provider routing is allowlisted. Authentication-host proxying remains blocked; authentication is direct HTTPS in the native window. Redirects are checked and rewritten, not followed blindly. Cookie-free immutable static requests are narrowly permitted, while static HTML/redirects fail closed and SVG documents receive sandbox restrictions.
- Framing/HTTPS-upgrade policies that conflict with the local origin are adapted, while other enforced provider script restrictions remain and the local compatibility script receives its own nonce. This is not a general-purpose proxy. Non-HTTP(S) URLs such as blob previews are not rewritten or given relay credentials.
- Uploads are limited to 32 MiB per request and 128 MiB outstanding; HTML responses are limited to 16 MiB and other responses to 32 MiB. Streaming uses backpressure and request/write/overall deadlines. Failed or interrupted transfers report failure.
- No cookies, capabilities, prompts, attachments or full URLs are logged. Diagnostics are limited to counters, phase enums and booleans. Challenges are reported rather than solved automatically; device/verification identities are not rewritten or replayed. WebSocket support and universal provider-page compatibility are not claimed.

## Development and packaging

Formal source lives in `src/native/` and `src/relay/`. `npm run package:safari` rebuilds extension assets and regenerates the containing App, native handler, shared-group entitlements and bundled relay resources. Keep changes out of generated `SafariApp/`, `dist/` and `output/` files. Both native targets need compatible signing and the same App Group. The containing App is not sandboxed; the extension remains sandboxed with outgoing-network permission.

Developer requirements are macOS, Xcode and the repository's Node.js environment. Run project tests, browser build, Safari packaging, signed Release and unsigned compile-only checks as described in the root README. An unsigned build does not establish App Group or Keychain access.

Standalone development commands remain available:

- `npm run build:relay` builds the isolated preview App under `output/relay/`; optional development signing uses `SAFAI_SIGN_IDENTITY`.
- `npm run build:relay -- --staging` writes a separate preview build under `output/relay-staging/`.
- `npm run relay:preview` launches the standalone control/login fixture. It is not the formal end-user installation and does not use the production persistence workflow.

Never overwrite a running App bundle or stop a login-owning process before confirming that the required login has been safely preserved. The standalone preview's native control page uses a one-use, 60-second bootstrap fragment; the fragment is removed before HTTP exchange and secrets are not printed or placed on a command line. Private descriptor overrides and bootstrap pipes exist only in synthetic test binaries.

## Verification status and remaining scope

Current evidence on 2026-09-10:

- The existing user-authorized test login was saved directly into Keychain without a plaintext export. The installed `/Applications/SafAI.app` restored it and passed an independent official session probe.
- A full App cold restart restored the account again. Quitting Safari left the App and login available. The old test process was stopped only after persistence was confirmed.
- The v0.2.0 build 4 universal preview archive passed integrity and extracted-signature checks and was installed. A signed sandboxed verification client then launched the stopped installed App without bringing it forward, accessed the real App Group descriptor and confirmed restored sign-in over native IPC. This establishes sandboxed group/network access and cold App wake; it does not exercise Safari's actual native-message handler. All 327 project tests, browser/standalone-relay builds, unsigned Debug and signed universal Release builds passed.
- The formal sidebar appeared in installed Safari, but foreground account interaction remained unconfirmed while a macOS Keychain authorization dialog owned the foreground. The exact panel now uses the officially supported direct native API; it still needs foreground installed-Safari verification. This does not establish that the previous transport was inherently defective, and the system authorization UI must not be bypassed.
- An isolated WebKit verification wrapper loaded the saved-account provider page and confirmed an exact synthetic draft through the production relay MessageChannel. A subsequent wrapper run did not reach the composer and did not send a prompt; its background-content error makes it unsuitable as a substitute for installed-Safari verification.
- The earlier standalone relay completed a synthetic authenticated text answer and correctly recognized the explicitly authorized `icon-128.png` image. These results do not prove the formal sidebar's text, annotation or image handoff.
- Synthetic tests cover account encoding/expiry, Keychain failures through injected operations, revocation, stale callbacks, reconnect, shutdown, single-owner locking, real loopback IPC rejection/limits, draft preparation and image URL handling. They do not access the user's Keychain or provider account.

Remaining installed verification includes the latest direct-native transport, a real sidebar conversation, selected-context/annotation handoff and image upload completion. Advanced-model selection and account-memory behavior are not established. Refresh the final test/build results after integration changes rather than carrying forward a historical count.

The current installation is development-signed for local testing. `npm run archive:safari` verifies an existing universal build and creates a preview ZIP/checksum. Developer ID signing, notarization and public publication are not established. Do not advertise an unsigned or development-signed compile as a verified public release.
