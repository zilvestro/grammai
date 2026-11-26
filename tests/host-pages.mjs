/** Pages whose own CSS or DOM structure used to break the overlay or hide fields. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../scripts/serve.mjs";
const profile = await mkdtemp(path.join(tmpdir(), "quill-host-"));
const server = await startServer(0);
const extension = path.resolve("dist");
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
  viewport: { width: 1200, height: 900 },
});
let checks = 0;
const pass = (t) => {
  checks++;
  console.log("PASS", t);
};
try {
  const page = await context.newPage();
  const fixture = await readFile("tests/fixtures/hostile-page.html", "utf8");
  const url = `http://127.0.0.1:${server.address().port}/hostile`;
  await page.route(url, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture }),
  );
  await page.goto(url);
  const q = page.locator("[data-grammai-root]");
  const mark = (word) =>
    q.getByRole("button", {
      name: `Possible spelling mistake: ${word}`,
      exact: true,
    });
  const overlapsWord = async (word, field) => {
    const a = await mark(word).first().boundingBox();
    const b = await field.boundingBox();
    assert.ok(
      a.x >= b.x &&
        a.x + a.width <= b.x + b.width &&
        a.y >= b.y &&
        a.y <= b.y + b.height,
      `underline for ${word} is inside its field`,
    );
  };

  const plain = page.locator("#plain");
  await plain.click();
  await plain.fill("Is this really neseccary?");
  await mark("neseccary").waitFor();
  pass("a field labelled 'Tell us the title' is checked");
  await overlapsWord("neseccary", plain);

  const state = await page.evaluate(() => {
    const host = document.querySelector("[data-grammai-root]");
    const style = getComputedStyle(host);
    const rect = host.getBoundingClientRect();
    return {
      tag: host.tagName,
      defined: host.matches(":defined"),
      width: rect.width,
      height: rect.height,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      background: style.backgroundColor,
      backdrop: style.backdropFilter,
      bodyOpacity: getComputedStyle(document.body).opacity,
      top: document.elementFromPoint(600, 700)?.tagName,
    };
  });
  assert.equal(state.defined, true);
  assert.equal(state.bodyOpacity, "1");
  pass("the overlay does not trigger :not(:defined) cloaking");
  assert.equal(state.width, 0);
  assert.equal(state.height, 0);
  assert.equal(state.display, "block");
  assert.equal(state.visibility, "visible");
  assert.equal(state.opacity, "1");
  assert.equal(state.background, "rgba(0, 0, 0, 0)");
  assert.equal(state.backdrop, "none");
  assert.notEqual(state.top, "DIV");
  pass("page CSS cannot turn the overlay into a layer covering the page");

  await mark("neseccary").first().click();
  await q.locator(".panel").waitFor({ state: "visible" });
  await q
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("#plain").value === "Is this really necessary?",
  );
  pass("suggestions still apply on the hostile page");
  await page.keyboard.press("Escape");

  const upper = page.locator("#upper");
  await upper.click();
  await page.keyboard.type("Is this really neseccary?");
  await mark("neseccary").waitFor();
  pass('contenteditable="TRUE" is recognised');

  const shadowField = page.locator("#in-shadow");
  await shadowField.click();
  await page.keyboard.type("Is this really neseccary?");
  await mark("neseccary").waitFor();
  await overlapsWord("neseccary", shadowField);
  await mark("neseccary").first().click();
  await q
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#shadow-host")
        .shadowRoot.querySelector("textarea").value ===
      "Is this really necessary?",
  );
  pass("a textarea inside a shadow root is checked and corrected");
  await page.keyboard.press("Escape");

  await page.locator("#open").click();
  const inDialog = page.locator("#in-dialog");
  await inDialog.click();
  await page.keyboard.type("Is this really neseccary?");
  await mark("neseccary").waitFor();
  await overlapsWord("neseccary", inDialog);
  // A real click proves the underline is painted above the modal and not inert.
  await mark("neseccary").first().click({ timeout: 5000 });
  await q
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("#in-dialog").value ===
      "Is this really necessary?",
  );
  pass("a field inside a transformed modal dialog is checked and corrected");
  await page.evaluate(() => document.querySelector("#dialog").close());

  // The supplied LinkedIn fields, dynamically mounted in a framework dialog.
  // Unlike native <dialog>, these overlays implement their own focus boundary.
  for (const [name, html] of [
    [
      "message widget",
      '<div class="msg-form__contenteditable t-14 t-black--light t-normal flex-grow-1 full-height notranslate" contenteditable="true" role="textbox" dir="auto" aria-multiline="true" aria-label="Write a message…"><p><br></p></div>',
    ],
    [
      "connection invitation",
      '<textarea name="message" rows="2" placeholder="Ex: We know each other from…" id="custom-message" class="ember-text-area ember-view connect-button-send-invite__custom-message" minlength="1"></textarea>',
    ],
  ]) {
    await page.evaluate((html) => {
      const overlay = document.createElement("section");
      overlay.id = "framework-dialog";
      overlay.setAttribute("role", "dialog");
      overlay.style.cssText =
        "position:fixed;right:20px;bottom:20px;width:500px;height:350px;background:white;z-index:1000;transform:translateY(-10px)";
      overlay.innerHTML = html;
      const editor = overlay.firstElementChild;
      editor.style.cssText =
        "display:block;width:400px;min-height:150px;margin:20px;font:16px/1.5 Arial";
      document.body.append(overlay);
      const controller = new AbortController();
      document.addEventListener(
        "focusin",
        (event) => {
          if (!overlay.contains(event.target)) editor.focus();
        },
        { signal: controller.signal },
      );
      window.closeFixtureDialog = () => {
        controller.abort();
        overlay.remove();
      };
      editor.focus();
    }, html);
    const field = page
      .locator("#framework-dialog")
      .locator("[contenteditable],textarea");
    await page.keyboard.type("Is this really neseccary?");
    await mark("neseccary").waitFor();
    await overlapsWord("neseccary", field);
    await page.keyboard.press("Control+Shift+K");
    assert.equal(
      await q
        .locator(".rewrite-choice")
        .first()
        .evaluate((el) => el.getRootNode().activeElement === el),
      true,
      `${name}: rewrite controls retain focus inside the dialog`,
    );
    await page.keyboard.press("Escape");
    await mark("neseccary").first().click();
    await q
      .getByRole("button", { name: "Accept suggestion", exact: true })
      .click();
    assert.equal(
      await field.evaluate((el) => el.value ?? el.innerText),
      "Is this really necessary?",
    );
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.closeFixtureDialog());
    pass(
      `${name} supports checking, correction and keyboard controls in a framework dialog`,
    );
  }
  // After a widget closes, the next editor must get a connected overlay again.
  await plain.click();
  await plain.fill("Is this really neseccary?");
  await mark("neseccary").waitFor();
  await overlapsWord("neseccary", plain);
  assert.equal(
    await q.evaluate((el) => el.parentElement === document.body),
    true,
  );
  pass("overlay returns to the page after the widget closes");
  console.log(`${checks} host page checks passed.`);
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
