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
4. Optionally attach a viewport or element screenshot.
5. Send the request. SafAI keeps recent exchanges as conversation context.

The base URL may end at `/v1` or include the complete `/chat/completions` path.

### ChatGPT mode

SafAI copies the structured text context to the system clipboard and opens ChatGPT in a normal first-party tab. Paste the text into ChatGPT. Screenshot attachments can be copied individually from their previews.

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
