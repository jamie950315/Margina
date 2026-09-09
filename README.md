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
- ChatGPT handoff that copies the prepared prompt and opens ChatGPT in a first-party tab
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

### ChatGPT handoff

ChatGPT cannot be embedded reliably because `chatgpt.com` blocks cross-origin framing and Safari restricts third-party login cookies. SafAI therefore prepares the structured context, copies it, and opens ChatGPT in a normal first-party tab. Screenshots remain available in the panel for copying separately.

### Experimental local relay (not integrated)

An opt-in native local-origin relay prototype is available for development with `npm run relay:preview`. It can display the real anonymous ChatGPT page in a local split-view fixture, but a real test message received a provider rejection. Login, account memory and attachment/context integration are not implemented or verified. **Do not enter credentials or private content.** It does not change the installed extension, import Safari sessions, install certificates, or configure a system proxy. See [the prototype's boundaries and verification](src/relay/README.md).

## Usage

### Reading tools

SafAI requests persistent access to general HTTP/HTTPS websites and tab metadata so Safari does not ask separately for every site. Safari may still require an initial user confirmation. This permission does not automatically collect every tab: the selection toolbar only prepares a draft, and **+ → Compare tabs** reads only the pages you select. Data is sent to the configured AI only after **Send**.

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

ChatGPT handoff supports locally prepared relevant snapshots and asks for a second click to copy them. Full multi-request reading requires an OpenAI-compatible API. New conversations reset to relevant mode to avoid accidental repeated full-reading costs.

Comparison supports three normal tabs in the same window, excluding private tabs. Each source is limited to 16,000 characters. Preview or remove a source before sending; comparison does not include an unselected current page or its remembered selection. API mode refreshes selected pages before sending and fails the entire read if one source cannot be read. ChatGPT handoff copies the attached snapshots.

Answers can include source markers such as `[P1]` or `[T1P1]`. Buttons below an answer locate exact text in the original page and highlight it briefly. Missing or ambiguous text is reported rather than guessed. The page may have changed, and not every model will follow citation instructions. Source mappings are session-only to avoid saving page snapshots; restored history retains the textual markers but not locator buttons.

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

Page reflow reduces the page's content width, adjusts accessible stylesheet width breakpoints, and moves viewport-fixed controls into the remaining space. Closing restores these changes. X has an additional column-width adjustment; its secondary information column is hidden when less than 1000px remains for the page. This is not a native browser sidebar: JavaScript viewport measurements, inaccessible cross-origin styles, viewport-sized content and other specialized layouts may still need website-specific handling. See `AGENTS.md` for verification scope.

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

## UI framework and design sources

The interface retains selected [Puppertino](https://github.com/codedgar/Puppertino) CSS modules under the MIT license as a local control foundation, pinned under `src/vendor/puppertino/`. The license is shipped with the app. The production redesign in `src/panel/apple-theme.css` uses measured AppKit control proportions and Safari toolbar grouping as references: a shared toolbar capsule, a borderless source row, continuous frosted material and a floating composer. System typography, subtle upper-edge highlights and neutral dark surfaces establish hierarchy without nested outlined cards. Detailed page-reading choices live in the model menu; attached-context status and long-reading progress remain visible.

The dark palette uses a `#1e1e1e` opaque background, a `#232426` tinted host, `#28292c` sheets and `#343434` solid controls. Low-opacity upper highlights and a denser host tint keep bright webpages from washing the sidebar into gray. The light palette is independent and unchanged.

This is a Safari-compatible web interpretation, not a native SwiftUI/AppKit Liquid Glass surface. Apple’s [official design resources](https://developer.apple.com/design/resources/) are design assets rather than a drop-in web framework. The project does not use screenshot/WebGL-based refraction, cloned webpage content, remote fonts, or CDN-loaded UI code. Existing controls and state handling remain in place.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run the Node.js test suite. |
| `npm run build` | Build the browser-ready extension into `dist/`. |
| `npm run build:relay` | Build the experimental macOS local relay into `output/relay/`; does not install it. |
| `npm run relay:preview` | Run the isolated relay preview; real account entry remains disabled. |
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
- General HTTP/HTTPS website access and tab metadata permission are requested for reading tools; only explicitly selected contexts are sent. API changes do not revoke the shared website permission.
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
