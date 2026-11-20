import { openAssistant, translateFromPanel } from "./ui-helpers.mjs";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../scripts/serve.mjs";
const profile = await mkdtemp(path.join(tmpdir(), "quill-languages-"));
execFileSync(
  process.execPath,
  [
    "scripts/install-native.mjs",
    "--browser-root",
    profile,
    "--install-dir",
    path.join(profile, "bridge"),
  ],
  { stdio: "pipe" },
);
const server = await startServer(0);
const browser = process.env.QUILL_BROWSER === "helium" ? "helium" : "chromium";
const ext = path.resolve("dist");
const context = await chromium.launchPersistentContext(profile, {
  ...(browser === "helium"
    ? { executablePath: "/Applications/Helium.app/Contents/MacOS/Helium" }
    : { channel: "chromium" }),
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1440, height: 1000 },
});
context.setDefaultTimeout(20000);
const errors = [],
  external = [];
context.on("weberror", (e) => errors.push(e.error().message));
context.on("request", (r) => {
  if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== "127.0.0.1")
    external.push(r.url());
});
let checks = 0;
const pass = (t) => {
  checks++;
  console.log("PASS", t);
};
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await page.bringToFront();
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
  );
  if (browser === "helium") await page.waitForTimeout(2500);
  const state = () =>
    options.evaluate(
      (id) => chrome.runtime.sendMessage({ type: "GET_STATE", tabId: id }),
      tabId,
    );
  const draft = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  const q = page.locator("[data-grammai-root]");
  await draft.click();
  await expect
    .poll(async () => {
      const s = await state();
      return s && !s.checking && !s.checkError;
    })
    .toBeTruthy();
  const update = async (text, language) => {
    const before = (await state()).version;
    const start = performance.now();
    await draft.fill(text);
    await expect
      .poll(
        async () => {
          const s = await state();
          return (
            s?.version > before &&
            !s.checking &&
            !s.checkError &&
            (!language || s.language === language)
          );
        },
        { timeout: 20000, intervals: [10] },
      )
      .toBeTruthy();
    return { state: await state(), ms: performance.now() - start };
  };
  let r = await update("Das ist ein Tesst. Ich habe ein Fehler gemacht.", "de");
  assert(
    r.state.issues.some(
      (i) => i.original === "Tesst" && i.replacements[0] === "Test",
    ),
    JSON.stringify(r.state.issues),
  );
  assert(
    r.state.issues.some(
      (i) =>
        i.original === "ein Fehler" && i.replacements[0] === "einen Fehler",
    ),
  );
  pass(
    "German is auto-detected and both spelling and grammatical agreement are checked locally",
  );
  await openAssistant(page, draft, q);
  await expect(
    q.getByRole("button", { name: "Local · Deutsch", exact: true }),
  ).toBeVisible();
  const spelling = r.state.issues.find((i) => i.original === "Tesst");
  await q
    .getByRole("button", {
      name: `${spelling.shortMessage}: ${spelling.original}`,
      exact: true,
    })
    .click();
  await q
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert((await draft.inputValue()).includes("ein Test."));
  pass("German corrections apply exact spans and show the detected language");
  r = await update("Ist das wirklich war? Ich glaube das er recht hat.", "de");
  assert(
    r.state.issues.some(
      (i) => i.original === "war" && i.replacements[0] === "wahr",
    ),
  );
  assert(
    !r.state.issues.some((i) => i.replacements.some((x) => x.includes("Ist,"))),
  );
  assert(r.state.issues.some((i) => i.replacements[0] === "glaube, dass"));
  pass(
    "contextual word confusion wins over the actual LanguageTool false comma",
  );
  const clean = (await update("Wir treffen uns morgen in Berlin.", "de")).state;
  assert.deepEqual(clean.issues, []);
  r = await update("Is this really neseccary? Or doe you think is good?", "en");
  assert(r.state.issues.some((i) => i.original === "neseccary"));
  assert(r.state.issues.some((i) => i.original === "doe"));
  pass(
    "switching between German and English replaces the entire rule set without stale language errors",
  );
  r = await update("Grüße 🌿. Ich habe ein Fehler gemacht.", "de");
  const grammatical = r.state.issues.find((i) => i.original === "ein Fehler");
  assert(grammatical);
  assert.equal(grammatical.offset, "Grüße 🌿. Ich habe ".length);
  pass("German UTF-16 positions remain correct after umlauts and emoji");
  const times = [];
  const examples = [
    "Das ist ein Beispeil.",
    "Ich habe ein Fehler gemacht.",
    "Wir treffen uns morgen in Berlin.",
    "Das ist ein Tesst.",
  ];
  for (let n = 0; n < 12; n++)
    times.push((await update(examples[n % 4], "de")).ms);
  assert.deepEqual(external, []);
  pass(
    "12 German live updates use the local engine and produce no external browser requests",
  );
  await options.locator("#language-mode").selectOption("de");
  await expect
    .poll(
      async () =>
        await options.evaluate(
          async () =>
            (await chrome.storage.local.get("settings")).settings.languageMode,
        ),
    )
    .toBe("de");
  await options.reload();
  await expect(options.locator("#language-mode")).toHaveValue("de");
  await options.locator("#language-mode").selectOption("auto");
  await page.bringToFront();
  pass("automatic/manual language selection persists in settings");
  const aiTimes = [];
  for (const [provider, text, target, pattern] of [
    [
      "claude",
      "Wir treffen uns morgen um 15 Uhr in Berlin.",
      "en",
      /tomorrow.*(?:3|15).*Berlin/i,
    ],
    [
      "claude",
      "Is this really necessary?",
      "de",
      /(notwendig|nötig|erforderlich)/i,
    ],
  ]) {
    await options.evaluate(async (p) => {
      const { settings = {} } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({
        settings: { ...settings, aiProvider: p, languageMode: "auto" },
      });
    }, provider);
    await update(text);
    await openAssistant(page, draft, q);
    const start = performance.now();
    await translateFromPanel(q);
    await expect
      .poll(() => draft.inputValue(), { timeout: 60000 })
      .not.toBe(text);
    aiTimes.push({ provider, ms: performance.now() - start });
    assert.match(await draft.inputValue(), pattern);
    assert((await state()).canUndo);
    await draft.focus();
    await page.keyboard.press("Alt+KeyZ");
    assert.equal(await draft.inputValue(), text);
  }
  pass(
    "one-click Claude translation replaces both directions directly and undo restores the original",
  );
  await options.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...settings, aiProvider: "codex" },
    });
  });
  const selected = "Wir treffen uns morgen in Berlin.";
  const prefix = "Opening sentence. ";
  const suffix = " Closing sentence.";
  await update(prefix + selected + suffix);
  await draft.evaluate(
    (node, args) => {
      node.focus();
      node.setSelectionRange(args.start, args.start + args.length);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { start: prefix.length, length: selected.length },
  );
  const start = performance.now();
  await translateFromPanel(q);
  await expect
    .poll(() => draft.inputValue(), { timeout: 60000 })
    .not.toBe(prefix + selected + suffix);
  aiTimes.push({ provider: "codex", ms: performance.now() - start });
  const translated = await draft.inputValue();
  assert(translated.startsWith(prefix));
  assert(translated.endsWith(suffix));
  assert.match(translated, /tomorrow/i);
  pass(
    "selected text takes priority; real Codex/Luna translation preserves surrounding text",
  );
  await q
    .getByRole("button", { name: "Undo last correction", exact: true })
    .click();
  assert.equal(await draft.inputValue(), prefix + selected + suffix);
  pass("translation undo restores the original selected passage");
  assert.deepEqual(errors, []);
  pass("language and translation flows have no uncaught browser errors");
  const sorted = [...times].sort((a, b) => a - b);
  const report = {
    browser,
    checks,
    localGerman: {
      samples: times.length,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxMs: sorted.at(-1),
    },
    translations: aiTimes,
    errors,
    date: new Date().toISOString(),
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    `artifacts/languages-translation-${browser}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
