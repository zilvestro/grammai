<p align="center">
  <img src="public/brand/icon.png" width="80" height="80" alt="grammai logo" />
</p>
<h1 align="center">grammai</h1>
<p align="center"><strong>AI writing assistance. Free &amp; open source.</strong></p>
<p align="center">Offline English, German and Romanian grammar checks, with rewrites and translation through your own Claude Code or Codex account.</p>
<p align="center"><a href="https://chromewebstore.google.com/detail/grammai/coafchipjppaininmkchbiodpcdkkakc"><img src="docs/assets/chrome-button.svg" width="300" height="48" alt="Get grammai for Chrome" /></a></p>
<p align="center"><a href="https://affonso.io"><img src="public/brand/affonso-mark.svg" width="24" height="24" alt="Affonso logo" /></a><br/>Sponsored by <a href="https://affonso.io"><strong>Affonso</strong></a></p>
<p align="center"><a href="#installation">Get started</a> · <a href="docs/ai-setup.md">Connect your AI</a> · <a href="CONTRIBUTING.md">Contribute</a> · <a href="LICENSE">GPL 3.0</a></p>

![grammai checking a sample draft and suggesting a spelling correction](docs/screenshots/01-checking.png)

grammai is an open-source writing assistant for Chrome and Chromium browsers such as Helium. It checks what you write, highlights issues in place, and lets you apply corrections without leaving the editor.

**The extension is free.** English, German and Romanian spelling and grammar work on your device, without an account or extra software. Optional AI features use your own signed-in Claude Code or Codex CLI. Your provider's access requirements and usage limits apply; grammai does not include an AI subscription.

## A little help, right where you write

- **Spelling and grammar, offline.** English, German and Romanian engines and dictionaries are bundled with the extension.
- **Context matters.** Local grammar rules and targeted word-confusion checks cover constructions such as “Ist das wirklich war?” → “Ist das wirklich wahr?” An optional AI context check handles a broader passage.
- **Corrections in place.** Hover to highlight a marked word, click to review, then accept or dismiss. Undo restores the last grammai edit.
- **Rewrites in your voice.** Improve clarity, shorten a passage, change the tone, or save your own named prompts.
- **Translate and keep writing.** Translate between English and German or Romanian and replace the selection, or the active field, in one action.
- **Quiet by default.** The action pill appears only when you select text. Light and dark modes, keyboard shortcuts and per-site controls are included.

## See it in action

| Automatic German checking                                                          | Rewrites with your own AI                                                                                      |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ![German contextual grammar correction in grammai](docs/screenshots/02-german.png) | ![A professional rewrite preview with apply, discard and regenerate controls](docs/screenshots/03-rewrite.png) |

