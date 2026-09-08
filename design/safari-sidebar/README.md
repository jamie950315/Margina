# Safari-style sidebar proposal

An isolated, interactive visual proposal for approval. It is **not shipped** by the extension build and does not modify the installed Safari app. All article and conversation content is synthetic. The preview has no extension access, network requests, clipboard writes, or persistence; its CSP blocks connections.

Run `python3 -m http.server 8870 --bind 127.0.0.1 --directory design/safari-sidebar` from the repository root, then open `http://127.0.0.1:8870/`.

## Design direction

Use Safari's compact toolbar and sidebar hierarchy as the reference, not a mobile settings screen. A 322px floating sidebar sits inside the browser window. Its title and actions occupy one row; model and attachment choices live in small menus. Conversation text is left aligned without assistant cards. History replaces the sidebar contents rather than opening another drawer over it.

The base palette is ink `#252627`, secondary text `#62666a`, frosted material `#eff3f3`, field white `#ffffff`, blue focus `#007aff`, and contextual ocean `#477d87`. Typography uses the macOS system family: 14px sidebar title, 12–13px content, 10–11px auxiliary labels. The background illustration exists to test contextual color spill rather than to decorate the assistant.

Apple's [Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/) describes a distinct navigation layer, restrained tinting, contextual color spill on sidebars, and accessibility adaptations. This prototype approximates those relationships with CSS. It is not Apple's native Liquid Glass renderer. A static screenshot cannot prove integration with Safari's isolated extension frame; that work is deliberately deferred until visual approval.

## Review and verification

- Switch light/dark appearance, view history, search its sample titles, open a new conversation, switch the model label, and add/remove illustrative attachments.
- Sending text only displays the question and an explicit preview notice; it does not generate or fake an AI response.
- Automated DOM checks: `node --test tests/design-preview.test.js`.
- Keep browser screenshots under ignored `output/playwright/`.
- Do not replace production panel files or repackage Safari until the user approves the visual direction.
