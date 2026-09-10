# SafAI for Safari

SafAI is a privacy-conscious AI side panel for Safari. It keeps an assistant beside the page you are reading and lets you choose exactly which page context to attach. API mode sends only after **Send**; ChatGPT mode transfers a draft only after **附到 ChatGPT**, then waits for you to finish sending in ChatGPT.

SafAI supports OpenAI-compatible APIs and a bundled local relay for a ChatGPT account without an API key. The panel is resizable, the webpage automatically reflows around it, and API responses support Markdown and KaTeX math rendering.

> SafAI is an early-stage project. Building from source requires Xcode and Node.js; using a packaged App does not. Core ChatGPT flows have been verified in installed Safari. The current archive is development-signed; a notarized public download is not yet available.
>
> The current interface is available in Traditional Chinese.

## Highlights

- Resizable right-side panel that automatically reduces and restores the webpage width
- OpenAI-compatible Chat Completions endpoint, API key, model, and streaming settings
- Multi-turn conversations with visible user and assistant message history
- Local text-only history for the latest 25 conversations
- Safari-style floating light/dark sidebar with continuous glass material and a compact toolbar
- macOS-style grouped toolbar controls, continuous frosted material and a floating composer
- Searchable local history and compact mode/capture menus
- Markdown rendering for headings, lists, tables, blockquotes, links, and code
- KaTeX rendering for `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, and fenced `math` blocks
- Current page text as optional, removable context
- Selected webpage text in a dedicated `selected_text` field
- Visible viewport screenshots
- Rounded live element picker with cropped element screenshots
- Up to four removable screenshot attachments per request
- OpenAI-compatible multimodal `image_url` request parts
- Bundled ChatGPT relay with official first login, local Keychain session storage, and extension account controls
- User-requested ChatGPT draft preparation with selected context and images, without automatic submission
- Automatic stale-page detection for SPAs and dynamically updated pages
- Keyboard-accessible panel resizing and element selection
- Selection-to-draft actions: explain, translate, outline and follow up
- Clickable request-scoped source references that locate and highlight exact original text
- Explicit comparison of up to three selected tabs, with removable/previewable snapshots
- Locally saved custom prompts with editing and ordering
- Smooth 250ms sidebar/page-width transitions, with reduced-motion support
- Safari 15.4 compatibility, including an accessibility fallback for browsers without native `inert`

## AI modes

### OpenAI-compatible API

Enter an HTTPS endpoint, API key, and model name. SafAI sends a standard Chat Completions request directly from the extension. Local loopback endpoints may use HTTP only when no API key is present.

### ChatGPT account

The containing App includes a native local relay for the ChatGPT website. It does not require an API key or a separately installed service. First login opens a temporary native window on the official HTTPS login pages; enter credentials only there, never at a local hostname. After native confirmation, SafAI saves the minimum ChatGPT session cookies in macOS Keychain and independently checks that session before showing account access.

Closing Safari or the App window is not logout. The extension provides logout, switch-account and explicit reconnect controls. Reconnect rechecks a saved session without deleting it or asking for a new login; failed checks remain visible and are not retried automatically. SafAI does not import Safari sessions, configure a system proxy or install certificates. See [relay security and verification status](src/relay/README.md).

## Usage

### Reading tools

SafAI requests persistent access to general HTTP/HTTPS websites and tab metadata so Safari does not ask separately for every site. Safari may still require an initial user confirmation. This permission does not automatically collect every tab: the selection toolbar only prepares a local draft, and **+ → Compare tabs** reads only the pages you select. Context reaches the selected service only after **Send** in API mode or **附到 ChatGPT** in ChatGPT mode.

Select page text to explain, translate, outline or ask a follow-up. The action opens the sidebar and adds a draft; it never sends automatically. Input/password/editable fields do not show the floating menu. After keyboard selection, Tab enters the menu and Escape dismisses it. Disable it under **+ → Custom prompts**, where you can also add, edit, reorder and save up to 12 prompts.

### Page context and multiple annotations

Annotations are the passages you want the model to focus on, not a replacement for the page's context. When annotations are included, SafAI sends the readable page body alongside an ordered list of marked passages. If the page context cannot be read, it does not silently send the annotations alone.

Select a passage, then click **＋ 保留並繼續選取** in the sidebar to keep it and select another. You can retain up to 10 passages totaling 16,000 characters and remove each one separately. The current live selection is also included when you send, so the last passage does not need another press of the plus button. Retained annotations are not saved in conversation history. Changing the source page prevents old annotations from being combined with unrelated context.

“Page context” means the currently loaded readable body, not unloaded content or unlimited text. Initial previews are capped at 32,000 characters for the current page and 16,000 for each comparison page. Long documents use the workflow below rather than sending only that preview.

### Long documents

The **長文處理** selector offers two modes:

- **依問題與標註找重點** (default): scans up to two million locally loaded characters, keeps each uniquely matched annotation with 300 characters of surrounding text on each side, then selects query-related and structural context from throughout the document. It sends at most 32,000 excerpt characters for the current page or 16,000 per comparison page, plus annotations. The interface reports scanned/selected coverage; this is not a claim that the model read every passage. Missing or ambiguous annotations require reselection rather than guessed positions.
- **分批閱讀全文（API）**: prepares a frozen document snapshot and shows the exact number of reading, summary-merging and final-answer requests, the model and provider destination. No model requests run until you check the cost acknowledgement and confirm. Every batch contains at most 12,000 original characters; summaries are merged hierarchically before answering. Summaries remain lossy, not a verbatim copy of the whole document. The maximum is 400 requests per run. Provider pricing and extra query/summary usage determine the bill; no fixed monetary estimate is implied.

Stop cancels further work; failed or interrupted runs are not called complete and are not automatically retried. Already executed requests may have incurred charges. A changed page invalidates its snapshot. Raw long-document snapshots remain local and are released on completion/cancellation; they are never saved in conversation history. The two-million-character limit and separate structure/raw-text safeguards fail explicitly instead of silently pretending to read more. Content not yet loaded by infinite scrolling is not collected.

ChatGPT supports locally prepared relevant snapshots and asks for a second click to attach them to its draft. Full multi-request reading requires an OpenAI-compatible API. New conversations reset to relevant mode to avoid accidental repeated full-reading costs.

Comparison supports three normal tabs in the same window, excluding private tabs. Each source is limited to 16,000 characters. Preview or remove a source before sending; comparison does not include an unselected current page or its remembered selection. API mode refreshes selected pages before sending and fails the entire read if one source cannot be read. ChatGPT draft preparation uses the explicitly attached snapshots.

Answers can include source markers such as `[P1]` or `[T1P1]`. Buttons below an answer locate exact text in the original page and highlight it briefly. Missing or ambiguous text is reported rather than guessed. The page may have changed, and not every model will follow citation instructions. Source mappings are session-only to avoid saving page snapshots; restored history retains the textual markers but not locator buttons.

### API mode

1. Open SafAI from the Safari toolbar.
2. Enter an OpenAI-compatible base URL, API key, and model name.
3. Choose whether to include the current page or selected text.
4. Use the **+** menu beside the model name to attach a viewport or element screenshot.
5. Send the request. SafAI keeps recent exchanges as conversation context.

The base URL may end at `/v1` or include the complete `/chat/completions` path.

### ChatGPT mode

1. Choose ChatGPT in the mode menu, then use the official login control on first use.
2. Finish sign-in in the native official HTTPS window and press its completion button. Subsequent App launches check the saved account automatically.
3. Prepare the question and choose page context, annotations or screenshot attachments in SafAI.
4. Press **附到 ChatGPT** to prepare the ChatGPT draft. This does not submit a model request automatically. Existing ChatGPT drafts are not overwritten.
5. Check the draft and wait for image uploads to finish, then send from ChatGPT itself.

SafAI retains attachments after draft acknowledgement because choosing an image is not proof that its upload finished. If handoff fails or times out, the local draft and attachments stay available; inspect ChatGPT before retrying to avoid duplicates. Logout and switch-account controls are in the extension, while reconnect rechecks the current saved login. Installed Safari has verified page-context answers, ordered multi-passage annotations, screenshot upload/recognition, and the sent-image preview.

## Errors and saved conversations

Failures remain visible until dismissed or replaced by another operation. Unavailable storage, corrupt saved settings, malformed API responses, interrupted streams, and failed page reads are not replaced with default settings, empty history, or simulated answers. If requested page context cannot be refreshed, sending stops so the question is not sent with missing context. You can retry, or turn off the context you do not want to include.

SafAI's local conversation history stores text only, not screenshots or page snapshots. It retains up to 25 conversations, 100 messages per conversation, 12,000 characters per message, and 32,000 characters per conversation. Retained text is visibly shortened with an ellipsis when needed. API requests use the latest 12 messages as prior context. Starting a new conversation retains older saved conversations. ChatGPT's own conversation history and account features remain controlled by ChatGPT; the relay does not import that history into SafAI's local store.

Necessary protections remain: untrusted content is sanitized, invalid math stays readable as literal text, size and endpoint restrictions apply, and Safari 15.4 keyboard-accessibility support is retained. Glass effects are reduced when the system requests reduced transparency; motion follows the system preference.

The floating sidebar starts at 322px wide with 10px gutters and remains resizable. Its host supplies the glass material behind the isolated extension frame; no screenshot or webpage data is collected to create the visual effect. The toolbar's history button switches between the conversation and a searchable history list without discarding an unsent draft. Click the model name to switch API/ChatGPT modes or open API settings. Escape closes a popover or returns from history.

Page reflow reduces the page's content width, adjusts accessible stylesheet width breakpoints, and moves viewport-fixed controls into the remaining space. Closing restores these changes. X has an additional column-width adjustment; its secondary information column is hidden when less than 1000px remains for the page. This is not a native browser sidebar: JavaScript viewport measurements, inaccessible cross-origin styles, viewport-sized content and other specialized layouts may still need website-specific handling. See `AGENTS.md` for verification scope.

The toolbar checks that the sidebar actually acknowledged opening or closing. If initialization fails, the toolbar displays `!` and a failure hint instead of silently accepting an empty response.

### Using multiple tabs

Settings and conversations share a single ordered writer. Changing one option does not replace another tab's newer API URL, key or model; saving a conversation adds its new messages without replacing other conversations. If two tabs continue the same saved conversation, both completed turns are retained in save order.

Open sidebars refresh shared settings automatically and when returning to a page. An outdated settings form reports a conflict instead of overwriting newer values; close and reopen it to review the current values. A request is stopped before sending if its settings have changed. If endpoint permission is missing, open API settings and save to grant it. Old-origin permission cleanup is ordered with settings writes; after a failed save, any newly granted but unused permission can be removed in Safari settings.

After updating the installed app, reload webpages that already had SafAI open so every sidebar uses the new saving behavior. Keep only the Applications copy registered for normal use; development build copies are not separate installations to use alongside it.

## Requirements

For a packaged App:

- macOS 12.3 or later
- Safari 15.4 or later
- A ChatGPT account for account mode, or an OpenAI-compatible provider for API mode

Only developers building from source additionally need:

- Xcode with the Safari Web Extension packager
- Node.js 22.13 or later
- Compatible signing for both native targets and their shared App Group

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

1. Select the same development team for both the `SafAI` app and extension targets, with the generated shared App Group available to both.
2. Run the `SafAI` scheme.
3. Open **Safari → Settings → Extensions** and enable SafAI.
4. Click the SafAI toolbar button on a webpage.

For a local installed copy, build the `SafAI` scheme in Release configuration with your development team selected, then copy the resulting `SafAI.app` to `/Applications` and launch that copy. The App contains both the extension and relay; there is no separate end-user service setup. Keep it installed there so Safari can locate its extension. The containing App remains available when its window closes, and the extension can wake it when needed. Keep one installed copy; a second App copy cannot take over an active relay's account writer.

A development-signed local build is not a notarized public distribution. Developer ID signing, notarization and public publication remain separate delivery work. Signing material and generated app bundles must not be committed to Git. Do not replace a running App bundle until its active login has been safely preserved and the App has stopped.

To prepare a local universal preview, build both architectures using your own current signing identity and team, then verify/archive it:

```bash
xcodebuild -project SafariApp/SafAI/SafAI.xcodeproj -scheme SafAI \
  -configuration Release -destination 'generic/platform=macOS' \
  -derivedDataPath output/DerivedDataDistribution \
  ARCHS='arm64 x86_64' ONLY_ACTIVE_ARCH=NO CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="$SAFAI_TEAM_ID" CODE_SIGN_IDENTITY="$SAFAI_SIGN_IDENTITY" \
  CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO build
