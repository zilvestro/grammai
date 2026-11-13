# grammai-byok

Fork of [grammai](https://github.com/zilvestro/grammai) with Bring Your Own Key support for custom OpenAI-compatible models.

## Changes

- Settings → Bring your own AI now includes **Custom API** provider
- New fields: API Base URL and API Key stored in chrome.storage
- Custom API rewrites/translations call the OpenAI-compatible endpoint directly from the extension background worker (no local helper needed)
- Test AI connection pings `{base}/models` through the background worker
- Settings UI shows custom fields only when provider is Custom
- Host permissions added for arbitrary OpenAI-compatible endpoints

## Build

```bash
npm ci
npm run build
```

Load unpacked `dist` in chrome://extensions.

## Example

| Field | Value |
| --- | --- |
| Rewrite provider | Custom API |
| API Base URL | `http://localhost:20129/v1` |
| API Key | your key |
| Model | `auto/best-free` |

Press **Test AI connection**. It should report `Model 'auto/best-free' is available.`

## Verified

End-to-end test in headless Chromium with the extension loaded from `dist`:
- Test AI connection returned `Model 'auto/best-free' is available.`
- A real rewrite request through the extension background returned `{"ok":true,"text":"The quick brown fox jumps over the lazy dog","provider":"custom"}`

## License

GPL-3.0-only. Original project by zilvestro.
