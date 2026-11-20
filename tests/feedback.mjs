import { chromium } from "playwright";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../scripts/serve.mjs";
import { openAssistant } from "./ui-helpers.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "grammai-feedback-"));
const extension = path.resolve(process.env.GRAMMAI_EXTENSION_PATH || "dist");
const server = await startServer(0);
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
  viewport: { width: 1280, height: 900 },
});
context.setDefaultTimeout(15000);
const errors = [],
  requests = [];
context.on("weberror", (event) => errors.push(event.error().message));
context.on("request", (request) => {
  if (/^https?:/.test(request.url()) && !request.url().includes("127.0.0.1"))
    requests.push(request.url());
});
const buildManifest = JSON.parse(
  await readFile(path.join(extension, "manifest.json"), "utf8"),
);
const endpoint =
  buildManifest.host_permissions?.[0]?.replace(/\/\*$/, "/v1/feedback") ||
  "https://feedback.grammai.test/v1/feedback";
const reports = [];
const requestOrigins = [];
let failNext = false;
let imagesAvailable = true;
const uploads = [];
// Intercept HTTPS even for production-configured packages: tests must never
// post a synthetic report to the live service or create a public issue.
await context.route("https://**/*", async (route) => {
  if (route.request().url() !== endpoint) return route.abort();
  if (route.request().method() === "GET") {
    // Like the Worker, accept host-permitted GETs without an Origin header.
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ images: imagesAvailable }),
    });
  }
  if (
    route.request().headers()["content-type"]?.startsWith("multipart/form-data")
  ) {
    const raw = route.request().postDataBuffer();
    const form = await new Response(raw, {
      headers: { "Content-Type": route.request().headers()["content-type"] },
    }).formData();
    uploads.push({ form, raw });
    reports.push(
      Object.fromEntries(
        ["kind", "title", "description", "version"].map((key) => [
          key,
          form.get(key),
        ]),
      ),
    );
  } else reports.push(route.request().postDataJSON());
  requestOrigins.push(route.request().headers().origin);
  const fail = failNext;
  failNext = false;
  await route.fulfill({
    status: fail ? 503 : 201,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(
      fail
        ? { error: "Feedback is temporarily unavailable. Please use email." }
        : { number: 42, url: "https://github.com/zilvestro/grammai/issues/42" },
    ),
  });
});
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).hostname;
  const version = await worker.evaluate(
    () => chrome.runtime.getManifest().version,
  );
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const editor = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  const sentinel = "This is definately PRIVATE_DRAFT_SENTINEL_987.";
  await editor.fill(sentinel);
  const assistant = page.locator("[data-grammai-root]");
  await expect(assistant.locator(".underline").first()).toBeVisible();
  await openAssistant(page, editor, assistant);
  const [feedback] = await Promise.all([
    context.waitForEvent("page"),
    assistant.getByRole("link", { name: "Send feedback", exact: true }).click(),
  ]);
  await feedback.waitForLoadState("domcontentloaded");
  await expect(feedback).toHaveURL(`chrome-extension://${id}/feedback.html`);
  await expect(
    feedback.getByRole("heading", { name: "Help improve grammai." }),
  ).toBeVisible();
  assert.equal(await editor.inputValue(), sentinel);
  assert(!(await feedback.content()).includes("PRIVATE_DRAFT_SENTINEL"));
  assert.deepEqual(
    requests,
    [],
    "opening feedback must stay inside the extension",
  );
  console.log(
    "PASS the in-editor link opens bundled feedback without collecting the draft or visiting GitHub",
  );

  for (const filename of [
    "popup.html",
    "options.html",
    "help.html",
    "sidepanel.html",
  ]) {
    const surface = await context.newPage();
    await surface.goto(`chrome-extension://${id}/${filename}`);
    const [opened] = await Promise.all([
      context.waitForEvent("page"),
      surface.getByRole("link", { name: "Send feedback", exact: true }).click(),
    ]);
    await opened.waitForLoadState("domcontentloaded");
    await expect(opened).toHaveURL(`chrome-extension://${id}/feedback.html`);
    await opened.close();
    await surface.close();
  }
  assert.deepEqual(requests, []);
  console.log(
    "PASS feedback opens from the popup, settings, help and sidebar using the current installation ID",
  );

  const send = feedback.getByRole("button", {
    name: "Send feedback",
    exact: true,
  });
  const title = feedback.getByRole("textbox", { name: "Title", exact: true });
  const description = feedback.getByRole("textbox", {
    name: "Description",
    exact: true,
  });
  const configured = await send.isEnabled();
  if (configured) {
    const pageCount = context.pages().length;
    for (const kind of ["bug", "idea"]) {
      await feedback.locator("#feedback-kind").selectOption(kind);
      await title.fill(
        kind === "bug" ? "The underline is offset" : "Add a writing shortcut",
      );
      await description.fill(
        "A synthetic example supplied explicitly in the feedback form.",
      );
      await send.click();
      await expect(feedback.locator("#feedback-success")).toBeVisible();
      assert.equal(
        context.pages().length,
        pageCount,
        "sending must not open GitHub",
      );
      await expect(feedback).toHaveURL(
        `chrome-extension://${id}/feedback.html`,
      );
      await expect(
        feedback.getByRole("link", { name: "View your report" }),
      ).toHaveAttribute(
        "href",
        "https://github.com/zilvestro/grammai/issues/42",
      );
      const report = reports.at(-1);
      assert.deepEqual(Object.keys(report).sort(), [
        "description",
        "kind",
        "title",
        "version",
      ]);
      assert.equal(report.kind, kind);
      assert.equal(report.version, version);
      assert(!JSON.stringify(report).includes("PRIVATE_DRAFT_SENTINEL"));
      assert(!JSON.stringify(report).includes(id));
      await feedback
        .getByRole("button", { name: "Send another report" })
        .click();
    }
    assert.equal(reports.length, 2);
    await title.fill("Keep my report on failure");
    await description.fill(
      "This report must still be editable when the server cannot save it.",
    );
    failNext = true;
    await send.click();
    await expect(feedback.locator("#feedback-status")).toContainText(
      "temporarily unavailable",
    );
    await expect(title).toHaveValue("Keep my report on failure");
    await expect(description).toHaveValue(
      "This report must still be editable when the server cannot save it.",
    );
    await expect(send).toBeEnabled();
    await send.click();
    await expect(feedback.locator("#feedback-success")).toBeVisible();
    await feedback.getByRole("button", { name: "Send another report" }).click();
    assert.equal(reports.length, 4);
    assert(
      requestOrigins.every((origin) => origin === `chrome-extension://${id}`),
    );
    assert(requests.every((url) => url === endpoint));
    console.log(
      "PASS bugs and ideas submit in place with only explicitly supplied fields; failures keep the draft and allow retry",
    );
    await feedback.locator("#feedback-images summary").click();
    const files = feedback.locator("#feedback-files");
    await expect(files).toBeEnabled();
    const png = Buffer.from(
      await feedback.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 8;
        canvas.getContext("2d").fillRect(0, 0, 8, 8);
        return canvas.toDataURL().split(",")[1];
      }),
      "base64",
    );
    const fixture = {
      name: "PRIVATE_ORIGINAL_FILENAME.png",
      mimeType: "image/png",
      buffer: png,
    };
    await files.setInputFiles([fixture, fixture]);
    await expect(feedback.locator("#image-previews img")).toHaveCount(2);
    await files.setInputFiles(fixture);
    await expect(feedback.locator("#image-status")).toContainText("up to 2");
    await feedback.getByRole("button", { name: "Remove screenshot 1" }).click();
    await expect(feedback.locator("#image-previews img")).toHaveCount(1);
    await title.fill("Screenshot attached explicitly");
    await description.fill(
      "This example includes one image selected by the user.",
    );
    failNext = true;
    await send.click();
    await expect(feedback.locator("#feedback-status")).toContainText(
      "temporarily unavailable",
    );
    await expect(feedback.locator("#image-previews img")).toHaveCount(1);
    await send.click();
    await expect(feedback.locator("#feedback-success")).toBeVisible();
    assert.equal(uploads.length, 2);
    const attached = uploads.at(-1).form.getAll("images");
    assert.equal(attached.length, 1);
    assert.equal(attached[0].type, "image/png");
    assert.equal(attached[0].name, "screenshot-1.png");
    assert(
      !uploads.at(-1).raw.includes(Buffer.from("PRIVATE_ORIGINAL_FILENAME")),
    );
    await feedback.getByRole("button", { name: "Send another report" }).click();
    await expect(feedback.locator("#image-previews img")).toHaveCount(0);
    await files.setInputFiles({
      name: "fake.png",
      mimeType: "image/png",
      buffer: Buffer.from("not an image"),
    });
    await expect(feedback.locator("#image-status")).not.toHaveText(
      "Preparing images…",
    );
    await expect(feedback.locator("#image-previews img")).toHaveCount(0);
    await expect(send).toBeEnabled();
    imagesAvailable = false;
    const unavailable = await context.newPage();
    await unavailable.goto(`chrome-extension://${id}/feedback.html`);
    await unavailable.locator("#feedback-images summary").click();
    await expect(unavailable.locator("#image-status")).toContainText(
      "aren't available",
    );
    await expect(unavailable.locator("#feedback-files")).toBeDisabled();
    await expect(unavailable.locator("#send-feedback")).toBeEnabled();
    await unavailable.close();
    imagesAvailable = true;
    await files.setInputFiles(fixture);
    await expect(feedback.locator("#image-previews img")).toHaveCount(1);
    console.log(
      "PASS screenshots preview, remove, submit without original filenames, survive failure and reset; unavailable storage keeps text feedback working",
    );
  } else {
    await expect(feedback.locator("#feedback-status")).toContainText(
      "isn't available in this build",
    );
    assert.deepEqual(requests, []);
    console.log(
      "PASS unconfigured builds explain email fallback without attempting a request",
    );
  }

  const mail = new URL(
    await feedback
      .getByRole("link", { name: "Email grammai@zaapp.io" })
      .getAttribute("href"),
  );
  assert.equal(mail.protocol, "mailto:");
  assert.equal(mail.pathname, "grammai@zaapp.io");
  assert.equal(
    mail.searchParams.get("body"),
    `What could be better?\n\n\n---\ngrammai ${version}\n`,
  );
  await expect(feedback.locator("#github-note")).toContainText("public");
  await expect(feedback.locator("#github-note")).toContainText(
    "No GitHub account needed",
  );
  await expect(
    feedback
      .locator("#github-note")
      .getByRole("link", { name: "our GitHub issue tracker" }),
  ).toHaveAttribute("href", "https://github.com/zilvestro/grammai/issues");
  console.log("PASS public posting is explained and email remains available");

  await mkdir("artifacts", { recursive: true });
  await feedback.screenshot({
    path: "artifacts/feedback-light.png",
    fullPage: true,
  });
  await feedback.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(feedback.locator("html")).toHaveAttribute("data-theme", "dark");
  await feedback.screenshot({
    path: "artifacts/feedback-dark.png",
    fullPage: true,
  });
  await feedback.setViewportSize({ width: 390, height: 844 });
  assert(
    await feedback.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await feedback.screenshot({
    path: "artifacts/feedback-mobile.png",
    fullPage: true,
  });
  await feedback.getByRole("button", { name: "Switch to light mode" }).click();
  await feedback.setViewportSize({ width: 1280, height: 900 });

  let html = await feedback.content();
  // Blob URLs belong to the test browser. Embed previews for the shared page.
  for (const preview of await feedback.locator("#image-previews img").all()) {
    const source = await preview.getAttribute("src");
    const dataUrl = await preview.evaluate(async (img) => {
      const blob = await (await fetch(img.src)).blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    });
    html = html.replace(`src="${source}"`, `src="${dataUrl}"`);
  }
  for (const name of ["ui.css", "feedback.css"])
    html = html.replace(
      new RegExp(`<link[^>]+href="${name}"[^>]*>`),
      `<style>${await readFile(`public/${name}`, "utf8")}</style>`,
    );
  html = html
    .replace(/<script[^>]*src="feedback.js"[^>]*><\/script>/g, "")
    .replace('src="brand/icon.png"', 'src="feedback-icon.png"');
  await writeFile("artifacts/feedback-preview.html", html);
  await writeFile(
    "artifacts/feedback-icon.png",
    await readFile("public/brand/icon.png"),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS feedback follows the theme, fits narrow screens and produces no browser errors",
  );
  console.log(`Feedback checks passed for ${id} (${extension}).`);
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
