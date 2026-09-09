# Experimental local-origin ChatGPT relay

This is an isolated implementation prototype, **not a completed ChatGPT mode**. It is not included in the installed Safari extension or the generated Safari app. The production API mode and copy-and-open ChatGPT handoff are unchanged.

## Run

Requires macOS, Xcode command-line tools, and the project's Node.js development environment:

```bash
npm run relay:preview
```

Open the printed loopback preview URL in Safari, then choose **載入 ChatGPT 測試頁**. The left side is a synthetic article, not the user's current page. The right side loads the real provider website through the relay. Do not enter credentials or private content in this prototype. Press Ctrl+C in the launching terminal to stop it and discard the relay's in-memory provider session.

`npm run build:relay` builds a native `output/relay/SafAIRelay` executable and copies its local resources next to it. Node.js is used by the development launcher/build scripts; the relay process itself uses Foundation and Network. No system proxy, certificate trust, browser setting, Safari cookie import, or background installation is performed.

## Boundaries

- Binds only to `127.0.0.1` on an automatically assigned port, with exact Host checking.
- Uses an ephemeral provider cookie jar that is separate from Safari's existing accounts. Incoming browser Cookie, Referer, Host and relay-control headers are not forwarded upstream. Set-Cookie is not exposed to the local document.
- Requires an unpredictable, process-scoped capability for provider requests. The top-level local preview bootstraps it; that preview cannot itself be framed. Cross-origin Origin headers are rejected. No permissive CORS header is emitted.
- Narrow, cookie-free immutable static requests may load without a capability. Static HTML and redirects fail closed; SVG documents receive sandbox restrictions. CDN HTML cannot become an authenticated local document.
- Only fixed provider hosts are routable. Redirects are validated and rewritten instead of automatically followed. The authentication host currently returns an explicit unsupported response **before** network access: separate-origin login isolation is not implemented.
- Removes the framing directive, framing header, and reporting/HTTPS-upgrade directives that do not apply to the loopback origin. Other enforced CSP directives remain, with an independent nonce authorizing the local compatibility script. It does not discard all of the provider's script restrictions.
- Validates headers/authentication before buffering uploads, with a 32 MiB per-request limit, a 128 MiB outstanding request-body budget, a 16 MiB HTML limit, and a 32 MiB non-HTML response limit. Streaming responses apply backpressure. Request, stalled-write and overall deadlines reclaim failed connections.
- The local compatibility script adapts fetch/XHR, buffered Request uploads and some resource/navigation URLs. It does not handle every browser API or every provider navigation pattern. It does not export cookies, accept page-to-extension messages, or submit prompts automatically.
- No cookie, capability, prompt, attachment or full URL logging. Optional authenticated status output contains counters and device-consistency booleans only, never device values or hashes. A mismatch is not treated as proof of the cause of a provider rejection, and does not trigger identity changes or retries.
- Provider challenges are reported explicitly and are not solved automatically. WebSocket and account login are not implemented. The service exits after 30 minutes without authorized requests, but should be stopped explicitly after testing.

## Verification and current blocker

On 2026-09-10, all 271 project tests passed, the browser extension build passed, and the optimized native relay build passed. The new tests use loopback upstream fixtures only; native tests are skipped on non-macOS hosts. They cover framing-policy handling, capability/origin/Host checks, early upload rejection, cookie isolation, redirect allowlisting, challenge handling, binary round trips, streaming before completion, stalled-reader cleanup, static-resource restrictions, buffered upload limits and cancellation.

Installed Safari displayed the real **anonymous** ChatGPT webpage, login controls and composer beside the preview article. An isolated WebKit run verified hydration and entering a synthetic draft after fixing Safari's unsupported ReadableStream upload format. One synthetic send through the relay received the provider's “Unusual activity” rejection, not an answer. A separate direct-browser control produced no completed answer within its observation window, so it does not establish a root cause. No automatic model retries were performed. The relay's boolean diagnostics observed a device-identity mismatch; no identity or verification token was changed in response.

An additional isolated WKWebExtension test loaded an HTTPS example page, an extension-origin frame and the local relay frame, and observed the real ChatGPT composer in that nested chain. This is supporting evidence for the intended layout, not an installed-SafAI verification or universal website-compatibility claim.

No account login, advanced-model access, account memory, annotation transfer, attachment upload to ChatGPT, or successful conversation has been verified. The currently installed SafAI panel has not been pointed at the relay.

Before enabling real account entry, implement and review origin separation, provider-compatible session handling, trusted login UX and browser-context validation. Do not import Safari session cookies or ask the user to paste account tokens as a shortcut. Do not deploy or advertise this prototype as a working replacement for the existing ChatGPT mode.
