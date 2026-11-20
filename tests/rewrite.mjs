import { openAssistant } from "./ui-helpers.mjs";
import { chromium } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startServer } from "../scripts/serve.mjs";
const profile = await mkdtemp(path.join(tmpdir(), "quill-rewrite-e2e-"));
const bridge = path.join(profile, "bridge");
execFileSync(
  process.execPath,
  [
    "scripts/install-native.mjs",
    "--browser-root",
    profile,
    "--install-dir",
    bridge,
  ],
  { stdio: "pipe" },
);
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.QUILL_BROWSER === "helium"
    ? { executablePath: "/Applications/Helium.app/Contents/MacOS/Helium" }
    : { channel: "chromium" }),
  headless: true,
  args: [
    `--disable-extensions-except=${path.resolve("dist")}`,
    `--load-extension=${path.resolve("dist")}`,
  ],
  viewport: { width: 1440, height: 1000 },
});
context.setDefaultTimeout(20000);
const errors = [];
context.on("weberror", (e) => errors.push(e.error().message));
let checks = 0;
const pass = (name) => {
  checks++;
  console.log("PASS", name);
};
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/demo.html`);
  await page.bringToFront();
  const draft = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  const quill = page.locator("[data-grammai-root]");
  await draft.fill("Is this really nessecary?");
  await draft.click();
  await quill
    .getByRole("button", {
      name: "Possible spelling mistake: nessecary",
      exact: true,
    })
    .waitFor();
  await openAssistant(page, draft, quill);
  await quill
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert.equal(await draft.inputValue(), "Is this really necessary?");
  pass("reported question detected and corrected in a real textarea");
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  const status = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: "AI_STATUS" }),
  );
  assert.equal(status.ok, true, JSON.stringify(status));
  assert(status.providers.some((p) => p.available));
  await options
    .getByRole("button", { name: "Test AI connection", exact: true })
    .click();
  await options
    .locator("#ai-status")
    .getByText(/Claude.*detected/i)
    .waitFor();
  pass(
    "browser worker connects to the installed native host and detects both CLIs",
  );
  await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...settings, aiProvider: "claude", aiModel: "" },
    });
  });
  await page.bringToFront();
  await draft.fill("Is this really nessecary?");
  await page.waitForTimeout(500);
  await quill.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await quill.locator(".rewrite-style").selectOption("fix");
  await quill
    .getByRole("button", { name: "Generate rewrite", exact: true })
    .click();
  await quill
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .waitFor({ timeout: 110000 });
  assert.equal(await draft.inputValue(), "Is this really nessecary?");
  assert.match(
    await quill.locator(".rewrite-preview:not(.rewrite-source)").innerText(),
    /necessary/,
  );
  pass("real Claude rewrite returns a preview without changing the draft");
  await quill
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .click();
  assert.equal(await draft.inputValue(), "Is this really necessary?");
  await quill.getByRole("tab", { name: "Suggestions", exact: true }).click();
  await quill
    .getByRole("button", { name: "Undo last correction", exact: true })
    .click();
  assert.equal(await draft.inputValue(), "Is this really nessecary?");
  pass("AI rewrite applies and explicit undo restores original text");
  await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...settings, aiProvider: "codex" },
    });
  });
  const full = "Opening sentence. Is this really nessecary? Closing sentence.";
  const selected = "Is this really nessecary?";
  await draft.fill(full);
  await page.waitForTimeout(500);
  await draft.evaluate(
    (node, { start, length }) => {
      node.focus();
      node.setSelectionRange(start, start + length);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { start: full.indexOf(selected), length: selected.length },
  );
  await quill.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await quill.locator(".rewrite-style").selectOption("fix");
  await quill
    .getByRole("button", { name: "Generate rewrite", exact: true })
    .click();
  await quill
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .waitFor({ timeout: 110000 });
  assert.equal(await quill.locator(".rewrite-source").textContent(), selected);
  await quill
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .click();
  assert.equal(
    await draft.inputValue(),
    "Opening sentence. Is this really necessary? Closing sentence.",
  );
  pass(
    "real Codex rewrites only the selected passage and preserves surrounding text",
  );
  const longDraft =
    "I am writing this message in order to ask if you could please send the report today.";
  await draft.fill(longDraft);
  await page.waitForTimeout(500);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.bringToFront();
  await panel.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await panel.locator(".rewrite-style").selectOption("concise");
  await panel
    .getByRole("button", { name: "Generate rewrite", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .waitFor({ timeout: 110000 });
  const panelResult = await panel
    .locator(".rewrite-preview:not(.rewrite-source)")
    .innerText();
  assert(panelResult.length < longDraft.length);
  assert.equal(await draft.inputValue(), longDraft);
  await panel
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .click();
  assert.equal(await draft.inputValue(), panelResult);
  pass(
    "side panel generates a real concise rewrite and applies it to the matching editor",
  );
  await panel.setViewportSize({ width: 380, height: 850 });
  await mkdir("artifacts", { recursive: true });
  await panel.screenshot({ path: "artifacts/rewrite-sidepanel.png" });
  await panel.close();
  await page.bringToFront();
  // Simulate the Draft.js shape used by social composers, including opt-out attributes for other checkers.
  await page.route("**/social-editor", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Social editor fixture</title></head><body><div id="editor" role="textbox" aria-label="Post text" contenteditable="true" data-gramm="false" style="font:18px/1.6 Arial; margin:100px;min-height:180px;width:600px;outline:1px solid #ddd"><div data-block="true"><span data-text="true">Is this really nessecary?</span></div><div data-block="true"><span data-text="true">Keep this second line.</span></div></div><output id="observed"></output><script>document.querySelector('#editor').addEventListener('input',e=>document.querySelector('#observed').textContent=e.currentTarget.innerText)</script></body></html>`,
    }),
  );
  await page.goto(base + "social-editor");
  const social = page.getByRole("textbox", { name: "Post text", exact: true });
  await social.locator("span").first().click();
  await quill
    .getByRole("button", {
      name: "Possible spelling mistake: nessecary",
      exact: true,
    })
    .waitFor();
  await openAssistant(page, social, quill);
  await quill
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert.match(
    await social.innerText(),
    /Is this really necessary\?\nKeep this second line\./,
  );
  assert.match(await page.locator("#observed").innerText(), /necessary/);
  pass(
    "social/Draft.js-like editor checks despite data-gramm=false and preserves line breaks",
  );
  await quill.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await quill.locator(".rewrite-style").selectOption("friendly");
  await quill
    .getByRole("button", { name: "Generate rewrite", exact: true })
    .click();
  await quill.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    await quill
      .getByRole("button", { name: "Use this rewrite", exact: true })
      .count(),
    0,
  );
  assert.match(await social.innerText(), /Keep this second line/);
  pass("cancelling a native request leaves source text intact");
  // Deterministic slow CLI at the actual native transport boundary tests stale-result handling.
  const fake = path.join(bridge, "slow-claude");
  await writeFile(
    fake,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(bridge, "started"))},'started');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>setTimeout(()=>console.log(JSON.stringify({structured_output:{text:'This result is obsolete.'}})),1000));\n`,
    { mode: 0o700 },
  );
  const config = JSON.parse(
    await readFile(path.join(bridge, "config.json"), "utf8"),
  );
  config.providers.claude = fake;
  await writeFile(path.join(bridge, "config.json"), JSON.stringify(config));
  await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...settings, aiProvider: "claude" },
    });
  });
  await social.fill("A draft before the request.");
  await page.waitForTimeout(500);
  await quill
    .getByRole("button", { name: "Generate rewrite", exact: true })
    .click();
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await readFile(path.join(bridge, "started"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(await readFile(path.join(bridge, "started"), "utf8"), "started");
  await social.fill("The user kept writing.");
  await page.waitForTimeout(1800);
  assert.equal(await social.innerText(), "The user kept writing.");
  assert.equal(
    await quill
      .getByRole("button", { name: "Use this rewrite", exact: true })
      .count(),
    0,
  );
  pass("editing during a slow request discards stale AI output");
  config.providers.claude = "/nonexistent/quill-cli";
  await writeFile(path.join(bridge, "config.json"), JSON.stringify(config));
  await quill
    .getByRole("button", { name: "Generate rewrite", exact: true })
    .click();
  await quill.getByRole("alert").waitFor();
  assert.match(
    await quill.getByRole("alert").innerText(),
    /install|CLI|Claude|Codex|bridge/i,
  );
  assert.equal(await social.innerText(), "The user kept writing.");
  pass("missing CLI produces a useful inline error and preserves source text");
  await social.fill("A complete sentence. ".repeat(650));
  await page.waitForTimeout(500);
  await quill
    .getByRole("button", { name: "Generate rewrite", exact: true })
    .click();
  await quill.getByRole("alert").waitFor();
  assert.match(await quill.getByRole("alert").innerText(), /12,000/);
  pass("oversized rewrites fail before invoking a provider");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/rewrite-error.png" });
  assert.deepEqual(errors, []);
  pass("rewrite UI and native transport have no uncaught browser errors");
  await writeFile(
    `artifacts/rewrite-${process.env.QUILL_BROWSER ?? "chromium"}-test-result.json`,
    JSON.stringify(
      {
        checks,
        errors,
        date: new Date().toISOString(),
        realProviders: ["claude", "codex"],
        browser: process.env.QUILL_BROWSER ?? "chromium",
      },
      null,
      2,
    ),
  );
  console.log(`${checks} rewrite browser checks passed.`);
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
