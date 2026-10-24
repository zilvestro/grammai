# Prepare a release

## Build and check

Use Node.js 22+. Install the locked dependencies, run type checking and relevant tests, then build:

```sh
npm ci
npm run typecheck
npm test
npm run test:native
npm run build
QUILL_BROWSER=helium npm run test:experience
QUILL_BROWSER=helium npm run test:onboarding
```

Keep `package.json`, `package-lock.json` and `public/manifest.json` versions in sync. Keep privacy disclosures and source notices aligned with the shipped behavior. Local test profiles, account credentials and research artifacts must never be distributed.

## Package for the Chrome Web Store

```sh
node scripts/package-store.mjs --output /path/to/grammai-VERSION-chrome-store.zip
```

The archive contains exactly one file named `manifest.json`, at its root. German and Romanian license metadata use `licenses/german-data/data-notices.json` and `licenses/romanian-data/data-notices.json`; a second manifest anywhere in the archive causes Chrome Web Store uploads to fail. The packager rejects this before writing a ZIP. The packager includes only the built runtime, strips development source maps and ancillary PNG metadata, inspects nested helper files and the decompressed German pack, and records an audit under `artifacts/`. It rejects private machine markers and common credential patterns. Public license attributions and the support email remain included. The packager refuses to overwrite an existing ZIP.

Extract the resulting ZIP and test that exact artifact in a fresh browser profile:

```sh
GRAMMAI_EXTENSION_PATH=/path/to/extracted/package QUILL_BROWSER=helium npm run test:zero-install
```

The zero-install test blocks native messaging and takes the browser offline while checking both languages. Automated scans reduce mistakes but do not replace reviewing the file list and runtime behavior.

## Publish corresponding source

Publish the exact grammai source, locked dependency manifest, build instructions, GPL license and third-party notices with each binary release. Include the pinned LingoTweaker engine/data source archive in the source release; its commit is recorded in `THIRD_PARTY_NOTICES.md`. Source archives contain no browser profiles, local settings, credentials, research captures, node_modules or generated runtime build. Keep the unmodified upstream archive available alongside the binary.

After committing the release source, create its archive with the pinned upstream source:

```sh
node scripts/package-source.mjs --upstream /path/to/lingotweaker-0.2.8-source.tar.gz --output /path/to/grammai-VERSION-source.zip
```

The source packager verifies the upstream checksum, packages only committed files and records the source commit and upstream provenance. Upload the source ZIP alongside the binary ZIP on the corresponding GitHub release.

The canonical public repository is https://github.com/zilvestro/grammai. Original project code uses GPL-3.0-only. Third-party licenses remain in force; do not strip notices or prevent replacement of the separate German WASM/data files.

## Listing and screenshots

Copy the English listing and permission explanations from [Store listing](store/listing-en.md). Upload `docs/screenshots/*.png`, `docs/store/promo-440x280.png`, `docs/store/promo-1400x560.png` and `public/icons/128.png`. See the official [Store image requirements](https://developer.chrome.com/docs/webstore/images).

`scripts/capture-listing.mjs` reproduces genuine screenshots in an isolated macOS Helium profile. It requires a locally installed, signed-in Codex or Claude Code CLI for the rewrite image and consumes one normal AI request using sample text. It never captures the live personal browser. The promotional tile is code-native HTML in `docs/store/promo.html`.

Use the public policy URL https://github.com/zilvestro/grammai/blob/main/PRIVACY.md. The Chrome Web Store listing is https://chromewebstore.google.com/detail/grammai/coafchipjppaininmkchbiodpcdkkakc. Do not reuse a local development extension ID.

## Before submitting for review

Verify version, requested permissions, public links, privacy disclosures, bundled source notices, helper setup instructions and data handling answers in the Dashboard. Smoke-test selection replacement, Backspace, select-all/delete, undo, regeneration and outside-click dismissal in a supported social editor. Submit as an early release and collect reproducible feedback; broader editor and language coverage remain work in progress.
