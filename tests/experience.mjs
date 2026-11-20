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
const profile = await mkdtemp(path.join(tmpdir(), "quill-experience-"));
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
  viewport: { width: 1440, height: 1000 },
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
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if (browser === "helium") await page.waitForTimeout(2000);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  const prompts = options.locator("#custom-prompts");
  await prompts.getByLabel("Prompt name", { exact: true }).fill("My voice");
  await prompts
    .getByLabel("Rewrite instructions", { exact: true })
    .fill("Use short, warm sentences. Keep all facts.");
  await prompts
    .getByRole("button", { name: "Save prompt", exact: true })
    .click();
  await expect(
    prompts.getByRole("button", { name: "Edit prompt My voice", exact: true }),
  ).toBeVisible();
  await options.reload();
  await expect(
    prompts.getByRole("button", { name: "Edit prompt My voice", exact: true }),
  ).toBeVisible();
  pass("saved custom prompts persist through a preferences reload");
  await page.bringToFront();
  const draft = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  const q = page.locator("[data-grammai-root]");
  await draft.fill("Opening. This passage needs a new voice. Closing.");
  await expect(q).toBeAttached();
  await draft.evaluate((node) => {
    node.focus();
    node.setSelectionRange(9, 9 + "This passage needs a new voice.".length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(
    q.getByRole("toolbar", { name: "Actions for selected text" }),
  ).toBeVisible();
  await q
    .getByRole("toolbar")
    .getByRole("button", { name: "Rewrite", exact: true })
    .click();
  await q.getByRole("button", { name: "My voice", exact: true }).click();
  await expect(
    q.getByRole("button", { name: "Use this rewrite", exact: true }),
  ).toBeVisible();
  assert.equal(
    await draft.inputValue(),
    "Opening. This passage needs a new voice. Closing.",
  );
  const sent = await readFile(promptLog, "utf8");
  assert.match(sent, /Use short, warm sentences/);
  assert(sent.includes(JSON.stringify("This passage needs a new voice.")));
  await q
    .getByRole("combobox", { name: "Rewrite style" })
    .selectOption("friendly");
  await q
    .getByRole("button", { name: "Generate another version", exact: true })
    .click();
  await expect(
    q.getByRole("button", { name: "Use this rewrite", exact: true }),
  ).toBeVisible();
  const regenerated = await readFile(promptLog, "utf8");
  assert.match(regenerated, /warm, friendly, natural tone/);
  assert(
    regenerated.includes(JSON.stringify("This passage needs a new voice.")),
  );
  await expect(
    q.getByRole("link", { name: "AI settings", exact: true }),
  ).toBeVisible();
  assert.equal(
    await q.getByRole("link", { name: "Connect your AI", exact: true }).count(),
    0,
  );
  pass(
    "generate another version sends the newly selected style, preserves the selected passage and exposes AI settings instead of a connect prompt",
  );
  await q
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .click();
  assert.equal(
    await draft.inputValue(),
    "Opening. This is my saved writing voice. Closing.",
  );
  await draft.focus();
  await page.keyboard.press("Alt+KeyZ");
  assert.equal(
    await draft.inputValue(),
    "Opening. This passage needs a new voice. Closing.",
  );
  pass(
    "selection toolbar runs a saved prompt, previews, applies only the selection and undoes it",
  );
  await openAssistant(page, draft, q);
  await q.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await q.locator(".prompt-details summary").click();
  await q
    .getByRole("button", { name: "Edit prompt My voice", exact: true })
    .click();
  await q.getByLabel("Prompt name", { exact: true }).fill("My updated voice");
  await q
    .getByLabel("Rewrite instructions", { exact: true })
    .fill("Be direct, warm and brief.");
  await q.getByRole("button", { name: "Save prompt", exact: true }).click();
  await expect(
    q.getByRole("button", { name: "My updated voice", exact: true }),
  ).toBeVisible();
  await options.reload();
  await expect(
    prompts.getByRole("button", {
      name: "Edit prompt My updated voice",
      exact: true,
    }),
  ).toBeVisible();
  pass(
    "inline prompt edits are immediately available in settings and quick actions",
  );
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.bringToFront();
  await panel.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await panel
    .getByRole("button", { name: "My updated voice", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Use this rewrite", exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .click();
  await expect(draft).toHaveValue("This is my saved writing voice.");
  await panel
    .getByRole("button", { name: "Undo last correction", exact: true })
    .click();
  await expect(draft).toHaveValue(
    "Opening. This passage needs a new voice. Closing.",
  );
  await panel.close();
  await page.bringToFront();
  pass(
    "sidebar saved prompts and undo reach the matching editor through the background router",
  );
  await q.getByRole("button", { name: "Close assistant", exact: true }).click();
  const original = "Wir treffen uns morgen in Berlin.";
  await draft.fill(original);
  await draft.evaluate((node) => {
    node.setSelectionRange(0, node.value.length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(
    q.getByRole("toolbar", { name: "Actions for selected text" }),
  ).toBeVisible();
  await q
    .getByRole("toolbar")
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  await expect(draft).toHaveValue("We will meet tomorrow in Berlin.");
  await expect(q.locator(".panel")).toHaveCount(0);
  assert(await draft.evaluate((node) => document.activeElement === node));
  await expect(
    q.getByRole("button", { name: "Use this translation", exact: true }),
  ).toHaveCount(0);
  await draft.focus();
  await page.keyboard.press("Alt+KeyZ");
  await expect(draft).toHaveValue(original);
  pass(
    "selection translation replaces directly without a widget, keeps focus and restores the exact original",
  );
  await openAssistant(page, draft, q);
  await translateFromPanel(q);
  await expect(draft).toHaveValue("We will meet tomorrow in Berlin.");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("!");
  await expect(draft).toHaveValue("We will meet tomorrow in Berlin!");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await expect(draft).toHaveValue("");
  await page.keyboard.type(original);
  await expect(draft).toHaveValue(original);
  pass(
    "textarea remains focused and editable: Backspace, typing and select-all/delete work after translation",
  );
  await openAssistant(page, draft, q);
  await translateFromPanel(q);
  await expect(
    q.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await draft.fill("The user kept writing.");
  await page.waitForTimeout(1100);
  await expect(draft).toHaveValue("The user kept writing.");
  pass(
    "a translation completing after a draft change cannot overwrite the new text",
  );
  await draft.evaluate((node) =>
    node.addEventListener("beforeinput", (event) => event.preventDefault(), {
      once: true,
    }),
  );
  await openAssistant(page, draft, q);
  await translateFromPanel(q);
  await expect(q.locator(".panel")).toBeVisible();
  await expect(
    q.getByRole("button", { name: "Use this translation", exact: true }),
  ).toBeVisible();
  await expect(draft).toHaveValue("The user kept writing.");
  await q
    .getByRole("button", { name: "Use this translation", exact: true })
    .click();
  await expect(draft).toHaveValue("We will meet tomorrow in Berlin.");
  await draft.focus();
  await page.keyboard.press("Alt+KeyZ");
  await expect(draft).toHaveValue("The user kept writing.");
  pass(
    "editors rejecting a replacement open the translation preview for review and retry",
  );
  await openAssistant(page, draft, q);
  await q.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await q.locator(".prompt-details summary").click();
  await q
    .getByRole("button", {
      name: "Delete prompt My updated voice",
      exact: true,
    })
    .click();
  await expect(
    q.getByRole("button", { name: "My updated voice", exact: true }),
  ).toHaveCount(0);
  await options.reload();
  await expect(
    prompts.getByRole("button", {
      name: "Edit prompt My updated voice",
      exact: true,
    }),
  ).toHaveCount(0);
  pass("deleting a saved prompt removes it from all surfaces");
  await q.getByRole("button", { name: "Close assistant", exact: true }).click();
  await draft.fill("Ist das wirklich war?");
  const word = q.getByRole("button", {
    name: "Wortverwechslung im Kontext: war",
    exact: true,
  });
  await word.waitFor();
  await word.click();
  await expect(q.locator(".panel.compact")).toBeVisible();
  assert((await q.locator(".panel").boundingBox()).height < 360);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: `artifacts/context-card-${browser}.png` });
  pass("contextual word fixes use a compact card at the actual error");
  await q
    .getByRole("button", { name: "All 1 suggestions", exact: true })
    .click();
  await q.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await page.screenshot({ path: `artifacts/rewrite-actions-${browser}.png` });
  await q.getByRole("button", { name: "Close assistant", exact: true }).click();
  await page.evaluate(() => {
    const social = document.createElement("div");
    social.id = "social-translation";
    social.contentEditable = "true";
    social.setAttribute("role", "textbox");
    social.setAttribute("aria-label", "Social translation editor");
    social.setAttribute("data-gramm", "false");
    social.style.cssText =
      "font:20px/1.5 Arial;width:500px;min-height:100px;margin:50px;padding:16px;border:1px solid #ddd";
    social.innerHTML =
      '<div data-block="true"><span data-text="true"><b>Wir treffen uns</b></span><span data-text="true"> morgen in Berlin.</span></div>';
    const output = document.createElement("output");
    output.id = "social-observed";
    social.addEventListener(
      "input",
      () => (output.textContent = social.innerText),
    );
    document.body.prepend(social, output);
  });
  const social = page.getByRole("textbox", {
    name: "Social translation editor",
    exact: true,
  });
  await social.click();
  await page.keyboard.press("ControlOrMeta+A");
  await expect(q.locator(".selection-actions")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+C");
  await expect(q.locator(".selection-actions")).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ControlOrMeta+A");
  await expect(q.locator(".selection-actions")).toBeVisible();
  pass(
    "copying all text dismisses selection actions until a new selection is made",
  );
  await q
    .locator(".selection-actions")
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  await expect(q.locator(".panel")).toHaveCount(0);
  await expect(social).toHaveText("We will meet tomorrow in Berlin.");
  await expect(q.locator(".panel")).toHaveCount(0);
  assert(await social.evaluate((node) => document.activeElement === node));
  await expect(page.locator("#social-observed")).toHaveText(
    "We will meet tomorrow in Berlin.",
  );
  await page.keyboard.press("Backspace");
  await page.keyboard.type("!");
  await expect(social).toHaveText("We will meet tomorrow in Berlin!");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await expect(social).toHaveText("");
  await page.keyboard.type("Still editable.");
  await expect(social).toHaveText("Still editable.");
  pass(
    "social/Draft-like translation preserves native input events, focus and caret; deleting, typing and clearing keep working",
  );
  assert.deepEqual(errors, []);
  pass("new editing flows have no uncaught browser errors");
  await writeFile(
    `artifacts/experience-${browser}.json`,
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
