import { chromium } from "playwright";
import { expect } from "playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startServer } from "../scripts/serve.mjs";
const browser = process.env.QUILL_BROWSER === "helium" ? "helium" : "chromium";
const extension = path.resolve(process.env.QUILL_EXTENSION_PATH || "dist");
const profile = await mkdtemp(path.join(tmpdir(), "quill-reload-"));
const server = await startServer(0);
const context = await chromium.launchPersistentContext(profile, {
  ...(browser === "helium"
    ? { executablePath: "/Applications/Helium.app/Contents/MacOS/Helium" }
    : { channel: "chromium" }),
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});
const exceptions = [];
const errors = [];
context.on("weberror", (e) => errors.push(e.error().message));
let checks = 0;
const pass = (label) => {
  checks++;
  console.log("PASS", label);
};
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: e }) =>
    exceptions.push(e.exception?.description || e.text),
  );
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if (browser === "helium") await page.waitForTimeout(2500);
  const editor = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  await editor.fill("Is this really neseccary?");
  await editor.click();
  const quill = page.locator("[data-grammai-root]");
  await quill
    .getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    })
    .waitFor();
  pass("real content script checks text before extension reload");
  // Reload the actual extension while keeping the webpage and its old isolated
  // content-script world alive. A page reload would mask the reported bug.
  const manager = await context.newPage();
  await manager.goto("chrome://extensions/");
  await manager
    .getByRole("switch", { name: /^(?:Developer mode|Entwicklermodus)$/ })
    .check();
  await manager
    .locator("extensions-item")
    .filter({ hasText: "grammai" })
    .getByRole("button", { name: /^(?:Reload|Neu laden)$/ })
    .click();
  await page.bringToFront();
  pass("extension is reloaded while the existing draft tab stays open");
  await page.evaluate(() => {
    const oldButton = document
      .querySelector("[data-grammai-root]")
      ?.shadowRoot?.querySelector(".field-launcher");
    oldButton?.click();
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("scroll"));
    document.body.append(document.createElement("span"));
  });
  const updated = "My existing draft survives the extension update.";
  await editor.fill(updated);
  await expect(quill).toHaveCount(0);
  for (let n = 0; n < 3; n++) {
    await page.evaluate(() => {
      document.dispatchEvent(new Event("selectionchange"));
      window.dispatchEvent(new Event("resize"));
      document.body.append(document.createElement("span"));
    });
  }
  await page.waitForTimeout(400); // Let any previously scheduled 150-ms check run.
  assert.equal(await editor.inputValue(), updated);
  assert.deepEqual(exceptions, [], "isolated-world errors after invalidation");
  assert.deepEqual(errors, [], "uncaught page errors after invalidation");
  pass(
    "old listeners, pending timer, observers and UI stop without errors or changing the draft",
  );
  await page.reload();
  await editor.fill("Is this really neseccary?");
  await editor.click();
  await quill
    .getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    })
    .waitFor();
  await quill
    .getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    })
    .click();
  await quill
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert.equal(await editor.inputValue(), "Is this really necessary?");
  assert.deepEqual(exceptions, []);
  assert.deepEqual(errors, []);
  pass("page reload loads the new content script and corrections work again");
  await mkdir("artifacts", { recursive: true });
  const report = {
    browser,
    checks,
    exceptions,
    errors,
    date: new Date().toISOString(),
  };
  await writeFile(
    `artifacts/context-reload-${browser}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`${checks} reload lifecycle checks passed.`);
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
