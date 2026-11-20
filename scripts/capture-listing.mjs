import http from "node:http";
import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { openAssistant } from "../tests/ui-helpers.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "grammai-listing-"));
const screenshotDir = path.resolve("docs/screenshots");
await mkdir(screenshotDir, { recursive: true });
execFileSync(
  process.execPath,
  [
    "scripts/install-native.mjs",
    "--browser-root",
    profile,
    "--install-dir",
    path.join(profile, "helper"),
  ],
  { stdio: "pipe" },
);
const server = http.createServer(async (req, res) => {
  try {
    const file =
      req.url === "/brand/icon.png"
        ? "public/brand/icon.png"
        : req.url?.startsWith("/promo")
          ? "docs/store/promo.html"
          : "docs/showcase.html";
    res.setHeader(
      "Content-Type",
      file.endsWith(".png") ? "image/png" : "text/html;charset=utf-8",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: "/Applications/Helium.app/Contents/MacOS/Helium",
  headless: true,
  args: [
    `--disable-extensions-except=${path.resolve("dist")}`,
    `--load-extension=${path.resolve("dist")}`,
  ],
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
context.setDefaultTimeout(30000);
const errors = [];
context.on("weberror", (e) => errors.push(e.error().message));
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      settings: {
        enabled: true,
        languageMode: "auto",
        theme: "light",
        aiProvider: "codex",
        customPrompts: [
          {
            id: "sample-voice",
            name: "My voice",
            instruction:
              "Use short, warm sentences. Keep the facts and the original language.",
          },
        ],
      },
    });
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.waitForTimeout(2000);
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await page.goto(url);
  } catch (e) {
    if (!/ERR_ABORTED|interrupted/.test(String(e))) throw e;
    await page.goto(url);
  }
  const draft = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  const q = page.locator("[data-grammai-root]");
  const title = async (headline, description) =>
    page.evaluate(
      ({ headline, description }) => {
        document.querySelector("h1").textContent = headline;
        document.querySelector(".intro").textContent = description;
      },
      { headline, description },
    );
  const capture = async (name) => {
    await page.screenshot({
      path: path.join(screenshotDir, name + ".png"),
      animations: "disabled",
    });
    console.log("Captured", name);
  };
  await draft.focus();
  await expect(q.locator(".underline").first()).toBeVisible();
  await openAssistant(page, draft, q);
  await q
    .getByRole("button", { name: "Show all suggestions", exact: true })
    .click();
  await q
    .locator(".list-item")
    .filter({ hasText: "definately" })
    .first()
    .click();
  await capture("01-checking");
  await q.getByRole("button", { name: "Close assistant", exact: true }).click();
  await title(
    "Deutsch? English? Just keep writing.",
    "Automatic language detection. Context-aware rules. No extra grammar setup.",
  );
  await draft.fill(
    "Hallo zusammen,\n\nist das wirklich war? Ich habe ein Fehler gemacht. Das ist ein Beispil.\n\nWir treffen uns morgen in Berlin.",
  );
  await expect(q.locator(".underline").first()).toBeVisible();
  await openAssistant(page, draft, q);
  await q
    .getByRole("button", { name: "Show all suggestions", exact: true })
    .click();
  await q.locator(".list-item").filter({ hasText: "war" }).first().click();
  await capture("02-german");
  await q.getByRole("button", { name: "Close assistant", exact: true }).click();
  await title(
    "Find the words that fit.",
    "Rewrite for clarity, confidence or tone — using the AI account you already have.",
  );
  await draft.fill(
    "Hi team, I just wanted to ask if you could possibly share your feedback on the proposal when you get a chance. It would be really helpful to hear what you think before Friday.",
  );
  await openAssistant(page, draft, q);
  await q.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await q
    .getByRole("button", { name: "More professional", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await q
          .getByRole("button", { name: "Use this rewrite", exact: true })
          .count())
          ? "ready"
          : (await q.locator(".rewrite-error").count())
            ? "error"
            : "loading",
      { timeout: 90000 },
    )
    .not.toBe("loading");
  if (await q.locator(".rewrite-error").count()) {
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({
        settings: { ...settings, aiProvider: "claude" },
      });
    });
    await q
      .getByRole("button", { name: "More professional", exact: true })
      .click();
    await expect(
      q.getByRole("button", { name: "Use this rewrite", exact: true }),
    ).toBeVisible({ timeout: 90000 });
  }
  await capture("03-rewrite");
  await q.getByRole("button", { name: "Discard", exact: true }).click();
  await q.getByRole("button", { name: "Close assistant", exact: true }).click();
  await title(
    "Translate. Replace. Keep going.",
    "English ↔ German, with your own AI. One action replaces the text; Undo brings it back.",
  );
  await draft.fill(
    "Hallo zusammen, wir treffen uns morgen um zehn Uhr in Berlin. Bitte bringt eure Ideen für das neue Projekt mit.",
  );
  await openAssistant(page, draft, q);
  await q.getByRole("tab", { name: "Translate", exact: true }).click();
  await q
    .getByRole("combobox", { name: "Translation language" })
    .selectOption("translate-en");
  await capture("04-translate");
  await q.getByRole("button", { name: "Close assistant", exact: true }).click();
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...settings, theme: "dark" },
    });
  });
  await page.evaluate(() => document.body.classList.add("dark"));
  await title(
    "Your AI. Your writing style.",
    "Keep your own prompts a click away. Light or dark, grammai stays out of your way.",
  );
  await draft.fill(
    "Thanks for taking a look at the project. I would love to hear your thoughts on the next steps.",
  );
  await openAssistant(page, draft, q);
  await q.getByRole("tab", { name: "Rewrite", exact: true }).click();
  await expect(
    q.getByRole("button", { name: "My voice", exact: true }),
  ).toBeVisible();
  await capture("05-your-ai");
  await page.setViewportSize({ width: 440, height: 280 });
  await page.goto(url + "promo");
  await page.waitForFunction(() => window.promoReady === true);
  await page.screenshot({
    path: "docs/store/promo-440x280.png",
    animations: "disabled",
  });

  await page.setViewportSize({ width: 1400, height: 560 });
  await page.goto(url + "promo?size=large");
  await page.waitForFunction(() => window.promoReady === true);
  await page.screenshot({
    path: "docs/store/promo-1400x560.png",
    animations: "disabled",
  });

  if (errors.length)
    throw new Error("Screenshot browser errors: " + JSON.stringify(errors));
  await writeFile(
    "artifacts/listing-capture.json",
    JSON.stringify(
      {
        viewport: { width: 1280, height: 800 },
        screenshots: 5,
        source:
          "Real extension UI, synthetic sample drafts; rewrite generated through the installed CLI. No user browser profile or live page is used.",
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(profile, { recursive: true, force: true });
}
