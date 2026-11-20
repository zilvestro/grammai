import { openAssistant } from "./ui-helpers.mjs";
import { chromium } from "playwright";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { expect } from "playwright/test";
import { startServer } from "../scripts/serve.mjs";
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const profile = await mkdtemp(path.join(tmpdir(), "quill-e2e-"));
const extension = path.resolve("dist");
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
  viewport: { width: 1440, height: 1000 },
});
context.setDefaultTimeout(10000);
const externalRequests = [];
context.on("request", (r) => {
  const u = new URL(r.url());
  if (["http:", "https:"].includes(u.protocol) && u.hostname !== "127.0.0.1")
    externalRequests.push(r.url());
});
const errors = [];
context.on("weberror", (e) => errors.push(e.error().message));
const page = await context.newPage();
let checks = 0;
const pass = (label) => {
  checks++;
  console.log("PASS", label);
};
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).hostname;
  await page.goto(base);
  await page.bringToFront();
  const draftTabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
  );
  const draft = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  await draft.click();
  const quill = page.locator("[data-grammai-root]");
  await quill.locator(".underline").first().waitFor({ state: "attached" });
  await expect
    .poll(
      async () =>
        await quill
          .locator(".underline")
          .evaluateAll(
            (nodes) => new Set(nodes.map((n) => n.dataset.issueId)).size,
          ),
    )
    .toBeGreaterThanOrEqual(5);
  pass("real MV3 extension injects and detects draft issues");
  await openAssistant(page, draft, quill);
  await quill
    .getByRole("button", { name: "Show all suggestions", exact: true })
    .click();
  await quill
    .locator(".list-item")
    .filter({ hasText: "adress" })
    .first()
    .click();
  await quill
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert((await draft.inputValue()).includes("address before Friday"));
  pass("accept replaces the exact textarea span");
  await quill
    .getByRole("button", { name: "Undo last correction", exact: true })
    .click();
  assert((await draft.inputValue()).includes("adress before Friday"));
  pass("explicit undo restores the accepted word");
  await quill
    .getByRole("button", { name: "Show all suggestions", exact: true })
    .click();
  await quill
    .locator(".list-item")
    .filter({ hasText: "adress" })
    .first()
    .click();
  await quill.getByRole("button", { name: "Add to dictionary" }).click();
  await page.waitForTimeout(100);
  assert.equal(
    await quill
      .getByRole("button", {
        name: "Possible spelling mistake: adress",
        exact: true,
      })
      .count(),
    0,
  );
  const stored = await worker.evaluate(
    async () => await chrome.storage.local.get("settings"),
  );
  assert(stored.settings.dictionary.includes("adress"));
  pass("dictionary suppresses the chosen spelling issue");
  // Make a fresh issue and verify dismissal does not mutate the draft.
  await draft.fill("We was happy with the the project.");
  await page.waitForTimeout(500);
  const before = await draft.inputValue();
  await quill.getByRole("button", { name: "Dismiss", exact: true }).click();
  assert.equal(await draft.inputValue(), before);
  pass("dismiss leaves source text intact");
  await quill
    .getByRole("button", { name: "Close assistant", exact: true })
    .click();
  await page.getByText("Try a rich text editor, too").click();
  const rich = page.getByRole("textbox", {
    name: "Rich text editor",
    exact: true,
  });
  await rich.click();
  await openAssistant(page, rich, quill);
  await quill
    .getByRole("button", { name: "Show all suggestions", exact: true })
    .click();
  await quill
    .locator(".list-item")
    .filter({ hasText: "realy" })
    .first()
    .click();
  await quill
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert.equal(await rich.locator("strong").innerText(), "really");
  pass("rich text replacement preserves strong formatting");
  // Extension pages exercise real chrome.storage, rather than a mocked browser API.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator("#dictionary-word").fill("mispelled");
  await options.getByRole("button", { name: "Add word", exact: true }).click();
  await options.reload();
  await options
    .locator("#dictionary-list")
    .getByText("mispelled", { exact: true })
    .waitFor();
  pass("dictionary persists across extension page reload");
  await options.locator("#enabled").uncheck();
  await page.waitForTimeout(100);
  assert.equal(await quill.locator(".underline").count(), 0);
  pass("global pause removes highlights and button");
  await options.locator("#enabled").check();
  await page.waitForTimeout(100);
  await quill.locator(".underline").first().waitFor({ state: "attached" });
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    settings.disabledSites = ["127.0.0.1"];
    await chrome.storage.local.set({ settings });
  });
  await page.waitForTimeout(100);
  assert.equal(await quill.locator(".underline").count(), 0);
  pass("per-site pause immediately stops checking");
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    settings.disabledSites = [];
    await chrome.storage.local.set({ settings });
  });
  await page.waitForTimeout(100);
  // Passwords and account identifiers must not retain visible draft overlays.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "password";
    input.setAttribute("aria-label", "Test password");
    document.body.prepend(input);
  });
  await page.getByRole("textbox", { name: "Test password" }).count();
  await page.locator("input[type=password]").focus();
  assert.equal(await quill.locator(".underline").count(), 0);
  pass("password focus hides writing UI");
  assert.equal(
    await options.evaluate(
      (tabId) => chrome.runtime.sendMessage({ type: "GET_STATE", tabId }),
      draftTabId,
    ),
    null,
  );
  pass("password focus clears side-panel state");
  await page.reload();
  await draft.click();
  await page.waitForTimeout(500);
  await openAssistant(page, draft, quill);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/writing-assistant.png",
    fullPage: true,
  });
  await page.bringToFront();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.bringToFront();
  await panel.getByText("Review suggestions", { exact: true }).waitFor();
  assert((await panel.locator(".card").count()) > 0);
  pass("side panel loads real active draft state");
  await panel.setViewportSize({ width: 380, height: 850 });
  await panel.screenshot({ path: "artifacts/sidepanel.png", fullPage: false });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.setViewportSize({ width: 348, height: 650 });
  await popup.screenshot({ path: "artifacts/popup.png", fullPage: true });
  await options.setViewportSize({ width: 1280, height: 1000 });
  await options.screenshot({ path: "artifacts/options.png", fullPage: true });
  const room = await context.newPage();
  await room.goto(`chrome-extension://${id}/demo.html`);
  await room
    .getByRole("textbox", { name: "Writing editor", exact: true })
    .click();
  await room
    .locator("[data-grammai-root] .underline")
    .first()
    .waitFor({ state: "attached" });
  pass("bundled writing room works without a local server");
  await page.bringToFront();
  await draft.click();
  await page.waitForTimeout(450);
  const stale = await options.evaluate(
    (tabId) => chrome.runtime.sendMessage({ type: "GET_STATE", tabId }),
    draftTabId,
  );
  await draft.evaluate((node) => {
    node.value = "This draft changed without an input event.";
  });
  const result = await options.evaluate(
    (args) => chrome.runtime.sendMessage(args),
    {
      type: "APPLY",
      tabId: draftTabId,
      editorId: stale.editorId,
      version: stale.version,
      issueId: stale.issues[0].id,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(
    await draft.inputValue(),
    "This draft changed without an input event.",
  );
  pass("stale corrections cannot overwrite a changed draft");
  await draft.fill("A valid draft. " + " ".repeat(20000) + "teh");
  await page.waitForTimeout(450);
  const limited = await options.evaluate(
    (tabId) => chrome.runtime.sendMessage({ type: "GET_STATE", tabId }),
    draftTabId,
  );
  assert.equal(limited.limited, true);
  assert.equal(limited.issues.length, 0);
  assert.equal(Object.hasOwn(limited, "text"), false);
  pass(
    "long drafts respect the check limit and whole drafts stay out of snapshots",
  );
  await draft.evaluate((node) => node.remove());
  await page.waitForTimeout(50);
  assert.equal(await quill.locator(".underline").count(), 0);
  assert.equal(
    await options.evaluate(
      (tabId) => chrome.runtime.sendMessage({ type: "GET_STATE", tabId }),
      draftTabId,
    ),
    null,
  );
  pass("removed editors clear overlays and transient draft state");
  assert.deepEqual(externalRequests, []);
  pass("no page text or requests sent to external servers");
  assert.deepEqual(errors, []);
  pass("no uncaught browser errors");
  await writeFile(
    "artifacts/test-result.json",
    JSON.stringify(
      {
        checks,
        errors,
        externalRequests,
        browser: context.browser()?.version() ?? "persistent Chromium",
        date: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`${checks} browser checks passed.`);
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
