import { chromium } from "playwright";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../scripts/serve.mjs";
import { openAssistant } from "./ui-helpers.mjs";

// No helper installation, no Java/LanguageTool, no user account or AI calls.
const profile = await mkdtemp(path.join(tmpdir(), "grammai-zero-install-"));
const server = await startServer(0);
const extension = path.resolve(process.env.GRAMMAI_EXTENSION_PATH || "dist");
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
  viewport: { width: 1280, height: 950 },
});
context.setDefaultTimeout(30000);
const requests = [],
  errors = [],
  timings = [];
context.on("request", (r) => {
  if (/^https?:/.test(r.url())) requests.push(r.url());
});
context.on("weberror", (e) => errors.push(e.error().message));
let checks = 0;
const pass = (name) => {
  console.log("PASS", name);
  checks++;
};
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).hostname;
  await worker.evaluate(() => {
    globalThis.__nativeCalls = 0;
    chrome.runtime.connectNative = () => {
      globalThis.__nativeCalls++;
      throw new Error("No native host in a fresh install");
    };
  });
  const page = context.pages()[0] || (await context.newPage());
  if (browser === "helium") await page.waitForTimeout(2000);
  const base = `http://127.0.0.1:${server.address().port}/`;
  try {
    await page.goto(base);
  } catch (e) {
    if (
      browser !== "helium" ||
      !/ERR_ABORTED|interrupted.*about:blank/.test(String(e))
    )
      throw e;
    await page.waitForTimeout(1000);
    await page.goto(base);
  }
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await page.bringToFront();
  const editor = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  const q = page.locator("[data-grammai-root]");
  await editor.fill("We need neseccary changes.");
  await expect(q.locator(".underline").first()).toBeVisible();
  pass("English checking works immediately in a fresh extension profile");
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
  );
  const state = () =>
    options.evaluate(
      (id) => chrome.runtime.sendMessage({ type: "GET_STATE", tabId: id }),
      tabId,
    );
  // Browser is now offline and all HTTP requests, including loopback, count.
  const initialRequests = requests.length;
  await context.setOffline(true);
  const update = async (text, language = "de") => {
    const before = (await state())?.version ?? 0;
    const start = performance.now();
    await editor.fill(text);
    await expect
      .poll(
        async () => {
          const s = await state();
          return s?.version > before && !s.checking && s.language === language
            ? s
            : null;
        },
        { timeout: 30000, intervals: [50] },
      )
      .toBeTruthy();
    const s = await state();
    assert(!s.checkError, JSON.stringify(s));
    timings.push({
      length: text.length,
      ms: Math.round(performance.now() - start),
    });
    return s;
  };
  let s = await update("Das ist ein Tesst. Ich habe ein Fehler gemacht.");
  assert(
    s.issues.some(
      (i) => i.original === "Tesst" && i.replacements[0] === "Test",
    ),
    JSON.stringify(s),
  );
  assert(
    s.issues.some(
      (i) =>
        i.original === "ein Fehler" && i.replacements[0] === "einen Fehler",
    ),
    JSON.stringify(s),
  );
  assert(await worker.evaluate(() => chrome.offscreen.hasDocument()));
  pass(
    "German spelling and grammar initialize offline from packaged assets, with no native software",
  );
  await openAssistant(page, editor, q);
  const issue = s.issues.find((i) => i.original === "Tesst");
  await q
    .getByRole("button", {
      name: `${issue.shortMessage}: ${issue.original}`,
      exact: true,
    })
    .click();
  await q
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert((await editor.inputValue()).includes("ein Test."));
  await q
    .getByRole("button", { name: "Undo last correction", exact: true })
    .click();
  assert((await editor.inputValue()).includes("ein Tesst."));
  await editor.focus();
  const beforeDeletion = await editor.inputValue();
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  assert.equal((await editor.inputValue()).length, beforeDeletion.length - 1);
  pass(
    "bundled German corrections replace the exact editor span and editing remains available",
  );
  s = await update("Ist das wirklich war? Ich hoffe das du morgen kommst.");
  assert(
    s.issues.some((i) => i.original === "war" && i.replacements[0] === "wahr"),
  );
  assert(s.issues.some((i) => i.replacements[0] === "hoffe, dass"));
  assert(!s.issues.some((i) => i.replacements.some((r) => r.includes("Ist,"))));
  pass(
    "contextual war/wahr and das/dass corrections survive the engine migration without false commas",
  );
  s = await update("Grüße 🌿. Ich habe ein Fehler gemacht.");
  assert.equal(
    s.issues.find((i) => i.original === "ein Fehler").offset,
    "Grüße 🌿. Ich habe ".length,
  );
  pass("actual browser grammar ranges remain exact after umlauts and emoji");
  assert.deepEqual(
    (await update("Wir treffen uns morgen in Berlin.")).issues,
    [],
  );
  s = await update("We need neseccary changes.", "en");
  assert(s.issues.some((i) => i.original === "neseccary"));
  pass(
    "switching language clears stale German issues and restores English checking",
  );
  s = await update("Am mers la şcoală și am scris o propozitie.", "ro");
  assert(
    s.issues.some(
      (i) => i.original === "şcoală" && i.replacements[0] === "școală",
    ),
    JSON.stringify(s),
  );
  assert(
    s.issues.some(
      (i) => i.original === "propozitie" && i.replacements[0] === "propoziție",
    ),
    JSON.stringify(s),
  );
  assert.deepEqual(
    (await update("Aceasta este o propoziție corectă.", "ro")).issues,
    [],
  );
  s = await update("We need neseccary changes.", "en");
  assert(s.issues.some((i) => i.original === "neseccary"));
  pass(
    "Romanian diacritics and legacy cedilla corrections initialize offline and coexist with German and English",
  );
  await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...settings, dictionary: ["Beispil"] },
    });
  });
  assert.deepEqual((await update("Das ist ein Beispil.")).issues, []);
  pass("the bundled checker honors the user's personal dictionary");
  await options.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...settings, dictionary: [] },
    });
  });
  // A discarded offscreen document must recreate cleanly on concurrent requests.
  await worker.evaluate(() => chrome.offscreen.closeDocument());
  const concurrent = await options.evaluate(async () =>
    Promise.all([
      chrome.runtime.sendMessage({
        type: "CHECK_TEXT",
        text: "Das ist ein Beispil.",
      }),
      chrome.runtime.sendMessage({
        type: "CHECK_TEXT",
        text: "Ich habe ein Fehler gemacht.",
      }),
      chrome.runtime.sendMessage({
        type: "CHECK_TEXT",
        text: "This is definately helpful.",
      }),
      chrome.runtime.sendMessage({
        type: "CHECK_TEXT",
        text: "Aceasta este o propozitie gresita.",
      }),
    ]),
  );
  assert(
    concurrent.every((r) => r.ok),
    JSON.stringify(concurrent),
  );
  assert(concurrent[0].issues.some((i) => i.replacements[0] === "Beispiel"));
  assert(
    concurrent[1].issues.some((i) => i.replacements[0] === "einen Fehler"),
  );
  assert(concurrent[2].issues.some((i) => i.replacements[0] === "definitely"));
  assert(concurrent[3].issues.some((i) => i.replacements[0] === "propoziție"));
  pass(
    "offscreen restart and concurrent English/German/Romanian checks work without duplicate initialization",
  );
  const help = await context.newPage();
  await help.goto(`chrome-extension://${id}/help.html`);
  await expect(
    help.getByRole("heading", { name: "Install. Start writing." }),
  ).toBeVisible();
  assert(!(await help.locator("#ai").evaluate((n) => n.open)));
  assert(
    !/brew|Node\.js|install languagetool|install-languages/.test(
      await help.locator("body").innerText(),
    ),
  );
  assert.equal(await help.locator("#german-command").count(), 0);
  await help.evaluate(() =>
    Object.defineProperty(navigator, "platform", { get: () => "Win32" }),
  );
  await help.reload();
  await expect(
    help.getByRole("heading", { name: "Your checker is already included." }),
  ).toBeVisible();
  pass(
    "default help confirms checking is ready and keeps optional AI installation out of the grammar setup",
  );
  assert.equal(await worker.evaluate(() => globalThis.__nativeCalls), 0);
  assert.deepEqual(requests.slice(initialRequests), []);
  assert.deepEqual(errors, []);
  pass(
    "zero native-host calls, zero network requests and zero browser errors during offline checking",
  );
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    `artifacts/zero-install-${browser}.json`,
    JSON.stringify(
      { checks, timings, network: requests.slice(initialRequests), errors },
      null,
      2,
    ),
  );
  console.log(`\n${checks} zero-install checks passed (${browser}).`);
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
