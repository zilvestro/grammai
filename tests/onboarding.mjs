import { chromium } from "playwright";
import { expect } from "playwright/test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { startServer } from "../scripts/serve.mjs";
import { openAssistant } from "./ui-helpers.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "grammai-onboarding-"));
const server = await startServer(0);
const browser = process.env.QUILL_BROWSER === "helium" ? "helium" : "chromium";
const context = await chromium.launchPersistentContext(profile, {
  ...(browser === "helium"
    ? { executablePath: "/Applications/Helium.app/Contents/MacOS/Helium" }
    : { channel: "chromium" }),
  headless: true,
  args: [
    `--disable-extensions-except=${path.resolve("dist")}`,
    `--load-extension=${path.resolve("dist")}`,
  ],
  viewport: { width: 1280, height: 950 },
});
context.setDefaultTimeout(15000);
const errors = [],
  outbound = [];
context.on("weberror", (e) => errors.push(e.error().message));
context.on("request", (r) => {
  const u = new URL(r.url());
  if (["https:", "http:"].includes(u.protocol) && u.hostname !== "127.0.0.1")
    outbound.push(r.url());
});
let clipboardPage;
let checks = 0;
const pass = (name) => {
  checks++;
  console.log("PASS", name);
};
const verifyFeedbackLink = async (link) => {
  const href = await link.getAttribute("href");
  const url = new URL(href);
  assert.equal(url.protocol, "chrome-extension:");
  assert.equal(url.pathname, "/feedback.html");
  assert.equal(url.search, "");
  assert(!href.includes("DRAFT_SENTINEL"));
  assert(!href.includes("127.0.0.1"));
};
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).hostname;
  const version = await worker.evaluate(
    () => chrome.runtime.getManifest().version,
  );
  const page = context.pages()[0] ?? (await context.newPage());
  if (browser === "helium") await page.waitForTimeout(2000);
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
  } catch (error) {
    // Helium's startup new-tab navigation can race its first requested navigation.
    if (
      browser !== "helium" ||
      !/ERR_ABORTED|interrupted by another navigation to "about:blank"/.test(
        String(error),
      )
    )
      throw error;
    await page.waitForTimeout(1000);
    await page.goto(base, { waitUntil: "domcontentloaded" });
  }
  if (browser === "helium") await page.waitForTimeout(2000);
  await page.bringToFront();
  const editor = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  const q = page.locator("[data-grammai-root]");
  await editor.fill("This is definately DRAFT_SENTINEL_987.");
  await expect(q.locator(".underline").first()).toBeVisible();
  await openAssistant(page, editor, q);
  await verifyFeedbackLink(
    q.getByRole("link", { name: "Send feedback", exact: true }),
  );
  await q.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await verifyFeedbackLink(
    q.getByRole("link", { name: "Send feedback", exact: true }),
  );
  await expect(
    q.getByRole("link", { name: "AI settings", exact: true }),
  ).toHaveAttribute("href", `chrome-extension://${id}/help.html#ai`);
  await q.getByRole("tab", { name: "Translate", exact: true }).click();
  await verifyFeedbackLink(
    q.getByRole("link", { name: "Send feedback", exact: true }),
  );
  pass(
    "the full widget exposes feedback in all three tabs, through a private extension page without draft or website data",
  );

  // macOS can fall back to a user-wide host even for a fresh browser profile.
  // Force the missing-host condition before any AI request; no real draft is sent.
  await worker.evaluate(() => {
    globalThis.__originalConnectNative = chrome.runtime.connectNative;
    chrome.runtime.connectNative = () => {
      throw new Error("fixture: helper missing");
    };
    if (chrome.runtime.connectNative === globalThis.__originalConnectNative)
      throw new Error("Could not isolate native messaging");
  });
  await q.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(q.locator(".rewrite-error")).toContainText("setup guide");
  const [help] = await Promise.all([
    context.waitForEvent("page"),
    q.getByRole("link", { name: "Open setup guide", exact: true }).click(),
  ]);
  await help.waitForLoadState("domcontentloaded");
  await expect(help).toHaveURL(`chrome-extension://${id}/help.html#ai`);
  await expect(help.locator("#helper-command")).toContainText(
    `--extension-id ${id}`,
  );
  await expect(help.locator("#helper-command")).not.toContainText(homedir());
  await verifyFeedbackLink(
    help.getByRole("link", { name: "Send feedback", exact: true }),
  );
  pass(
    "missing-helper errors lead to a bundled guide with the actual extension ID rather than developer-machine commands",
  );

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await help.bringToFront();
  clipboardPage = help;
  await help.evaluate(async () => {
    window.__previousClipboard = await navigator.clipboard.readText();
  });
  await help.getByRole("button", { name: "Claude Code", exact: true }).click();
  await expect(help.locator("#provider-command")).toContainText(
    "claude auth login",
  );
  await help
    .getByRole("button", { name: "Copy AI installation and sign-in commands" })
    .click();
  assert.equal(
    await help.evaluate(() => navigator.clipboard.readText()),
    await help.locator("#provider-command").textContent(),
  );
  await help.getByRole("button", { name: "Codex", exact: true }).click();
  await help
    .getByRole("button", { name: "Copy AI installation and sign-in commands" })
    .click();
  assert.equal(
    await help.evaluate(() => navigator.clipboard.readText()),
    "curl -fsSL https://chatgpt.com/codex/install.sh | sh\ncodex login",
  );
  const preference = await worker.evaluate(
    async () =>
      (await chrome.storage.local.get("settings")).settings.aiProvider,
  );
  assert.equal(preference, "codex");
  await help
    .getByRole("button", { name: "Copy grammai helper installation command" })
    .click();
  assert(
    (await help.evaluate(() => navigator.clipboard.readText())).includes(
      `--extension-id ${id}`,
    ),
  );
  pass(
    "real clipboard copies follow the selected provider; provider preference persists and the helper command includes the current ID",
  );

  await help
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(help.locator("#connection-status")).toContainText(
    /not (connected|installed)/,
  );
  await expect(
    help.getByRole("button", { name: "Check connection", exact: true }),
  ).toBeEnabled();
  pass(
    "a missing helper produces actionable connection feedback and permits retry",
  );

  const downloadPromise = help.waitForEvent("download");
  await help
    .getByRole("link", { name: "Download helper", exact: true })
    .click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), `grammai-helper-${version}.zip`);
  const zipPath = path.join(profile, "helper.zip");
  await download.saveAs(zipPath);
  const files = unzipSync(new Uint8Array(await readFile(zipPath)));
  for (const name of [
    "scripts/install-native.mjs",
    "native/host.mjs",
    "native/bridge.mjs",
    "native/grammar.mjs",
    "native/language-server.mjs",
    "dist/manifest.json",
  ])
    assert(files[name], name);
  assert(
    !Object.keys(files).some(
      (n) => n.includes("config.json") || n.includes("node_modules"),
    ),
  );
  for (const bytes of Object.values(files))
    assert(!strFromU8(bytes).includes(homedir()));
  const extracted = path.join(profile, "extracted");
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(extracted, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const install = path.join(profile, "installed-helper");
  execFileSync(
    process.execPath,
    [
      path.join(extracted, "scripts/install-native.mjs"),
      "--extension-id",
      id,
      "--browser-root",
      profile,
      "--install-dir",
      install,
    ],
    { stdio: "pipe" },
  );
  const host = JSON.parse(
    await readFile(
      path.join(profile, "NativeMessagingHosts/com.quill.assistant.json"),
      "utf8",
    ),
  );
  assert.deepEqual(host.allowed_origins, [`chrome-extension://${id}/`]);
  assert(host.path.startsWith(install));
  const providerFixture = path.join(install, "fixture-cli");
  await writeFile(
    providerFixture,
    `#!${process.execPath}\nconsole.log("grammai-helper-fixture 1.0");\n`,
    { mode: 0o700 },
  );
  const configFile = path.join(install, "config.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.providers = { claude: providerFixture, codex: providerFixture };
  await writeFile(configFile, JSON.stringify(config));
  await worker.evaluate(() => {
    chrome.runtime.connectNative = globalThis.__originalConnectNative;
    delete globalThis.__originalConnectNative;
  });
  await help
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(help.locator("#connection-status")).toContainText(
    "Helper connected.",
  );
  await expect(help.locator("#connection-status")).toContainText("found");
  const connectedStatus = await help.evaluate(() =>
    chrome.runtime.sendMessage({ type: "AI_STATUS" }),
  );
  assert(
    connectedStatus.providers.every(
      (provider) => provider.version === "grammai-helper-fixture 1.0",
    ),
    JSON.stringify(connectedStatus),
  );
  pass(
    "the downloadable helper installs from its extracted package into an isolated profile and connects to the same extension without a repository checkout",
  );

  // An existing installation must never look like it needs installing again.
  await help.reload();
  await expect(help.locator("#connection-status")).toContainText(
    "Helper connected.",
  );
  await expect(help.locator("#ai-installation")).toBeHidden();
  await expect(help.locator("#helper")).toBeHidden();
  await expect(help.locator("#prepare-step")).toBeHidden();
  await help
    .getByRole("button", { name: "Show setup instructions", exact: true })
    .click();
  await expect(help.locator("#helper")).toBeVisible();
  await help
    .getByRole("button", { name: "Hide setup instructions", exact: true })
    .click();
  await expect(help.locator("#ai-installation")).toBeHidden();
  pass(
    "AI help automatically recognizes the installed helper and CLIs, hides installation steps, and permits explicit repair instructions",
  );

  // A missing second CLI needs only that provider's instructions, not Node or
  // another helper installation. All changes stay in the temporary profile.
  config.providers = { codex: providerFixture };
  await writeFile(configFile, JSON.stringify(config));
  await help
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(help.locator("#connection-status")).toContainText(
    "Claude Code: not found",
  );
  await help.getByRole("button", { name: "Claude Code", exact: true }).click();
  await expect(help.locator("#provider-step")).toBeVisible();
  await expect(help.locator("#helper")).toBeHidden();
  await expect(help.locator("#prepare-step")).toBeHidden();
  await help.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(help.locator("#ai-installation")).toBeHidden();
  config.providers = { claude: providerFixture, codex: providerFixture };
  await writeFile(configFile, JSON.stringify(config));
  pass(
    "a missing provider reveals only its CLI setup and never asks to reinstall an already connected helper",
  );

  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(
    options.getByRole("link", { name: "Setup guide & copyable commands ↗" }),
  ).toHaveAttribute("href", "help.html#ai");
  await expect(
    popup.getByRole("link", { name: "All settings", exact: true }),
  ).toHaveAttribute("href", "options.html");
  await verifyFeedbackLink(
    options.getByRole("link", { name: "Send feedback", exact: true }),
  );
  const side = await context.newPage();
  await side.goto(`chrome-extension://${id}/sidepanel.html`);
  await verifyFeedbackLink(
    side.getByRole("link", { name: "Send feedback", exact: true }),
  );
  pass(
    "setup and feedback remain discoverable in settings, the popup and the sidebar",
  );

  // Simulate an unsupported client without running any platform-specific installer.
  const unsupported = await context.newPage();
  await unsupported.addInitScript(() =>
    Object.defineProperty(navigator, "platform", { get: () => "Win32" }),
  );
  await unsupported.goto(`chrome-extension://${id}/help.html`);
  await expect(unsupported.locator("#platform-note")).toContainText(
    "currently supports macOS",
  );
  await expect(unsupported.locator("#download-helper")).toBeHidden();
  assert(
    await unsupported
      .locator(".copy-command")
      .evaluateAll((nodes) => nodes.every((n) => n.disabled)),
  );
  pass(
    "Windows/Linux clients see the real support boundary and cannot copy incompatible installer commands",
  );

  await help.bringToFront();
  await help.evaluate(() => window.scrollTo(0, 0));
  await mkdir("artifacts", { recursive: true });
  await help.screenshot({
    path: "artifacts/grammai-help-light.png",
    fullPage: true,
  });
  const themeButton = help.getByRole("button", { name: "Switch to dark mode" });
  await themeButton.click();
  await expect(help.locator("html")).toHaveAttribute("data-theme", "dark");
  await help.screenshot({
    path: "artifacts/grammai-help-dark.png",
    fullPage: true,
  });
  await help.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      help.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await help.screenshot({
    path: "artifacts/grammai-help-mobile.png",
    fullPage: true,
  });
  await help.setViewportSize({ width: 1280, height: 950 });
  await help.getByRole("button", { name: "Switch to light mode" }).click();
  pass(
    "the setup guide follows appearance preferences and stays readable without horizontal overflow on a narrow screen",
  );

  // Save the actual extension-rendered guide for visual inspection in the shared preview.
  let html = await help.content();
  for (const name of ["ui.css", "help.css"])
    html = html.replace(
      new RegExp(`<link[^>]+href="${name}"[^>]*>`),
      `<style>${await readFile("public/" + name, "utf8")}</style>`,
    );
  html = html
    .replace(/<script[^>]*src="help.js"[^>]*><\/script>/g, "")
    .replace('src="brand/icon.png"', 'src="grammai-icon.png"');
  await writeFile("artifacts/grammai-help-preview.html", html);
  await writeFile(
    "artifacts/grammai-icon.png",
    await readFile("public/brand/icon.png"),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
  pass(
    "setup pages and feedback collect no external requests, send no email automatically, and raise no browser errors",
  );
  await writeFile(
    `artifacts/onboarding-${browser}.json`,
    JSON.stringify(
      { browser, checks, errors, outbound, date: new Date().toISOString() },
      null,
      2,
    ),
  );
} finally {
  if (clipboardPage)
    await clipboardPage
      .evaluate(async () => {
        if (typeof window.__previousClipboard === "string")
          await navigator.clipboard.writeText(window.__previousClipboard);
      })
      .catch(() => {});
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