| English ↔ German translation                                                     | Your prompts, in dark mode                                                             |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| ![grammai's translation controls in an editor](docs/screenshots/04-translate.png) | ![Dark mode rewrite panel with a saved custom prompt](docs/screenshots/05-your-ai.png) |

Screenshots use sample drafts in a separate browser profile. The rewrite shown was generated through the installed AI CLI. They contain no personal browsing session or account data.

## Installation

<a id="chrome-web-store"></a>
Install grammai from the [Chrome Web Store](https://chromewebstore.google.com/detail/grammai/coafchipjppaininmkchbiodpcdkkakc). Ordinary grammar checks need no additional setup.

### Build from source

To build and load the extension for development:

```sh
npm ci
npm run build
```

Use **Node.js 22 or newer** to build the project. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist` directory. Helium uses the same extension management screen.

Open a supported text field and start writing. English, German and Romanian are detected automatically. Grammar checking needs no helper, Java, Homebrew, LanguageTool installation, API key or sign-in. The German and Romanian engines take a few seconds to initialize on their first check.

Language preferences and the English spelling variant are available under **All settings**. After rebuilding an unpacked extension, reload it and the website tabs where you want to use the new version.

### Optional: connect your AI

Rewrites, translation and AI context checks currently use the official Claude Code or Codex CLI through a one-time local helper installation. The helper installer currently supports **macOS**. Open **All settings → Help & setup → Your AI** for the guide and connection check, or read [AI setup](docs/ai-setup.md).

The helper is required for this local CLI connection. A detected CLI is not proof of sign-in or model access; a successful rewrite verifies those. There is no grammai-hosted AI service in this release.

## Keyboard first

| Action                              | macOS             | Windows / Linux   |
| ----------------------------------- | ----------------- | ----------------- |
| Open / close the assistant          | `⌘ ⇧ Y`           | `Ctrl Shift Y`    |
| Open rewrite                        | `⌘ ⇧ K`           | `Ctrl Shift K`    |
| Translate selection or active field | `⌘ ⇧ L`           | `Ctrl Shift L`    |
| Next / previous correction          | `Alt ↓` / `Alt ↑` | `Alt ↓` / `Alt ↑` |
| Accept correction                   | `Alt Enter`       | `Alt Enter`       |
| Dismiss correction                  | `Alt Backspace`   | `Alt Backspace`   |
| Undo the last grammai edit          | `Alt Z`           | `Alt Z`           |
| Close the widget                    | `Esc`             | `Esc`             |

Browser shortcuts can be changed at `chrome://extensions/shortcuts`. Operating system or browser shortcuts may take precedence.

## Privacy

Ordinary checks stay inside your browser. grammai includes no analytics, telemetry or automatic crash uploads. Preferences, personal words, saved prompts and paused website hostnames are stored in local extension storage.

An explicit AI action sends the selected text—or the active field without a selection—to your chosen provider through its CLI. Provider terms and account settings apply. Feedback is sent only when you submit the form; only your message, any screenshots you attach and the extension version are included, and the report is published in our GitHub issue tracker.

Read the [privacy policy](PRIVACY.md) or [data-flow explanation](docs/privacy.md).

## Beta scope

Current support covers textareas, suitable text inputs, standard `contenteditable` fields and tested Draft.js editing flows, including X-style editors. Dedicated Google Docs canvas support and general Shadow DOM, Slate and ProseMirror adapters are not complete.

Language detection can be ambiguous on short or mixed-language text. Grammar coverage is limited, and context suggestions can be wrong. AI translation currently supports English, German and Romanian. This release does not claim full Grammarly or LanguageTool parity.

## Build with us

We want to build grammai with the community. Found a bug? Have an idea for a better editor integration, a grammar fix or a new feature? [Open an issue](https://github.com/zilvestro/grammai/issues) or send a pull request—small improvements are welcome.

Fork this repository, create a branch for your change, and open a pull request against `main`. Explain what changes for users and how you checked it. For larger features, start with an issue so we can agree on scope before you invest time.

[Contributing](CONTRIBUTING.md) covers the project layout, tests and how to report editor issues. [Development](docs/development.md) describes the local engines and native helper. [Release preparation](docs/releasing.md) covers Store packaging and publication assets.

Use **Send feedback** in the popup, assistant, settings or sidebar to report a bug or suggest an idea directly in the extension. You do not need a GitHub account: pressing Send feedback submits your message through our Cloudflare endpoint and creates a public GitHub issue. You can optionally attach up to two screenshots when image storage is available. Your extension version is included; editor text and page URLs are not attached. Email [grammai@zaapp.io](mailto:grammai@zaapp.io) is also available. The same flow supports unpacked GitHub builds and Store installations. Keep private drafts and account credentials out of reports. Maintainers can configure the endpoint using [the feedback deployment guide](docs/feedback.md).

## License

The original grammai code is licensed under **[GNU GPL version 3](LICENSE)** (`GPL-3.0-only`). Bundled engines, dictionaries and other dependencies retain their respective upstream licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).

grammai is an independent project and is not affiliated with Grammarly, LanguageTool, Anthropic or OpenAI.
