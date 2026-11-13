import { build } from "esbuild";
import { mkdir, rm, cp, readFile, writeFile } from "node:fs/promises";
const feedbackConfig = JSON.parse(
  await readFile("feedback.config.json", "utf8"),
);
const feedbackEndpoint =
  process.env.GRAMMAI_FEEDBACK_ENDPOINT ?? feedbackConfig.endpoint;
let feedbackOrigin;
if (feedbackEndpoint) {
  const url = new URL(feedbackEndpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/v1/feedback"
  )
    throw new Error(
      "Feedback endpoint must be an HTTPS URL ending in /v1/feedback, without credentials or query parameters.",
    );
  feedbackOrigin = url.origin;
}
await import("./prepare-dictionaries.mjs");
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
if (feedbackOrigin) {
  const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
  manifest.host_permissions = [
    ...new Set([
      ...(Array.isArray(manifest.host_permissions)
        ? manifest.host_permissions
        : []),
      `${feedbackOrigin}/*`,
      "<all_urls>",
    ]),
  ];
  manifest.content_security_policy.extension_pages += ` ${feedbackOrigin}`;
  await writeFile(
    "dist/manifest.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
}
await cp(
  "node_modules/harper.js/dist/harper_wasm_slim_bg.wasm",
  "dist/harper_wasm_slim_bg.wasm",
);
await import("./prepare-german.mjs");
await build({
  entryPoints: [
    "src/background.ts",
    "src/content.ts",
    "src/popup.ts",
    "src/options.ts",
    "src/sidepanel.ts",
    "src/help.ts",
    "src/feedback.ts",
    "src/german-worker.ts",
    "src/grammar-offscreen.ts",
  ],
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome120",
  // Harper also supports Node. Remove its filesystem loader from the browser build.
  define: {
    process: "undefined",
    __FEEDBACK_ENDPOINT__: JSON.stringify(feedbackEndpoint || ""),
  },
  sourcemap: true,
  legalComments: "none",
});
const demo = await readFile("dist/demo.html", "utf8");
await writeFile(
  "dist/demo.html",
  demo.replace("</body>", '<script src="content.js" defer></script></body>'),
);
await (await import("./package-helper.mjs")).packageHelper();
console.log("Built Chrome/Helium extension and local helper → dist/");