npm run archive:safari
```

The archive command checks embedded resources, aligned versions, both architectures, signatures and the absence of debugging entitlements. It writes a preview ZIP and SHA-256 checksum under `output/releases/` and refuses to overwrite an existing archive. This does not notarize the App or establish completed Safari interaction tests.

## UI framework and design sources

The interface retains selected [Puppertino](https://github.com/codedgar/Puppertino) CSS modules under the MIT license as a local control foundation, pinned under `src/vendor/puppertino/`. The license is shipped with the app. The production redesign in `src/panel/apple-theme.css` uses measured AppKit control proportions and Safari toolbar grouping as references: a shared toolbar capsule, a borderless source row, continuous frosted material and a floating composer. System typography, subtle upper-edge highlights and neutral dark surfaces establish hierarchy without nested outlined cards. Detailed page-reading choices live in the model menu; attached-context status and long-reading progress remain visible.

The dark palette uses a `#1e1e1e` opaque background, a `#232426` tinted host, `#28292c` sheets and `#343434` solid controls. Low-opacity upper highlights and a denser host tint keep bright webpages from washing the sidebar into gray. The light palette is independent and unchanged.

This is a Safari-compatible web interpretation, not a native SwiftUI/AppKit Liquid Glass surface. Apple’s [official design resources](https://developer.apple.com/design/resources/) are design assets rather than a drop-in web framework. The project does not use screenshot/WebGL-based refraction, cloned webpage content, remote fonts, or CDN-loaded UI code. Existing controls and state handling remain in place.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run the Node.js test suite. |
| `npm run build` | Build the browser-ready extension into `dist/`. |
| `npm run build:relay` | Build the standalone development relay fixture into `output/relay/`; optional signing via `SAFAI_SIGN_IDENTITY`, no installation. |
| `npm run relay:preview` | Run the standalone relay/control fixture; not the production persistent-account installation. |
| `npm run package:safari` | Rebuild the extension and generate the single-App Xcode project, native relay and shared-group configuration in `SafariApp/`. |
| `npm run archive:safari` | Verify an already signed universal build and create a local preview ZIP/checksum; not notarization or publication. |
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
src/native/    Containing App lifecycle and private Safari native bridge
src/relay/     Native ChatGPT relay, official login, and Keychain session storage
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

The installed v0.2.0 build 5 App has verified direct-native account restoration in Safari, including Safari quit/reopen and explicit reconnect without another login. The real ChatGPT frame answered a synthetic page-context question, read a screenshot sent from SafAI, displayed its image preview, and returned two retained passages in their original order. Earlier checks also verified full App cold restart and sandboxed shared-group communication. The image-upload selector is scoped to the active composer form so unrelated camera/media inputs do not block screenshot handoff.

All 328 automated tests, the browser build, unsigned Debug and signed universal Release builds passed. The preview ZIP passed integrity and extracted-signature checks. Real-account logout/switch was not performed merely for testing; synthetic native/Keychain tests cover those transitions while preserving the user's login. Advanced-model selection, account-memory behavior, other Safari versions and Intel runtime behavior remain separate verification scopes.

For local HTTP providers, use `localhost` or `127.0.0.1` without an API key. Safari reports the current IPv6-literal content-security-policy source (`http://[::1]:*`) as invalid, so direct IPv6 loopback connectivity is not validated. Do not broaden HTTP permissions to work around this warning.

## Privacy and security

- Page text, selected text, and screenshots remain local until **Send** in API mode or **附到 ChatGPT** in account mode. Preparing a ChatGPT draft may start image uploads, but does not automatically submit the conversation.
- SafAI contains no project-operated analytics or telemetry.
- API keys and settings are stored in Safari extension local storage and are not exposed to the host webpage.
- API keys are not stored in macOS Keychain; scoped and revocable keys are recommended.
- ChatGPT session cookies, unlike API keys, are kept only in the local macOS Keychain by the containing App. Passwords are entered on official HTTPS pages, never collected by a local form. No Safari cookie import or plaintext session export is used.
- Private native communication credentials stay in an owner-only App Group location, not extension settings or webpages. A single native account writer owns the group; logout revokes current access and prevents failed removal from restoring an account later.
- General HTTP/HTTPS website access and tab metadata permission are requested for reading tools; only explicitly selected contexts are sent. API changes do not revoke the shared website permission.
- Remote API endpoints must use HTTPS. Plain HTTP is limited to loopback services and cannot carry an API key.
- URL credentials, query parameters, and fragments are removed before page context is sent.
- Webpage content is labeled as untrusted context to reduce prompt-injection risk.
- Context, screenshots, metadata, and provider responses have size limits.
- API Markdown and KaTeX output is sanitized; raw HTML, executable content, remote images, unsafe links, and trusted KaTeX commands are blocked.
- The extension's own UI scripts, stylesheets and fonts are bundled locally. The separate ChatGPT frame necessarily loads the provider's website through the local relay; its account, conversation and service behavior remain subject to ChatGPT's policies.

## Contributing

Issues and pull requests are welcome. Keep changes focused, add tests for changed behavior, and run `npm run check` before submitting changes. Packaging changes should also run `npm run package:safari` and the unsigned Xcode build above. See [AGENTS.md](AGENTS.md) for repository-specific development rules.

## License

No open-source license has been added yet.
