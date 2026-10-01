# Margina for Safari

Margina is a privacy-conscious AI side panel for Safari. It keeps an assistant beside the page you are reading and lets you choose exactly which page context to attach. API mode sends only after **Send**; ChatGPT mode transfers a draft only after **附到 ChatGPT**, then waits for you to finish sending in ChatGPT.

Margina supports OpenAI-compatible APIs and a bundled local relay for a ChatGPT account without an API key. The panel is resizable, the webpage automatically reflows around it, and API responses support Markdown and KaTeX math rendering.

> Margina is an early-stage project. Building from source requires Xcode and Node.js; using a packaged App does not. Core ChatGPT flows have been verified in installed Safari. The current archive is development-signed; a notarized public download is not yet available.
>
> The interface supports English, Traditional Chinese, Simplified Chinese and Japanese, with system detection and a saved language preference.

## Download

Download the [Margina 0.4.0 macOS preview](https://github.com/jamie950315/Margina/releases/tag/v0.4.0), which includes Apple silicon and Intel architectures. Extract the ZIP, move `Margina.app` to `/Applications`, and enable Margina in Safari's extension settings. The release includes a SHA-256 checksum.

This preview is development-signed and not notarized. Updating from SafAI preserves the existing extension identity, settings, saved ChatGPT login and local conversations.

## Highlights

- Four interface languages with system detection and a saved manual preference
- Resizable right-side panel that automatically reduces and restores the webpage width
- OpenAI-compatible Chat Completions endpoint, API key, model, and streaming settings
- Multi-turn conversations with visible user and assistant message history
- Page-specific local text-only history for the latest 25 conversations
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
- Per-website selection-menu exceptions, with immediate saving and one-click restoration
- Clickable request-scoped source references that locate and highlight exact original text
- Explicit comparison of up to three selected tabs, with removable/previewable snapshots
- Locally saved custom prompts with editing and ordering
- Browser-managed 250ms sidebar sliding, with one page resize per toggle and reduced-motion support
- Safari 15.4 compatibility, including an accessibility fallback for browsers without native `inert`

### Interface language

Open **Settings → Interface language**, choose **Follow system**, **English**, **繁體中文**, **简体中文**, or **日本語**, and save. The saved preference updates open sidebars and selection tools across tabs. Unsupported system languages use English. Chinese script preferences take priority over region; Taiwan, Hong Kong and Macau select Traditional Chinese, while other Chinese regions select Simplified Chinese.

Language changes preserve drafts, annotations, custom prompts, conversation history and API configuration. Built-in prompts use the selected interface language; your own text stays unchanged. AI responses follow the language of your question. The containing App, native login controls and Safari toolbar use the system language, while the official ChatGPT website manages its own language.

Translations are bundled locally. Extension catalogs live in `src/i18n/`, Safari metadata in `src/_locales/`, and native welcome/login catalogs in `src/native/welcome/Localizations.js` and `src/relay/RelayLoginPolicy.swift`. Existing Traditional Chinese source strings serve as stable catalog identifiers; all translations must preserve numbered placeholders. No language service, new permission or external request is required.

### Selection menu preferences

Open **Settings → Selection menu and website settings**, or **＋ → Selection menu**, to turn off the floating menu on the current website. The exception applies to every HTTP/HTTPS page on that exact hostname, regardless of path or port; subdomains are configured separately. For example, disable it on `chatgpt.com` to leave ChatGPT's own text-selection controls accessible. The global selection-menu switch remains available.

Changes save immediately in macOS settings and update open pages. The list of disabled websites provides a **Restore** action for each exception. Disabling the menu leaves text selection and sidebar annotations available, and does not change API settings or ChatGPT login. After installing an update, reload existing webpages once to load the new extension code.

## AI modes

### OpenAI-compatible API

Enter an HTTPS endpoint, API key, and model name. Margina sends a standard Chat Completions request directly from the extension. Requests reject redirects, so configure the final endpoint URL. Local loopback endpoints may use HTTP only when no API key is present.

### ChatGPT account

The containing App includes a native local relay for the ChatGPT website. It does not require an API key or a separately installed service. First login opens a temporary native window on the official HTTPS login pages; enter credentials only there, never at a local hostname. After native confirmation, Margina saves the minimum ChatGPT session cookies in macOS Keychain and independently checks that session before showing account access.

Closing Safari or the App window is not logout. The extension provides logout, switch-account and explicit reconnect controls. Reconnect rechecks a saved session without deleting it or asking for a new login; failed checks remain visible and are not retried automatically. Margina does not import Safari sessions, configure a system proxy or install certificates. See [relay security and verification status](src/relay/README.md).

## Usage

Open a normal HTTP/HTTPS webpage before clicking the Margina toolbar button. Safari's Start Page, browser-owned pages and local file URLs do not support the sidebar; the toolbar explains this limitation without attempting to inject the content script.

### Reading tools

Margina requests persistent access to general HTTP/HTTPS websites and tab metadata so Safari does not ask separately for every site. Safari may still require an initial user confirmation. This permission does not automatically collect every tab: the selection toolbar only prepares a local draft, and **+ → Compare tabs** reads only the pages you select. Context reaches the selected service only after **Send** in API mode or **附到 ChatGPT** in ChatGPT mode.

Select page text to explain, translate, outline or ask a follow-up. The action opens the sidebar and adds a draft; it never sends automatically. Input/password/editable fields do not show the floating menu. After keyboard selection, Tab enters the menu and Escape dismisses it. Disable it under **+ → Custom prompts**, where you can also add, edit, reorder and save up to 12 prompts.

### Page context and multiple annotations

Annotations are the passages you want the model to focus on, not a replacement for the page's context. When annotations are included, Margina sends the readable page body alongside an ordered list of marked passages. If the page context cannot be read, it does not silently send the annotations alone.

Select a passage, then click **＋ 保留並繼續選取** in the sidebar to keep it and select another. You can retain up to 10 passages totaling 16,000 characters and remove each one separately. The current live selection is also included when you send, so the last passage does not need another press of the plus button. Retained annotations are not saved in conversation history. Changing the source page prevents old annotations from being combined with unrelated context.

After a successful API response or acknowledged ChatGPT draft handoff, included annotations disappear from the composer and the page selection is cleared. Failed or stopped requests keep the annotations available for retry. ChatGPT screenshot attachments remain available until explicitly removed because draft acknowledgement does not prove their upload finished.

“Page context” means the currently loaded readable body, not unloaded content or unlimited text. Initial previews are capped at 32,000 characters for the current page and 16,000 for each comparison page. Long documents use the workflow below rather than sending only that preview.

### Long documents

API mode uses one answer request, with no reading-mode selector, preliminary model summaries or automatic request retries. **Context window (tokens)** in API settings defaults to **262,144** and accepts integers from 8,192 to 2,097,152. Its upper/lower arrows and keyboard Up/Down keys double/halve the current value within those bounds; halving an odd integer rounds to the nearest integer. Manual entry remains available, and changes apply only after saving. It includes the question, system instructions, latest 12 history messages and page context, while reserving the smaller of 8,192 tokens or one quarter of the configured window for the answer. Images receive a separate 4,096-token allowance each; their base64 transport size is not counted as text.

If the full readable text fits the estimated input budget, it is included whole. Otherwise, Margina keeps a contiguous section centered on the current highlighted text, or the currently visible page area when there is no highlight, and removes more distant text above/below. At a document edge the remaining allowance is used on the other side. Retained annotations remain separate; they do not override the current viewport as the cropping center. Multiple comparison pages share the remaining request budget. The complete serialized messages are checked again before the sole provider call; if metadata requires further trimming, reselection happens locally. If the question/history/attachments already leave insufficient room, sending stops with an actionable error rather than silently deleting them.

Token usage is a conservative heuristic, not the exact tokenizer of every custom provider: ASCII word/space runs use approximately one token per three characters, ASCII punctuation one, other BMP characters two, and non-BMP characters four. Actual image and output usage also varies by model. Set the window to the chosen model's supported capacity. A provider can still reject a request despite the estimate; Margina does not automatically retry, switch providers or submit extra summary requests. The coverage notice discloses when only a partial body is provided.

Stop cancels the pending request. A changed page invalidates its local snapshot. Snapshots are released on completion/cancellation and never saved in conversation history. The existing two-million-normalized-character and structure/raw-text safeguards remain: larger or unreadable documents fail explicitly. Infinite-scroll content that has not loaded is not collected.

The context-window setting controls API requests only. ChatGPT draft handoff keeps its existing bounded relevant-snapshot behavior and second explicit attach gesture; it does not claim to know the ChatGPT account's remaining context capacity.

Comparison supports three normal tabs in the same window, excluding private tabs. Initial previews remain limited to 16,000 characters per source, but API sends prepare complete locally loaded text when needed. Preview or remove a source before sending; comparison never includes an unselected current page or its remembered selection. API mode refreshes selected pages and fails the entire read if any source cannot be read. ChatGPT draft preparation uses the explicitly attached snapshots.

Answers can include source markers such as `[P1]` or `[T1P1]`. Buttons below an answer locate exact text in the original page and highlight it briefly. Missing or ambiguous text is reported rather than guessed. The page may have changed, and not every model will follow citation instructions. Source mappings are session-only to avoid saving page snapshots; restored history retains the textual markers but not locator buttons.

### API mode

1. Open Margina from the Safari toolbar.
2. Enter an OpenAI-compatible base URL, API key, and model name.
3. Current-page context is always included when sending; optionally include selected text. There is no page-title/status block or context toggle. Freshness checks and read-failure errors remain active. Comparisons use only the explicitly selected pages.
4. Use the **+** menu beside the model name to attach a viewport or element screenshot.
5. Send the request. Margina keeps recent exchanges as conversation context.

The base URL may end at `/v1` or include the complete `/chat/completions` path.

### ChatGPT mode

1. Choose ChatGPT in the mode menu, then use the official login control on first use.
2. Finish sign-in in the native official HTTPS window and press its completion button. Subsequent App launches check the saved account automatically.
3. Prepare the question with current-page context and any optional annotations or screenshot attachments in Margina.
4. Press **附到 ChatGPT** to prepare the ChatGPT draft. This does not submit a model request automatically. Existing ChatGPT drafts are not overwritten.
5. Check the draft and wait for image uploads to finish, then send from ChatGPT itself.

Margina retains attachments after draft acknowledgement because choosing an image is not proof that its upload finished. If handoff fails or times out, the local draft and attachments stay available; inspect ChatGPT before retrying to avoid duplicates. Logout and switch-account controls are in the extension, while reconnect rechecks the current saved login. Installed Safari has verified page-context answers, ordered multi-passage annotations, screenshot upload/recognition, and the sent-image preview.

## Errors and saved conversations

Failures remain visible until dismissed or replaced by another operation. Unavailable storage, corrupt saved settings, malformed API responses, interrupted streams, and failed page reads are not replaced with default settings, empty history, or simulated answers. If requested page context cannot be refreshed, sending stops so the question is not sent with missing context. You can retry, or turn off the context you do not want to include.

Margina's local conversation history stores text only, not screenshots or page snapshots. It retains up to 25 conversations, 100 messages per conversation, 12,000 characters per message, and 32,000 characters per conversation. Retained text is visibly shortened with an ellipsis when needed. API requests use the latest 12 messages as prior context. Starting a new conversation retains older saved conversations. ChatGPT's own conversation history and account features remain controlled by ChatGPT; the relay does not import that history into Margina's local store.

Local API conversations belong to the webpage where they were created. Opening or revisiting a page restores that page's selected conversation; an unseen page starts empty. Query and fragment changes identify separate pages, using a local SHA-256 URL identifier without URL credentials or persisted raw query/fragment values. The identifier never enters a provider prompt. Navigation stops an in-flight API request and clears the previous page's composer context. **New conversation** applies only to the current page; up to 50 recent page selections are remembered. History lists this page's conversations and labels legacy unclassified conversations, which remain available for explicit opening but never restore automatically on unrelated pages.

Necessary protections remain: untrusted content is sanitized, invalid math stays readable as literal text, size and endpoint restrictions apply, and Safari 15.4 keyboard-accessibility support is retained. Glass effects are reduced when the system requests reduced transparency; motion follows the system preference.

The floating sidebar starts at 322px wide with 10px gutters and remains resizable. Its host supplies the glass material behind the isolated extension frame; no screenshot or webpage data is collected to create the visual effect. The toolbar's history button switches between the conversation and a searchable history list without discarding an unsent draft. Click the model name to switch API/ChatGPT modes or open API settings. Escape closes a popover or returns from history.

Page reflow reduces the page's content width, adjusts accessible stylesheet width breakpoints, and moves viewport-fixed controls into the remaining space. The page resizes once when opening or closing; only the sidebar slides during the 250ms animation. Stylesheet and fixed-element discovery starts after the first sidebar paint. Closing restores the page's authored styles. X has an additional column-width adjustment; its secondary information column is hidden when less than 1000px remains for the page. This is not a native browser sidebar: JavaScript viewport measurements, inaccessible cross-origin styles, viewport-sized content and other specialized layouts may still need website-specific handling. See `AGENTS.md` for verification scope.

The toolbar checks that the sidebar actually acknowledged opening or closing. If initialization fails, the toolbar displays `!` and a failure hint instead of silently accepting an empty response.

Safari loads the background bundle as a nonpersistent extension event page, not a service worker. This replaces the worker-startup path that reported an unavailable WebExtension API namespace. Listeners are registered synchronously on each event-page load; settings remain in Keychain and conversation history remains in extension storage, independently of background-page lifetime. This manifest targets Safari rather than Chrome's service-worker-only Manifest V3 background environment; see the [background manifest reference](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background).

### Using multiple tabs

API settings have separate **Validate API Key** and **Save settings** buttons. Validation sends one short, non-streaming request to the endpoint using the key and model currently in the form, without page context, attachments or conversation history. It does not save settings, retries nothing, rejects redirects and times out after 30 seconds. The provider may charge for this request. Save persists settings without calling the provider; required endpoint permission checks remain in place.

On Safari, settings (including the API key and model) are stored in the local macOS Keychain, separately for each Safari profile. Closing Safari does not remove them. The first read imports existing browser settings only if no Keychain settings exist; later reads never fall back to an older browser copy. Keychain errors are reported rather than resetting settings. New saves do not mirror credentials into browser storage. Previously lost values cannot be recovered and must be entered once again. Conversation history remains in browser storage, and ChatGPT login uses its separate existing session vault.

Settings and conversations share a single ordered writer. Changing one option does not replace another tab's newer API URL, key or model; saving a conversation adds its new messages without replacing other conversations. If two tabs continue the same saved conversation, both completed turns are retained in save order.

Open sidebars refresh shared settings automatically and when returning to a page. An outdated settings form reports a conflict instead of overwriting newer values; close and reopen it to review the current values. A request is stopped before sending if its settings have changed. If endpoint permission is missing, open API settings and save to grant it. Old-origin permission cleanup is ordered with settings writes; after a failed save, any newly granted but unused permission can be removed in Safari settings.

After updating the installed app, reload webpages that already had Margina open so every sidebar uses the new saving behavior. Keep only the Applications copy registered for normal use; development build copies are not separate installations to use alongside it.

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

Margina was formerly named SafAI. The public GitHub repository is `jamie950315/Margina`. Updates preserve the existing bundle identifiers, App Group, Keychain records and browser storage, so saved settings, ChatGPT login and conversation history remain associated with the same extension.

```bash
git clone https://github.com/jamie950315/Margina.git Margina
cd Margina
npm ci
npm test
npm run package:safari
open SafariApp/Margina/Margina.xcodeproj
```

In Xcode:

1. Select the same development team for both the `Margina` app and extension targets, with the generated shared App Group available to both.
2. Run the `Margina` scheme.
3. Open **Safari → Settings → Extensions** and enable Margina.
4. Click the Margina toolbar button on a webpage.

For a local installed copy, build the `Margina` scheme in Release configuration with your development team selected, then copy the resulting `Margina.app` to `/Applications` and launch that copy. The App contains both the extension and relay; there is no separate end-user service setup. Keep it installed there so Safari can locate its extension. The containing App remains available when its window closes, and the extension can wake it when needed. Keep one installed copy; a second App copy cannot take over an active relay's account writer.

A development-signed local build is not a notarized public distribution. Developer ID signing and notarization remain separate delivery work; public releases currently provide development-signed previews. Signing material and generated app bundles must not be committed to Git. Do not replace a running App bundle until its active login has been safely preserved and the App has stopped.

To prepare a local universal preview, build both architectures using your own current signing identity and team, then verify/archive it:

```bash
xcodebuild -project SafariApp/Margina/Margina.xcodeproj -scheme Margina \
  -configuration Release -destination 'generic/platform=macOS' \
  -derivedDataPath output/DerivedDataDistribution \
  ARCHS='arm64 x86_64' ONLY_ACTIVE_ARCH=NO CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="$SAFAI_TEAM_ID" CODE_SIGN_IDENTITY="$SAFAI_SIGN_IDENTITY" \
  CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO build
npm run archive:safari
```

The archive command checks embedded resources, aligned versions, both architectures, signatures and the absence of debugging entitlements. It writes a preview ZIP and SHA-256 checksum under `output/releases/` and refuses to overwrite an existing archive. This does not notarize the App or establish completed Safari interaction tests.

## UI framework and design sources

The App icon combines a paper surface, a dark geometric tile and a blue glass margin. `src/assets/icon.svg` is the editable source; checked-in PNGs provide 16–1024 pixel sizes. Native packaging copies those assets directly into the macOS icon slots to preserve the authored silhouette without an additional background or inset.

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
  -project SafariApp/Margina/Margina.xcodeproj \
  -scheme Margina \
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

The source of truth is `src/`. Do not edit bundled JavaScript or copied resources under `dist/` or `SafariApp/Margina/Margina Extension/Resources/` by hand; regenerate them with the provided scripts.

### Local interface and Safari checks

After building, serve `dist/` on loopback and open `/panel.html?demo` to inspect the interface without sending requests. Demo mode must be explicitly requested; missing extension APIs are an error, not a reason to simulate success. Demo history is in-memory only.

For a real Safari check, serve the dedicated fixture:

```bash
python3 -m http.server 8767 --bind 127.0.0.1 --directory tests/fixtures
```

Open `http://127.0.0.1:8767/reading-page.html` in Safari, activate Margina from its toolbar, and check resizing, text selection, screenshot/element capture, attachment preview/removal, and settings. The fixture contains no personal data. A stalled paint or capture must report a failure and restore the panel, not leave it hidden. Browser demo checks do not replace real extension checks or a configured provider request.

The tests include real loopback HTTP requests for successful streaming, incomplete responses, and timeouts, plus executed panel/content-script DOM tests. No real API key is required.

### Verification scope and known limitations

Native Safari checks cover opening, closing and reopening the sidebar, viewport and element screenshots, image previews, settings/history controls, and a saved option synchronizing between two tabs. Concurrent conversation saves and stale API-setting conflicts are covered by isolated tests using synthetic data. These checks do not establish compatibility with every API provider or every supported Safari version.

The installed v0.2.0 build 5 App, then named SafAI, verified direct-native account restoration in Safari, including Safari quit/reopen and explicit reconnect without another login. The real ChatGPT frame answered a synthetic page-context question, read a screenshot sent from the extension, displayed its image preview, and returned two retained passages in their original order. Earlier checks also verified full App cold restart and sandboxed shared-group communication. The image-upload selector is scoped to the active composer form so unrelated camera/media inputs do not block screenshot handoff.

All 328 automated tests, the browser build, unsigned Debug and signed universal Release builds passed. The preview ZIP passed integrity and extracted-signature checks. Real-account logout/switch was not performed merely for testing; synthetic native/Keychain tests cover those transitions while preserving the user's login. Advanced-model selection, account-memory behavior, other Safari versions and Intel runtime behavior remain separate verification scopes.

For local HTTP providers, use `localhost` or `127.0.0.1` without an API key. Safari reports the current IPv6-literal content-security-policy source (`http://[::1]:*`) as invalid, so direct IPv6 loopback connectivity is not validated. Do not broaden HTTP permissions to work around this warning.

## Privacy and security

- Page text, selected text, and screenshots remain local until **Send** in API mode or **附到 ChatGPT** in account mode. Preparing a ChatGPT draft may start image uploads, but does not automatically submit the conversation.
- Margina contains no project-operated analytics or telemetry.
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
