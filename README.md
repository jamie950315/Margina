# SafAI for Safari

SafAI is a privacy-conscious AI side panel for Safari. It keeps an assistant beside the page you are reading, lets you choose exactly which page context to attach, and sends that context only after you press **Send**.

SafAI supports OpenAI-compatible APIs as well as a ChatGPT account handoff. The panel is resizable, the webpage automatically reflows around it, and AI responses support Markdown and KaTeX math rendering.

> SafAI is an early-stage project. Building and installing it currently requires Xcode on macOS.
>
> The current interface is available in Traditional Chinese.

## Highlights

- Resizable right-side panel that automatically reduces and restores the webpage width
- OpenAI-compatible Chat Completions endpoint, API key, model, and streaming settings
- Multi-turn conversations with visible user and assistant message history
- Local text-only history for the latest 25 conversations
- Safari-style floating light/dark sidebar with continuous glass material and a compact toolbar
- Searchable local history and compact mode/capture menus
- Markdown rendering for headings, lists, tables, blockquotes, links, and code
- KaTeX rendering for `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, and fenced `math` blocks
- Current page text as optional, removable context
- Selected webpage text in a dedicated `selected_text` field
- Visible viewport screenshots
- Rounded live element picker with cropped element screenshots
- Up to four removable screenshot attachments per request
- OpenAI-compatible multimodal `image_url` request parts
- ChatGPT handoff that copies the prepared prompt and opens ChatGPT in a first-party tab
- Automatic stale-page detection for SPAs and dynamically updated pages
- Keyboard-accessible panel resizing and element selection
- Safari 15.4 compatibility, including an accessibility fallback for browsers without native `inert`

## AI modes

### OpenAI-compatible API

Enter an HTTPS endpoint, API key, and model name. SafAI sends a standard Chat Completions request directly from the extension. Local loopback endpoints may use HTTP only when no API key is present.

### ChatGPT handoff

ChatGPT cannot be embedded reliably because `chatgpt.com` blocks cross-origin framing and Safari restricts third-party login cookies. SafAI therefore prepares the structured context, copies it, and opens ChatGPT in a normal first-party tab. Screenshots remain available in the panel for copying separately.

## Usage

### API mode

1. Open SafAI from the Safari toolbar.
2. Enter an OpenAI-compatible base URL, API key, and model name.
3. Choose whether to include the current page or selected text.
4. Use the **+** menu beside the model name to attach a viewport or element screenshot.
5. Send the request. SafAI keeps recent exchanges as conversation context.

The base URL may end at `/v1` or include the complete `/chat/completions` path.

### ChatGPT mode

SafAI copies the structured text context to the system clipboard and opens ChatGPT in a normal first-party tab. Paste the text into ChatGPT. Screenshot attachments can be copied individually from their previews.

If clipboard access fails, SafAI leaves the draft and attachments in place and reports the failure; it does not open ChatGPT or download an image as a substitute.

## Errors and saved conversations

Failures remain visible until dismissed or replaced by another operation. Unavailable storage, corrupt saved settings, malformed API responses, interrupted streams, and failed page reads are not replaced with default settings, empty history, or simulated answers. If requested page context cannot be refreshed, sending stops so the question is not sent with missing context. You can retry, or turn off the context you do not want to include.

Conversation history stores text only, not screenshots or page snapshots. It retains up to 25 conversations, 100 messages per conversation, 12,000 characters per message, and 32,000 characters per conversation. Retained text is visibly shortened with an ellipsis when needed. API requests use the latest 12 messages as prior context. Starting a new conversation retains older saved conversations.

Necessary protections remain: untrusted content is sanitized, invalid math stays readable as literal text, size and endpoint restrictions apply, and Safari 15.4 keyboard-accessibility support is retained. Glass effects are reduced when the system requests reduced transparency; motion follows the system preference.

The floating sidebar starts at 322px wide with 10px gutters and remains resizable. Its host supplies the glass material behind the isolated extension frame; no screenshot or webpage data is collected to create the visual effect. The toolbar's history button switches between the conversation and a searchable history list without discarding an unsent draft. Click the model name to switch API/ChatGPT modes or open API settings. Escape closes a popover or returns from history.

The toolbar checks that the sidebar actually acknowledged opening or closing. If initialization fails, the toolbar displays `!` and a failure hint instead of silently accepting an empty response.

### Using multiple tabs

Settings and conversations share a single ordered writer. Changing one option does not replace another tab's newer API URL, key or model; saving a conversation adds its new messages without replacing other conversations. If two tabs continue the same saved conversation, both completed turns are retained in save order.

Open sidebars refresh shared settings automatically and when returning to a page. An outdated settings form reports a conflict instead of overwriting newer values; close and reopen it to review the current values. A request is stopped before sending if its settings have changed. If endpoint permission is missing, open API settings and save to grant it. Old-origin permission cleanup is ordered with settings writes; after a failed save, any newly granted but unused permission can be removed in Safari settings.

After updating the installed app, reload webpages that already had SafAI open so every sidebar uses the new saving behavior. Keep only the Applications copy registered for normal use; development build copies are not separate installations to use alongside it.

## Requirements

- macOS 12.3 or later
- Safari 15.4 or later
- Xcode with the Safari Web Extension packager
- Node.js 22.13 or later

## Build and install

```bash
git clone https://github.com/jamie950315/SafAI.git
cd SafAI
npm ci
npm test
npm run package:safari
open SafariApp/SafAI/SafAI.xcodeproj
```

In Xcode:

1. Select a development team for both the `SafAI` app and extension targets.
2. Run the `SafAI` scheme.
3. Open **Safari → Settings → Extensions** and enable SafAI.
4. Click the SafAI toolbar button on a webpage.

For a local installed copy, build the `SafAI` scheme in Release configuration with your development team selected, then copy the resulting `SafAI.app` to `/Applications` and launch that copy. Keep the containing app installed there so Safari can locate its extension. A development-signed local build is not a notarized public distribution; signing material and generated app bundles must not be committed to Git.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run the Node.js test suite. |
| `npm run build` | Build the browser-ready extension into `dist/`. |
| `npm run package:safari` | Rebuild the extension and regenerate the Xcode project in `SafariApp/`. |
| `npm run check` | Run tests and build the extension. |

For an unsigned compile-only Xcode check:

```bash
xcodebuild \
  -project SafariApp/SafAI/SafAI.xcodeproj \
  -scheme SafAI \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath output/DerivedData \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## Project structure

