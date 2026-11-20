import { chromium } from "playwright";
import { expect } from "playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startServer } from "../scripts/serve.mjs";
const browser = process.env.QUILL_BROWSER === "helium" ? "helium" : "chromium";
const profile = await mkdtemp(path.join(tmpdir(), "quill-live-"));
const extension = path.resolve("dist");
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
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
const errors = [];
const requests = [];
context.on("weberror", (e) => errors.push(e.error().message));
context.on("request", (r) => {
  if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== "127.0.0.1")
    requests.push(r.url());
});
let checks = 0;
const pass = (label) => {
  checks++;
  console.log("PASS", label);
};
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(base);
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${id}/options.html`);
  await page.bringToFront();
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
  );
  const state = () =>
    probe.evaluate(
      (tabId) => chrome.runtime.sendMessage({ type: "GET_STATE", tabId }),
      tabId,
    );
  // A fresh Helium profile reloads its initial HTTP tab during startup.
  // Settle that first-run navigation before timing or entering a test draft.
  if (browser === "helium") await page.waitForTimeout(2500);
  const draft = page.getByRole("textbox", {
    name: "Writing editor",
    exact: true,
  });
  const coldStart = performance.now();
  await draft.click();
  await expect
    .poll(
      async () => {
        const s = await state();
        return s && !s.checking && !s.checkError && s.issues.length > 0;
      },
      { timeout: 15000, intervals: [10] },
    )
    .toBeTruthy();
  const coldUiMs = performance.now() - coldStart;
  const update = async (text) => {
    const version = (await state())?.version ?? -1;
    const t = performance.now();
    await draft.fill(text);
    await expect
      .poll(
        async () => {
          const s = await state();
          return s?.version > version && !s.checking && !s.checkError;
        },
        { timeout: 15000, intervals: [10] },
      )
      .toBeTruthy();
    return { s: await state(), ms: performance.now() - t };
  };
  const text =
    "is this really necessary? Or doe you think is good?  neseccary? \n";
  let { s } = await update(text);
  for (const [original, replacement] of [
    ["doe", "do"],
    ["is", "it is"],
    ["neseccary", "necessary"],
  ])
    assert(
      s.issues.some(
        (i) => i.original === original && i.replacements[0] === replacement,
      ),
    );
  pass(
    "all reported spelling/context mistakes appear together through real extension messages",
  );
  const quill = page.locator("[data-grammai-root]");
  await quill
    .getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    })
    .click();
  await quill
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert.equal(
    await draft.inputValue(),
    text.replace("neseccary", "necessary"),
  );
  pass(
    "actual spelling highlight accepts the full word without changing surrounding text",
  );
  await update("A clean starting sentence.");
  const latencies = [];
  const samples = [
    "Is this really neseccary?",
    "Or doe you think is good?",
    "She go to school.",
    "We need reliablity.",
    "The doe is standing beside her fawn.",
  ];
  for (let n = 0; n < 20; n++) {
    const r = await update(samples[n % samples.length]);
    latencies.push(r.ms);
  }
  pass("20 successive live updates finish without errors or stale state");
  for (const clean of [
    "The doe you think is small is standing beside her fawn.",
    "Who do you think is good?",
    "I had had enough. I knew that that was right.",
    "We met Alex and Xiomara.",
  ]) {
    const { s } = await update(clean);
    assert.deepEqual(s.issues, [], clean);
  }
  pass("valid doe context, questions, repetitions, and names remain clean");
  const emoji = "👩🏽‍💻 We need neseccary changes.";
  s = (await update(emoji)).s;
  assert.equal(
    s.issues.find((i) => i.original === "neseccary").offset,
    emoji.indexOf("neseccary"),
  );
  await quill
    .getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    })
    .click();
  await quill
    .getByRole("button", { name: "Accept suggestion", exact: true })
    .click();
  assert.equal(
    await draft.inputValue(),
    emoji.replace("neseccary", "necessary"),
  );
  pass(
    "emoji and skin-tone sequences preserve replacement positions in actual textarea",
  );
  await page.evaluate(() => {
    window.quillFrames = [];
    window.quillRecording = true;
    const frame = (t) => {
      window.quillFrames.push(t);
      if (window.quillRecording) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const difficult = await update("The word zxqplm is unknown.");
  const frames = await page.evaluate(() => {
    window.quillRecording = false;
    return window.quillFrames;
  });
  const gaps = frames.slice(1).map((t, i) => t - frames[i]);
  const maxFrameGapMs = Math.max(0, ...gaps);
  assert(frames.length >= 3);
  assert(maxFrameGapMs < 200, `page frame gap ${maxFrameGapMs} ms`);
  pass(
    "difficult dictionary lookup leaves page animation/input thread responsive",
  );
  // While the old check runs, edits and a field switch invalidate its result.
  await draft.fill("The word qzxwvt is unknown.");
  await page.waitForTimeout(180);
  await draft.fill("This latest draft is correct.");
  await expect
    .poll(
      async () => {
        const s = await state();
        return !s?.checking && s?.words === 5 && s?.issues.length === 0;
      },
      { timeout: 15000, intervals: [10] },
    )
    .toBeTruthy();
  assert.equal(await draft.inputValue(), "This latest draft is correct.");
  pass("late results cannot replace the suggestions for a newer draft");
  // Nested contenteditable fixture, using the same DOM shape as common social editors.
  await page.evaluate(() => {
    const e = document.createElement("div");
    e.contentEditable = "true";
    e.setAttribute("role", "textbox");
    e.setAttribute("aria-label", "Social editor");
    e.setAttribute("data-gramm", "false");
    e.innerHTML =
      '<div data-block="true"><span>👩🏽‍💻 Is this really </span><span>neseccary?</span></div><div data-block="true"><span>Or doe you think is good?</span></div>';
    document.body.prepend(e);
  });
  const rich = page.getByRole("textbox", {
    name: "Social editor",
    exact: true,
  });
  await rich.click();
  await quill
    .getByRole("button", {
      name: "Possible spelling mistake: neseccary",
      exact: true,
    })
    .waitFor();
  await quill
    .getByRole("button", { name: "Auxiliary verb: doe", exact: true })
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
  assert((await rich.innerText()).includes("necessary?"));
  assert((await rich.innerText()).includes("doe you"));
  assert.equal(await rich.locator("[data-block]").count(), 2);
  pass(
    "nested social contenteditable detects and fixes spelling while preserving blocks",
  );
  // Controlled editors such as X commit DOM changes without a bubbling input.
  // A prefilled static contenteditable fixture alone cannot catch this regression.
  await rich.evaluate((node) => {
    node.addEventListener("input", (event) => event.stopPropagation());
    node.replaceChildren(document.createTextNode("We need reliablity."));
  });
  await quill
    .getByRole("button", {
      name: "Possible spelling mistake: reliablity",
      exact: true,
    })
    .waitFor();
  pass("controlled DOM commits without input events refresh live suggestions");
  await rich.evaluate((node) => node.replaceChildren());
  await expect
    .poll(async () => (await state())?.issues.length, { intervals: [10] })
    .toBe(0);
  await expect
    .poll(async () => (await state())?.words, { intervals: [10] })
    .toBe(0);
  pass("programmatic editor clearing removes stale suggestions and statistics");
  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    browser,
    version: context.browser()?.version(),
    checks,
    coldUiMs,
    liveUi: {
      samples: latencies.length,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxMs: sorted.at(-1),
    },
    difficultWordUiMs: difficult.ms,
    maxFrameGapMs,
    errors,
    externalRequests: requests,
    date: new Date().toISOString(),
  };
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  pass("no browser errors and no external text requests");
  report.checks = checks;
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    `artifacts/live-checks-${browser}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
