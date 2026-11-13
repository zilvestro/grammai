import { openAssistant, translateFromPanel } from "./ui-helpers.mjs";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startServer } from "../scripts/serve.mjs";

// Exercise real extension/native transport with a deterministic editing provider.
// Provider quality is covered separately by test:rewrite and test:languages.
const profile = await mkdtemp(path.join(tmpdir(), "grammai-ux-"));
const bridge = path.join(profile, "bridge");
execFileSync(process.execPath, [
  "scripts/install-native.mjs",
  "--browser-root",
  profile,
  "--install-dir",
  bridge,
]);
const fake = path.join(bridge, "editing-provider");
const promptLog = path.join(bridge, "last-prompt");
await writeFile(
  fake,
  `#!${process.execPath}
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
 require('node:fs').writeFileSync(${JSON.stringify(promptLog)}, input);
 const translated = input.includes('Translate the entire supplied text');
 const text = translated ? 'We will meet tomorrow in Berlin.' : 'This is my saved writing voice.';
 setTimeout(() => console.log(JSON.stringify({structured_output: {text}})), 550);
});\n`,
  { mode: 0o700 },
);
const config = JSON.parse(
  await readFile(path.join(bridge, "config.json"), "utf8"),
);
config.providers.claude = fake;
await writeFile(path.join(bridge, "config.json"), JSON.stringify(config));
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
  viewport: { width: 1280, height: 900 },
});
context.setDefaultTimeout(15000);
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
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  if (browser === "helium") await page.waitForTimeout(2000);
  await page.bringToFront();
  const editor = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  const q = page.locator("quill-assistant");
  await editor.fill("");
  await editor.hover();
  await expect(q.locator(".field-tools,.field-launcher")).toHaveCount(0);
  await expect(q.locator(".selection-actions")).toBeHidden();
  await editor.fill("We was happy with the the report.");
  await expect(q.locator(".underline").first()).toBeVisible();
  await editor.hover();
  await expect(q.locator(".selection-actions")).toBeHidden();
  pass(
    "idle and empty fields show no pill; ordinary text still has correction underlines",
  );

  await page.evaluate(() => {
    const root = document.createElement("div");
    root.id = "numeric-fixtures";
    root.style.cssText =
      "position:fixed;bottom:8px;left:8px;background:#fff;padding:12px;z-index:10;display:flex;gap:8px";
    root.innerHTML =
      '<input aria-label="Number field" type="number" value="123"><input aria-label="Numeric keyboard" inputmode="numeric" value="123"><input aria-label="Decimal keyboard" inputmode="decimal" value="1.23"><input aria-label="Pattern number" pattern="[0-9]*" value="123"><input aria-label="Digit pattern" pattern="\\d+" value="123"><div contenteditable="true" role="spinbutton" aria-label="Custom number">123</div><textarea aria-label="Numeric area" inputmode="numeric">123</textarea>';
    document.body.append(root);
  });
  for (const label of [
    "Number field",
    "Numeric keyboard",
    "Decimal keyboard",
    "Pattern number",
    "Digit pattern",
    "Custom number",
    "Numeric area",
  ]) {
    const field = page.getByLabel(label, { exact: true });
    await field.focus();
    if (label !== "Number field") await page.keyboard.press("ControlOrMeta+A");
    await expect(q.locator(".selection-actions")).toBeHidden();
    await expect(q.locator(".underline,.panel")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+L");
    await expect(q.locator(".panel")).toHaveCount(0);
  }
  await page.locator("#numeric-fixtures").evaluate((n) => n.remove());
  pass(
    "number inputs, numeric/decimal modes, numeric patterns and custom spinbuttons never activate grammai",
  );

  await editor.fill("   ");
  await editor.press("ControlOrMeta+A");
  await expect(q.locator(".selection-actions")).toBeHidden();
  await editor.fill("We will meet tomorrow.");
  await editor.press("ControlOrMeta+A");
  await expect(q.locator(".selection-actions")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(q.locator(".selection-actions")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+A");
  await expect(q.locator(".selection-actions")).toBeVisible();
  await page.getByRole("heading", { level: 1 }).click();
  await expect(q.locator(".selection-actions")).toBeHidden();
  pass(
    "the pill requires a nonblank active selection and disappears on collapse or outside click",
  );

  const source = "Opening. Wir treffen uns morgen in Berlin. Closing.";
  await editor.fill(source);
  await editor.evaluate((n) => {
    n.setSelectionRange(9, 9 + "Wir treffen uns morgen in Berlin.".length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.keyboard.press("ControlOrMeta+Shift+L");
  await expect(editor).toHaveValue(
    "Opening. We will meet tomorrow in Berlin. Closing.",
  );
  await expect(q.locator(".selection-actions,.panel")).toBeHidden();
  await page.keyboard.press("Alt+KeyZ");
  await expect(editor).toHaveValue(source);
  pass(
    "Translate shortcut replaces only the selected passage; keyboard Undo restores it with no persistent pill",
  );

  await editor.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await expect(
    q.getByRole("tab", { name: "Rewrite", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    q.getByRole("button", { name: "Improve writing", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    q.getByRole("button", { name: "Use this rewrite", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(editor).toHaveValue("This is my saved writing voice.");
  await expect(q.locator(".head .undo-control")).toBeEnabled();
  await expect(
    q.locator(".panel .status,.panel .foot,.panel .theme-toggle"),
  ).toHaveCount(0);
  await q
    .getByRole("button", { name: "Undo last correction", exact: true })
    .click();
  await expect(editor).toHaveValue(source);
  await page.keyboard.press("Escape");
  pass(
    "Rewrite shortcut, style selection, preview, apply and Undo work entirely with the keyboard",
  );

  await editor.fill("We was happy with the the report.");
  await expect(q.locator(".underline").first()).toBeVisible();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(q.locator(".panel.compact")).toBeVisible();
  const first = await q.locator(".card").getAttribute("data-issue-id");
  await page.keyboard.press("Alt+ArrowDown");
  const second = await q.locator(".card").getAttribute("data-issue-id");
  assert.notEqual(first, second);
  await page.keyboard.press("Alt+ArrowUp");
  assert.equal(await q.locator(".card").getAttribute("data-issue-id"), first);
  await page.keyboard.press("Alt+Enter");
  await expect(editor).not.toHaveValue("We was happy with the the report.");
  const after = await editor.inputValue();
  await page.keyboard.press("Alt+Backspace");
  await expect(editor).toHaveValue(after);
  await page.keyboard.press("Escape");
  await expect(q.locator(".panel")).toHaveCount(0);
  pass(
    "corrections support next, previous, accept, dismiss and Escape without changing unrelated text",
  );

  await editor.fill("This is definately ready.");
  await expect(q.locator(".underline").first()).toBeVisible();
  await openAssistant(page, editor, q);
  await expect(q.locator(".score,.overview,.rewrite-hint")).toHaveCount(0);
  await expect(q.locator(".explanation")).toBeAttached();
  await expect(q.locator(".explanation p")).toBeHidden();
  await q.locator(".explanation summary").click();
  await expect(q.locator(".explanation p")).toBeVisible();
  await q.locator(".explanation summary").click();
  await expect(q.locator(".theme-toggle,.foot,.status")).toHaveCount(0);
  await expect(
    q.getByRole("button", { name: "Undo last correction", exact: true }),
  ).toBeDisabled();
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...settings, theme: "dark" },
    });
  });
  await expect(q).toHaveAttribute("data-theme", "dark");
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await expect(options.locator("#appearance")).toHaveValue("dark");
  await expect(options.locator("html")).toHaveAttribute("data-theme", "dark");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.locator("html")).toHaveAttribute("data-theme", "dark");
  const sidebar = await context.newPage();
  await sidebar.goto(`chrome-extension://${id}/sidepanel.html`);
  await expect(sidebar.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.bringToFront();
  await openAssistant(page, editor, q);
  // Collect real extension-rendered surfaces for review in the collaborative browser.
  await mkdir("artifacts", { recursive: true });
  const captures = [];
  async function capture(name) {
    await q
      .locator(".panel")
      .screenshot({ path: `artifacts/grammai-${name}.png` });
    const html = await q.evaluate((n) => n.shadowRoot.innerHTML);
    captures.push({ name, html, theme: await q.getAttribute("data-theme") });
  }
  await capture("suggestions-dark");
  await q.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await capture("rewrite-dark");
  await q.getByRole("tab", { name: "Translate", exact: true }).click();
  await capture("translate-dark");
  await options.locator("#appearance").selectOption("light");
  await expect(q).toHaveAttribute("data-theme", "light");
  await q.getByRole("tab", { name: "Suggestions", exact: true }).click();
  await capture("suggestions-light");
  await q.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await capture("rewrite-light");
  await q.getByRole("tab", { name: "Translate", exact: true }).click();
  await capture("translate-light");
  const chromatic = await q.locator(".panel").evaluate((root) =>
    [...root.querySelectorAll("*")].flatMap((n) =>
      ["color", "backgroundColor", "borderTopColor"].flatMap((p) => {
        const color = getComputedStyle(n)[p];
        const m = color.match(/rgba?\((\d+), (\d+), (\d+)/);
        return m && (+m[1] !== +m[2] || +m[2] !== +m[3])
          ? [{ tag: n.tagName, p, color }]
          : [];
      }),
    ),
  );
  assert.deepEqual(chromatic, []);
  pass(
    "compact widgets use monochrome tokens; explanation text is optional and dark/light preferences synchronize across all surfaces",
  );

  await options.locator("#appearance").selectOption("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(q).toHaveAttribute("data-theme", "dark");
  await options.locator("#appearance").selectOption("light");
  await expect(q).toHaveAttribute("data-theme", "light");
  await options.reload();
  await expect(options.locator("#appearance")).toHaveValue("light");
  pass(
    "System follows OS appearance while an explicit choice persists across reloads",
  );

  await page.bringToFront();
  await openAssistant(page, editor, q);
  await expect(q.locator(".brand-icon")).toBeVisible();
  assert(
    await q
      .locator(".brand-icon")
      .evaluate((n) => n.complete && n.naturalWidth > 0),
  );
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.name, "grammai");
  assert.equal(manifest.version, "0.6.1");
  assert.equal(manifest.icons["128"], "icons/128.png");
  assert(
    await options
      .locator(".brand-icon")
      .evaluate((n) => n.complete && n.naturalWidth > 0),
  );
  assert.equal(
    await options.locator("#keyboard-shortcuts .shortcut-row").count(),
        9,
  );
  pass(
    "the provided logo loads in web-page shadow DOM and extension pages; branding and shortcut help match grammai",
  );

  await page.setViewportSize({ width: 390, height: 780 });
  await openAssistant(page, editor, q);
  await expect
    .poll(async () => {
      const bounds = await q.locator(".panel").boundingBox();
      return !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390;
    })
    .toBe(true);
  pass("the compact assistant remains inside a narrow viewport");

  // Static snapshots use the exact DOM/CSS from the real MV3 run, not a second UI implementation.
  const logo = await readFile("public/brand/icon.png");
  await writeFile("artifacts/grammai-icon.png", logo);
  const card = captures
    .map(
      ({ name, html, theme }) =>
        `<article><h2>${name}</h2><grammai-preview data-theme="${theme}"><template shadowrootmode="open">${html.replaceAll(/chrome-extension:\/\/[^" ]+\/brand\/icon.png/g, "grammai-icon.png")}<style>:host{position:relative!important;display:block!important;inset:auto!important;z-index:auto!important;pointer-events:auto!important}.panel{position:relative!important;left:0!important;top:0!important;max-height:none!important}.underline,.selection-actions,.text-mirror{display:none!important}</style></template></grammai-preview></article>`,
    )
    .join("");
  await writeFile(
    "artifacts/grammai-preview.html",
    `<!doctype html><meta charset="utf-8"><title>grammai · UX review</title><style>body{margin:0;background:#eee;font:14px system-ui;padding:32px}main{display:grid;grid-template-columns:repeat(3,348px);align-items:start;gap:28px;max-width:1100px;margin:auto}h1{max-width:1100px;margin:0 auto 24px}h2{font-size:12px;color:#666;font-weight:500}article{min-width:0}@media(max-width:1100px){main{grid-template-columns:repeat(2,348px)}}</style><h1>grammai</h1><main>${card}</main>`,
  );
  assert.deepEqual(errors, []);
  pass("new UX flows have no uncaught errors");
  await writeFile(
    `artifacts/grammai-ux-${browser}.json`,
    JSON.stringify(
      { browser, checks, errors, date: new Date().toISOString() },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
