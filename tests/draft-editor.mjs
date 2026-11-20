import { chromium } from "playwright";
import { expect } from "playwright/test";
import { build } from "esbuild";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  realpath,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startServer } from "../scripts/serve.mjs";
const bundle = await build({
  entryPoints: ["tests/fixtures/draft-editor.jsx"],
  bundle: true,
  format: "iife",
  write: false,
  define: { "process.env.NODE_ENV": '"development"', global: "globalThis" },
});
const css = await readFile("node_modules/draft-js/dist/Draft.css", "utf8");
const extension = await realpath(
  path.resolve(process.env.QUILL_EXTENSION_PATH || "dist"),
);
const profile = await mkdtemp(path.join(tmpdir(), "quill-real-draft-"));
const bridge = path.join(profile, "bridge");
execFileSync(process.execPath, [
  "scripts/install-native.mjs",
  "--extension-path",
  extension,
  "--browser-root",
  profile,
  "--install-dir",
  bridge,
]);
const provider = path.join(bridge, "fixture-claude");
await writeFile(
  provider,
  `#!${process.execPath}\nlet source='';process.stdin.on('data',c=>source+=c);process.stdin.on('end',()=>setTimeout(()=>console.log(JSON.stringify({structured_output:{text:source.includes('Bitte')?'We will meet tomorrow in Berlin.\\nPlease be on time.':'We will meet tomorrow in Berlin.'}})),250));\n`,
  { mode: 0o700 },
);
const config = JSON.parse(
  await readFile(path.join(bridge, "config.json"), "utf8"),
);
config.providers.claude = provider;
await writeFile(path.join(bridge, "config.json"), JSON.stringify(config));
const server = await startServer(0);
const browser = process.env.QUILL_BROWSER === "helium" ? "helium" : "chromium";
const context = await chromium.launchPersistentContext(profile, {
  ...(browser === "helium"
    ? { executablePath: "/Applications/Helium.app/Contents/MacOS/Helium" }
    : { channel: "chromium" }),
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
  viewport: { width: 1400, height: 1000 },
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
  await (context.serviceWorkers()[0] || context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  await page.route("**/draft-fixture.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: bundle.outputFiles[0].text,
    }),
  );
  await page.route("**/draft-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><style>${css}body{font:18px/1.5 Arial;padding:60px}.editor{border:1px solid #ccc;padding:20px;width:650px;min-height:200px}output{display:block;margin-top:30px;white-space:pre-wrap}</style><div id="root"></div><script src="/draft-fixture.js"></script>`,
    }),
  );
  await page.goto(
    `http://127.0.0.1:${server.address().port}/draft-fixture${process.env.QUILL_DRAFT_BASELINE ? "#legacy" : ""}`,
  );
  if (browser === "helium") await page.waitForTimeout(2000);
  const editor = page.getByRole("textbox", {
    name: "Draft editor",
    exact: true,
  });
  const q = page.locator("[data-grammai-root]");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await expect(q.locator(".selection-actions")).toBeVisible();
  await q
    .locator(".selection-actions")
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  await expect(editor).toHaveText("We will meet tomorrow in Berlin.");
  const state = await page.evaluate(() => ({
    model: draftFixture.text(),
    dom: document.querySelector("[contenteditable=true]").innerText,
    selection: draftFixture.selection(),
    logs: draftFixture.logs(),
  }));

  await expect(q.locator(".selection-actions")).toBeHidden();
  assert.equal(
    state.model,
    state.dom,
    "translated DOM must match the actual Draft EditorState",
  );
  pass("translation updates the actual controlled Draft.js model");

  if (!process.env.QUILL_DRAFT_BASELINE) {
    // Undo must be a controlled editor transaction as well.
    await page.keyboard.press("Alt+KeyZ");
    await expect(page.locator("#model")).toHaveText(
      "Wir treffen uns morgen in Berlin.",
    );
    await expect(editor).toHaveText("Wir treffen uns morgen in Berlin.");
    await page.keyboard.press("ControlOrMeta+A");
    await q
      .locator(".selection-actions")
      .getByRole("button", { name: "Translate", exact: true })
      .click();
    await expect(page.locator("#model")).toHaveText(
      "We will meet tomorrow in Berlin.",
    );
    await expect(q.locator(".selection-actions")).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(page.locator("#model")).toHaveText(
      "Wir treffen uns morgen in Berlin.",
    );
    await expect(editor).toHaveText("Wir treffen uns morgen in Berlin.");
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(page.locator("#model")).toHaveText(
      "We will meet tomorrow in Berlin.",
    );
    await expect(editor).toHaveText("We will meet tomorrow in Berlin.");
    pass(
      "Quill Undo and native keyboard Undo/Redo update both Draft state and rendered content",
    );
  }
  await page.keyboard.press("Backspace");
  await expect(editor).toHaveText("We will meet tomorrow in Berlin");
  await expect(page.locator("#model")).toHaveText(
    "We will meet tomorrow in Berlin",
  );
  pass(
    "Backspace deletes from the real Draft.js state immediately after translation",
  );
  await page.keyboard.type("!");
  await expect(editor).toHaveText("We will meet tomorrow in Berlin!");
  await expect(page.locator("#model")).toHaveText(
    "We will meet tomorrow in Berlin!",
  );
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await expect(page.locator("#model")).toHaveText("");
  await page.keyboard.type("Still editable.");
  await expect(editor).toHaveText("Still editable.");
  await expect(page.locator("#model")).toHaveText("Still editable.");
  pass("typing and select-all/delete remain synchronized with Draft.js");
  const source = "Wir treffen uns morgen in Berlin.\nBitte sei pünktlich.";
  await page.evaluate((text) => draftFixture.reset(text), source);
  await expect(page.locator("#model")).toHaveText(source);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await q
    .locator(".selection-actions")
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  await expect(page.locator("#model")).toHaveText(
    "We will meet tomorrow in Berlin.\nPlease be on time.",
  );
  assert.equal(
    await editor.innerText(),
    "We will meet tomorrow in Berlin.\nPlease be on time.",
  );
  await page.keyboard.press("Backspace");
  await expect(page.locator("#model")).toHaveText(
    "We will meet tomorrow in Berlin.\nPlease be on time",
  );
  assert.equal(
    await editor.innerText(),
    "We will meet tomorrow in Berlin.\nPlease be on time",
  );
  pass(
    "multi-paragraph translation retains Draft blocks and remains deletable",
  );

  const full =
    "Opening sentence. Wir treffen uns morgen in Berlin. Closing sentence.";
  await page.evaluate((text) => draftFixture.reset(text), full);
  await expect(page.locator("#model")).toHaveText(full);
  await editor.click();
  await editor.evaluate((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let leaf;
    while ((leaf = walker.nextNode())) {
      const start = leaf.textContent.indexOf(
        "Wir treffen uns morgen in Berlin.",
      );
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(leaf, start);
      range.setEnd(leaf, start + "Wir treffen uns morgen in Berlin.".length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      break;
    }
  });
  await q
    .locator(".selection-actions")
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  const partial =
    "Opening sentence. We will meet tomorrow in Berlin. Closing sentence.";
  await expect(page.locator("#model")).toHaveText(partial);
  await expect(editor).toHaveText(partial);
  await page.keyboard.press("Backspace");
  const deleted =
    "Opening sentence. We will meet tomorrow in Berlin Closing sentence.";
  await expect(page.locator("#model")).toHaveText(deleted);
  await expect(editor).toHaveText(deleted);
  pass(
    "selected-passage translation preserves surrounding content and places a working caret after the replacement",
  );

  await page.evaluate(() => draftFixture.reset("Is this really neseccary?"));
  await expect(page.locator("#model")).toHaveText("Is this really neseccary?");
  await editor.click();
  await q
    .getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    })
    .click();
  await q
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  await expect(page.locator("#model")).toHaveText("Is this really necessary?");
  await expect(editor).toHaveText("Is this really necessary?");
  await page.keyboard.press("Backspace");
  await expect(page.locator("#model")).toHaveText("Is this really necessar?");
  await expect(editor).toHaveText("Is this really necessar?");
  pass(
    "ordinary spelling corrections also remain editable in the real controlled editor",
  );

  await page.evaluate(() => draftFixture.reset("This works !"));
  await expect(page.locator("#model")).toHaveText("This works !");
  await editor.click();
  await q.getByRole("button", { name: /^Punctuation spacing:/ }).click();
  await q
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  await expect(page.locator("#model")).toHaveText("This works!");
  await expect(editor).toHaveText("This works!");
  await page.keyboard.press("Backspace");
  await expect(page.locator("#model")).toHaveText("This work!");
  await expect(editor).toHaveText("This work!");
  pass(
    "empty replacements delete through Draft's controlled key command without native DOM mutations",
  );

  await page.evaluate(() => {
    draftFixture.reset("Wir treffen uns morgen in Berlin.");
    draftFixture.blockPastes(true);
  });
  await expect(page.locator("#model")).toHaveText(
    "Wir treffen uns morgen in Berlin.",
  );
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await q
    .locator(".selection-actions")
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  await expect(
    q.getByRole("button", { name: "Use this translation", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#model")).toHaveText(
    "Wir treffen uns morgen in Berlin.",
  );
  await expect(editor).toHaveText("Wir treffen uns morgen in Berlin.");
  await q.getByRole("button", { name: "Close assistant", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await expect(page.locator("#model")).toHaveText("");
  await expect(editor).toHaveText("");
  await page.keyboard.type("Still editable.");
  await expect(page.locator("#model")).toHaveText("Still editable.");
  await expect(editor).toHaveText("Still editable.");
  pass(
    "a rejected controlled paste leaves both model and DOM untouched and the editor stays deletable",
  );
  assert.deepEqual(errors, []);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    `artifacts/real-draft-${browser}${process.env.QUILL_DRAFT_BASELINE ? "-legacy" : ""}.json`,
    JSON.stringify(
      { browser, checks, errors, date: new Date().toISOString() },
      null,
      2,
    ),
  );
} catch (error) {
  console.log("ERRORS", errors);
  for (const page of context.pages())
    console.log(page.url(), await page.locator("body").innerText());
  throw error;
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