```text
src/           Extension source, styles, manifest, and icons
scripts/       Browser build and Safari packaging scripts
tests/         Node.js unit and DOM integration tests
SafariApp/     Generated macOS app and Safari extension Xcode project (ignored by Git)
dist/          Generated browser extension output (ignored by Git)
```

The source of truth is `src/`. Do not edit bundled JavaScript or copied resources under `dist/` or `SafariApp/SafAI/SafAI Extension/Resources/` by hand; regenerate them with the provided scripts.

### Local interface and Safari checks

After building, serve `dist/` on loopback and open `/panel.html?demo` to inspect the interface without sending requests. Demo mode must be explicitly requested; missing extension APIs are an error, not a reason to simulate success. Demo history is in-memory only.

For a real Safari check, serve the dedicated fixture:

```bash
python3 -m http.server 8767 --bind 127.0.0.1 --directory tests/fixtures
```

Open `http://127.0.0.1:8767/reading-page.html` in Safari, activate SafAI from its toolbar, and check resizing, text selection, screenshot/element capture, attachment preview/removal, and settings. The fixture contains no personal data. A stalled paint or capture must report a failure and restore the panel, not leave it hidden. Browser demo checks do not replace real extension checks or a configured provider request.

The tests include real loopback HTTP requests for successful streaming, incomplete responses, and timeouts, plus executed panel/content-script DOM tests. No real API key is required.

### Verification scope and known limitations

Native Safari checks cover opening, closing and reopening the sidebar, viewport and element screenshots, image previews, settings/history controls, and a saved option synchronizing between two tabs. Concurrent conversation saves and stale API-setting conflicts are covered by isolated tests using synthetic data. These checks do not establish compatibility with every API provider or every supported Safari version.

For local HTTP providers, use `localhost` or `127.0.0.1` without an API key. Safari reports the current IPv6-literal content-security-policy source (`http://[::1]:*`) as invalid, so direct IPv6 loopback connectivity is not validated. Do not broaden HTTP permissions to work around this warning.

## Privacy and security

- Page text, selected text, and screenshots remain local until **Send** is pressed.
- SafAI contains no project-operated analytics or telemetry.
- API keys and settings are stored in Safari extension local storage and are not exposed to the host webpage.
- API keys are not stored in macOS Keychain; scoped and revocable keys are recommended.
- Endpoint permission is requested only for the origin configured by the user.
- Remote API endpoints must use HTTPS. Plain HTTP is limited to loopback services and cannot carry an API key.
- URL credentials, query parameters, and fragments are removed before page context is sent.
- Webpage content is labeled as untrusted context to reduce prompt-injection risk.
- Context, screenshots, metadata, and provider responses have size limits.
- AI Markdown and KaTeX output is sanitized; raw HTML, executable content, remote images, unsafe links, and trusted KaTeX commands are blocked.
- No remote scripts, stylesheets, or fonts are loaded by the extension.

## Contributing

Issues and pull requests are welcome. Keep changes focused, add tests for changed behavior, and run `npm run check` before submitting changes. Packaging changes should also run `npm run package:safari` and the unsigned Xcode build above. See [AGENTS.md](AGENTS.md) for repository-specific development rules.

## License

No open-source license has been added yet.
