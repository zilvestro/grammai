import { chromium } from "playwright";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../scripts/serve.mjs";
const profile = await mkdtemp(path.join(tmpdir(), "quill-word-"));
const server = await startServer(0);
const browser = process.env.QUILL_BROWSER === "helium" ? "helium" : "chromium";
const extension = path.resolve("dist");
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
const errors = [];
context.on("weberror", (e) => errors.push(e.error().message));
let checks = 0;
const pass = (t) => {
  checks++;
  console.log("PASS", t);
};
try {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if (browser === "helium") await page.waitForTimeout(2500);
  const draft = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  const q = page.locator("[data-grammai-root]");
  await draft.fill("Is this really neseccary?");
  await draft.click();
  await q
    .getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    })
    .waitFor();
  const point = async (word, rich = false, index = 0) =>
    page.evaluate(
      ({ word, rich, index }) => {
        const root = rich
          ? document.querySelector("#social")
          : document
              .querySelector("[data-grammai-root]")
              .shadowRoot.querySelector(".text-mirror");
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const at = node.textContent.indexOf(word);
          if (at < 0) continue;
          const r = document.createRange();
          r.setStart(node, at);
          r.setEnd(node, at + word.length);
          const rect = [...r.getClientRects()][index];
          return {
            x: (rect.left + rect.right) / 2,
            y: (rect.top + rect.bottom) / 2,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          };
        }
        throw new Error("Word not found");
      },
      { word, rich, index },
    );
  let p = await point("neseccary");
  const originalCursor = await draft.evaluate((e) => e.style.cursor);
  await page.mouse.move(p.x, p.y);
  await expect(q.locator(".word-highlight")).toHaveCount(1);
  let highlight = await q.locator(".word-highlight").boundingBox();
  assert(highlight.height >= p.bottom - p.top - 1);
  assert(highlight.width >= p.right - p.left - 1);
  assert.equal(
    await draft.evaluate((e) => getComputedStyle(e).cursor),
    "pointer",
  );
  assert.equal(
    await q
      .locator(".word-highlight")
      .evaluate((e) => getComputedStyle(e).pointerEvents),
    "none",
  );
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: `artifacts/word-hover-${browser}.png` });
  pass(
    "hover highlights the complete word with a background and pointer cursor without intercepting selection",
  );
  await page.mouse.move(20, 20);
  await expect(q.locator(".word-highlight")).toHaveCount(0);
  assert.equal(await draft.evaluate((e) => e.style.cursor), originalCursor);
  pass(
    "leaving the word removes its background and restores the editor cursor",
  );
  assert.equal(await q.locator(".bubble").count(), 0);
  await expect(
    q.getByRole("toolbar", { name: "Writing tools", exact: true }),
  ).toBeHidden();
  await page.mouse.move(p.x, p.y);
  await expect(q.locator(".field-tools")).toHaveCount(0);
  await expect(q.locator(".selection-actions")).toBeHidden();
  await draft.press("ControlOrMeta+Shift+Y");
  await expect(q.locator(".panel")).toBeVisible();
  await page
    .getByRole("heading", {
      name: "Good writing starts with a first draft.",
      exact: true,
    })
    .click();
  await expect(q.locator(".panel")).toHaveCount(0);
  pass(
    "idle hover shows only underlines; the assistant opens with its shortcut and closes outside",
  );
  await page.mouse.click(p.x, p.y);
  await expect(q.locator(".card")).toContainText("neseccary→necessary");
  assert.equal(await draft.evaluate((e) => document.activeElement === e), true);
  pass(
    "clicking native word glyphs opens the corresponding suggestion and retains editor focus",
  );
  const plain = await point("really");
  await page.mouse.click(plain.x, plain.y);
  await expect(q.locator(".panel")).toHaveCount(0);
  await page.mouse.click(p.x, p.y);
  const box = await draft.boundingBox();
  await page.mouse.click(box.x + 20, box.y + box.height - 50);
  await expect(q.locator(".panel")).toHaveCount(0);
  await page.mouse.click(p.x, p.y);
  await q.locator(".card h3").click();
  await expect(q.locator(".panel")).toBeVisible();
  pass(
    "outside clicks on correct text and blank editor space dismiss the card; clicks inside it keep it open",
  );
  await q
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert.equal(await draft.inputValue(), "Is this really necessary?");
  pass("word-opened card applies the correct full-word edit");
  await q.getByRole("button", { name: "Close assistant", exact: true }).click();
  await draft.fill("this sentence works.");
  await draft.click();
  await q
    .getByRole("button", { name: "Sentence capitalization: t", exact: true })
    .waitFor();
  p = await point("this");
  await page.mouse.move(p.right - 2, p.y);
  await expect(q.locator(".word-highlight")).toHaveCount(1);
  highlight = await q.locator(".word-highlight").boundingBox();
  assert(highlight.width >= p.right - p.left - 1);
  await page.mouse.click(p.right - 2, p.y);
  await expect(q.locator(".card")).toContainText("Sentence capitalization");
  pass("a partial-letter diagnosis is clickable across the whole word");
  await q.getByRole("button", { name: "Close assistant", exact: true }).click();
  await draft.fill("Is this really neseccary?");
  await draft.click();
  await q
    .getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    })
    .waitFor();
  p = await point("neseccary");
  await page.mouse.dblclick(p.x, p.y);
  assert.equal(
    await draft.evaluate((e) =>
      e.value.slice(e.selectionStart, e.selectionEnd),
    ),
    "neseccary",
  );
  pass("native double-click word selection is preserved");
  if (
    await q
      .getByRole("button", { name: "Close assistant", exact: true })
      .count()
  )
    await q
      .getByRole("button", { name: "Close assistant", exact: true })
      .click();
  await draft.focus();
  await draft.evaluate((e) => e.setSelectionRange(0, 0));
  p = await point("neseccary");
  await page.mouse.move(p.left + 2, p.y);
  await page.mouse.down();
  await page.mouse.move(p.right - 2, p.y, { steps: 10 });
  await page.mouse.up();
  assert(await draft.evaluate((e) => e.selectionEnd > e.selectionStart));
  assert.equal(await q.locator(".panel").count(), 0);
  pass("dragging over a marked word selects text without opening a popup");
  await page.evaluate(() => {
    const e = document.createElement("div");
    e.id = "social";
    e.contentEditable = "true";
    e.setAttribute("role", "textbox");
    e.setAttribute("aria-label", "Social editor");
    e.style.cssText =
      "font:20px/1.5 Arial;width:320px;border:1px solid #ccc;margin:30px;padding:15px";
    e.innerHTML =
      "<div><b>Is this really </b><span>neseccary?</span></div><div>Or doe you think is good?</div>";
    document.body.prepend(e);
  });
  const rich = page.getByRole("textbox", {
    name: "Social editor",
    exact: true,
  });
  await rich.click();
  await q
    .getByRole("button", { name: "Auxiliary verb: doe", exact: true })
    .waitFor();
  p = await point("doe", true);
  await page.mouse.move(p.x, p.y);
  await expect(q.locator(".word-highlight")).toHaveCount(1);
  await page.mouse.click(p.x, p.y);
  await expect(q.locator(".card")).toContainText("Auxiliary verb");
  assert.equal(await rich.evaluate((e) => document.activeElement === e), true);
  pass(
    "nested social-editor word clicks open the matching issue without stealing focus",
  );
  await q
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert((await rich.innerText()).includes("Or do you"));
  assert.equal(await rich.locator("b").innerText(), "Is this really ");
  pass("native rich-text correction preserves surrounding formatting");
  const correct = await point("Is", true);
  await page.mouse.click(correct.x, correct.y);
  await expect(q.locator(".panel")).toHaveCount(0);
  pass("clicking an unmarked nested rich-text span dismisses the widget");
  await q
    .getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    })
    .waitFor();
  p = await point("neseccary", true);
  await page.mouse.click(p.x, p.y);
  await expect(q.locator(".panel")).toBeVisible();
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.title = "Outside frame";
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:120px;height:60px";
    frame.srcdoc = "<button>Another document</button>";
    document.body.append(frame);
  });
  await page
    .frameLocator('iframe[title="Outside frame"]')
    .getByRole("button", { name: "Another document" })
    .click();
  await expect(q.locator(".panel")).toHaveCount(0);
  pass("clicking another iframe also dismisses the open widget");
  for (const [tag, css, text] of [
    ["input", "height:88px;padding:0 28px;line-height:normal", "neseccary"],
    ["input", "height:72px;padding:8px 28px;line-height:120px", "neseccary"],
    [
      "input",
      "box-sizing:content-box;height:64px;padding:7px 28px 17px;line-height:1",
      "neseccary",
    ],
    [
      "textarea",
      "height:180px;padding:12px 28px;line-height:1.6",
      "First line.\nIs this neseccary?",
    ],
    [
      "textarea",
      "box-sizing:content-box;height:180px;padding:12px 28px;line-height:1.6",
      "First line.\nIs this neseccary?",
    ],
  ]) {
    await page.evaluate(
      ({ tag, css, text }) => {
        document.querySelector("#geometry-field")?.remove();
        document.querySelector("#geometry-reference")?.remove();
        const field = document.createElement(tag);
        field.id = "geometry-field";
        field.style.cssText = `position:fixed;left:30px;top:30px;width:600px;box-sizing:border-box;border:2px solid #ccc;font:32px Arial;text-align:left;${css}`;
        field.value = text;
        document.body.append(field);
        // A DOM text range provides an independent reference for the
        // native input's centered text and the textarea's top-aligned lines.
        const reference = document.createElement("div");
        reference.id = "geometry-reference";
        reference.style.cssText = field.style.cssText;
        reference.style.pointerEvents = "none";
        reference.style.visibility = "hidden";
        const span = document.createElement("span");
        span.style.whiteSpace = tag === "input" ? "pre" : "pre-wrap";
        span.style.overflowWrap = "break-word";
        if (tag === "input") {
          reference.style.display = "flex";
          reference.style.alignItems = "center";
          span.style.lineHeight = "normal";
        }
        span.textContent = text;
        reference.append(span);
        document.body.append(reference);
      },
      { tag, css, text },
    );
    await page.locator("#geometry-field").focus();
    const underline = q.getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    });
    await underline.waitFor();
    const expected = await page.evaluate(() => {
      const node = document.querySelector(
        "#geometry-reference span",
      ).firstChild;
      const offset = node.textContent.indexOf("neseccary");
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + "neseccary".length);
      return range.getBoundingClientRect().toJSON();
    });
    const line = await underline.boundingBox();
    assert(Math.abs(line.x - expected.left) < 1, `${tag}: underline left`);
    assert(
      Math.abs(line.width - expected.width) < 1,
      `${tag}: underline width`,
    );
    assert(
      Math.abs(line.y + line.height - (expected.bottom + 1)) < 1,
      `${tag} (${css}): underline must sit below the native text`,
    );
    await page.mouse.click(
      (expected.left + expected.right) / 2,
      (expected.top + expected.bottom) / 2,
    );
    await expect(q.locator(".card")).toContainText("neseccary→necessary");
    pass(`${tag} (${css}): underline and word hit target follow native text`);
  }
  assert.deepEqual(errors, []);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    `artifacts/word-click-${browser}.json`,
    JSON.stringify(
      { browser, checks, errors, date: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(`${checks} word-click UX checks passed.`);
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
