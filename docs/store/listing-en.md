# Chrome Web Store listing — English

## Name

grammai – AI Writing Assistant

## Short description (132-character limit)

Free, open-source English, German & Romanian grammar checks. Rewrite and translate with your own Claude Code or Codex account.

## Detailed description

AI writing assistance. Free & open source.

grammai helps you catch mistakes, find clearer wording and translate without leaving the text field. The extension is free. English, German and Romanian spelling and grammar checks run on your device, using engines and dictionaries included in the extension.

CHECK YOUR WRITING, RIGHT WHERE YOU WRITE
• Automatic English, German and Romanian detection, with American or British English spelling.
• Inline spelling and grammar underlines. Hover to highlight, click to review, accept or dismiss.
• Contextual rules and common word-confusion checks.
• Personal dictionary, per-site controls and undo for grammai edits.

BRING YOUR OWN AI
• Rewrite for clarity, brevity or tone, with a preview before applying.
• Save your own named rewrite prompts.
• Translate between English and German or Romanian and replace the selection in one action. Undo restores the original.
• Request an AI context check when you want a broader review.

Optional AI actions use your own installed, signed-in Claude Code or Codex CLI and its account limits. The current local AI connection requires macOS, Node.js 22+ and a one-time helper installation. The built-in guide walks you through it. An AI subscription is not included. Ordinary grammar checks need none of this setup.

A QUIETER WRITING TOOL
The action pill appears only when you select text. Use light or dark mode, keyboard shortcuts and a compact assistant. Supported editors include ordinary text fields, contenteditable fields and tested Draft.js flows such as X-style social editors.

PRIVATE BY DEFAULT
Ordinary checks stay on your device. There are no analytics trackers or automatic text uploads. Only an AI action you request sends text through your chosen provider's CLI. Provider privacy terms and account settings apply. “Send feedback” lets you submit a bug or idea directly in the extension, without a GitHub account. On submission, your message, any screenshots you attach and the extension version go through our Cloudflare feedback endpoint and are published as a public GitHub issue. Email is also available.

FREE, OPEN SOURCE, BUILT WITH THE COMMUNITY
Source code: https://github.com/zilvestro/grammai
Original grammai code is GPL v3. Bug reports, grammar fixes, editor improvements and feature pull requests are welcome.

Sponsored by Affonso: https://affonso.io
The extension displays a static sponsor attribution, without tracking.

EARLY RELEASE
Grammar suggestions can be wrong. Short or mixed-language text may be detected incorrectly. Dedicated Google Docs canvas support and full coverage of every rich-text editor are not available yet. AI translation currently supports English and German. Please share small, anonymized examples so we can improve together.

Support: grammai@zaapp.io
Privacy: https://github.com/zilvestro/grammai/blob/main/PRIVACY.md

grammai is independent and is not affiliated with Grammarly, LanguageTool, Anthropic or OpenAI.

## Dashboard fields

- Category: Productivity (select the appropriate available subcategory in the Dashboard).
- Language: English.
- Homepage: https://github.com/zilvestro/grammai
- Support: https://github.com/zilvestro/grammai/issues
- Privacy policy: https://github.com/zilvestro/grammai/blob/main/PRIVACY.md
- Price: Free. Optional AI uses the user's own provider account; provider charges and limits may apply.
- Chrome Web Store URL: https://chromewebstore.google.com/detail/grammai/coafchipjppaininmkchbiodpcdkkakc

## Visual assets

Upload the five PNGs in `docs/screenshots/` (1280 × 800), the small promotional tile `promo-440x280.png` (440 × 280), the large promotional tile `promo-1400x560.png` (1400 × 560), and `public/icons/128.png` (128 × 128). Both promotional tiles are 24-bit RGB PNGs without alpha. Screenshots show genuine extension UI with synthetic example drafts, not a personal account. The rewrite was generated through a real CLI request.

## Permission explanations / single purpose

Single purpose: assist writing in supported editable fields through local spelling/grammar suggestions and user-requested rewrites, context checks and translation.

- `storage`: save preferences, custom prompts, personal dictionary and paused sites locally.
- `activeTab`: identify and communicate with the active editor tab for assistant actions and per-site controls.
- `sidePanel`: show the writing assistant in Chrome's side panel.
- `nativeMessaging`: optional, explicit AI requests to the local helper and official CLI. Ordinary checking does not use it.
- `offscreen`: run the bundled German and Romanian checking engine in a dedicated worker, without blocking the editor.
- Content scripts on HTTP/HTTPS pages and optional file pages: detect supported editable fields and place suggestions. File access requires the user's browser-level permission. Password and recognizable sensitive account/payment fields are excluded.
- `wasm-unsafe-eval` in extension CSP: execute bundled WebAssembly engines. No remote code is loaded.

## Reviewer notes

Install the submitted ZIP. No account or native helper is needed to test ordinary checks. Open the included Writing room via the extension popup. Try “We need neseccary changes.” and “Ist das wirklich war? Ich habe ein Fehler gemacht.” Wait for the German engine's first initialization, then click an underline and accept a correction. Check typing, deleting, undo and per-site controls.

Optional AI is clearly separate. On macOS, use your own signed-in official CLI and follow All settings → Help & setup → Your AI. The extension contains the helper ZIP; no developer credentials or account are supplied. Grammar remains available when no helper is installed.

All executable code, WASM and language resources are bundled. No remote hosted code is used. The source and dependency notices are public at the repository above. A source archive with the pinned upstream engine/data source accompanies v0.6.6.

## Data disclosure notes (complete Dashboard truthfully)

The extension reads editable text locally. Explicit AI actions transfer selected/active-field text, which can include personal communications and other personal data, to the user's chosen provider through its CLI. Saved dictionary words, prompts, preferences and paused site hostnames stay locally stored. Feedback emails contain only what the user chooses to send. No analytics, activity tracking or sale of data.

These notes describe implementation; they are not a substitute for answering the Dashboard's current data-type questions. Disclose user-provided text / personal communications where the form asks about transferred data. Do not claim that all features are offline or that AI never leaves the device.
