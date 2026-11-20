import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { zipSync, unzipSync } from "fflate";

const root = path.resolve("dist");
// Pinned upstream packs, verified byte-for-byte before their vocabulary counts as public.
const verifiedPacks = {};
for (const [file, code] of [
  ["german.pack.gz", "de"],
  ["romanian.pack.gz", "ro"],
])
  verifiedPacks[file] = JSON.parse(
    await readFile(
      `node_modules/lingotweaker-data-${code}/manifest.json`,
      "utf8",
    ),
  ).languages[code].pack.sha256;
const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);
const args = process.argv.slice(2);
if (args.length && (args[0] !== "--output" || args.length !== 2))
  throw new Error("Usage: node scripts/package-store.mjs [--output ZIP_PATH]");
const output = path.resolve(
  args[1] || `artifacts/grammai-${manifest.version}-chrome-store.zip`,
);
const entries = {};
const removed = [];
const fixedTime = new Date("2020-01-01T00:00:00Z");
// A hosted CI runner has no private identity: its home directory and account
// are the generic, public "/home/runner" and "runner". Both occur in shipped
// files anyway: the upstream WASM embeds its own CI build paths, and "runner"
// is an ordinary dictionary word.
const hosted = !!process.env.GITHUB_ACTIONS;
const privateMarkers = [
  hosted ? "" : homedir(),
  createHash("sha256")
    .update(root)
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (character) =>
      String.fromCharCode(97 + parseInt(character, 16)),
    ),
]
  .filter((value) => value.length > 4)
  .map((value) => Buffer.from(value.toLowerCase()));
const secretPatterns = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
const localUser = hosted ? "" : userInfo().username.toLowerCase();
let scanned = 0;
function inspect(name, bytes, publicVocabulary = false) {
  scanned++;
  const lower = Buffer.from(bytes).toString("utf8").toLowerCase();
  if (
    privateMarkers.some((marker) => lower.includes(marker.toString())) ||
    (!publicVocabulary && localUser && lower.includes(localUser))
  )
    throw new Error(
      `Private machine marker in ${name}; no archive was written.`,
    );
  const text = Buffer.from(bytes).toString("utf8");
  if (secretPatterns.some((pattern) => pattern.test(text)))
    throw new Error(
      `Credential-like material in ${name}; no archive was written.`,
    );
  if (
    /(?:^|\/)(?:\.env(?:\..*)?|config\.json|auth\.json|credentials(?:\.json)?|\.DS_Store)$/.test(
      name,
    )
  )
    throw new Error(`Private configuration file in ${name}`);
  if (name.endsWith(".zip")) {
    for (const [child, data] of Object.entries(unzipSync(bytes)))
      inspect(`${name}/${child}`, data);
  } else if (name.endsWith(".gz")) {
    // Proper names in the pinned public German and Romanian dictionaries can
    // coincide with a local username. Verify the upstream pack byte-for-byte
    // before treating its vocabulary as public; machine paths and credential
    // patterns still fail.
    const verified =
      Object.hasOwn(verifiedPacks, name) &&
      createHash("sha256").update(bytes).digest("hex") === verifiedPacks[name];
    inspect(name.slice(0, -3), gunzipSync(bytes), verified);
  }
}
function stripPngMetadata(bytes) {
  const input = Buffer.from(bytes);
  if (input.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("Invalid PNG");
  const parts = [input.subarray(0, 8)];
  for (let index = 8; index < input.length; ) {
    const length = input.readUInt32BE(index);
    const kind = input.subarray(index + 4, index + 8).toString("ascii");
    const end = index + 12 + length;
    if (end > input.length) throw new Error("Invalid PNG chunk");
    // Retain image/color/transparency data byte-for-byte; omit ancillary text,
    // EXIF and modification timestamps only. Pixel data is never re-encoded.
    if (!["eXIf", "tEXt", "iTXt", "zTXt", "tIME"].includes(kind))
      parts.push(input.subarray(index, end));
    index = end;
  }
  return Buffer.concat(parts);
}
async function collect(directory) {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const absolute = path.join(directory, item.name);
    const name = path.relative(root, absolute).split(path.sep).join("/");
    if (item.isSymbolicLink()) throw new Error(`Unexpected symlink: ${name}`);
    if (item.name === ".DS_Store" || name.endsWith(".map")) {
      removed.push(name);
      continue;
    }
    if (item.isDirectory()) {
      await collect(absolute);
      continue;
    }
    let bytes = await readFile(absolute);
    if (name.endsWith(".js"))
      bytes = Buffer.from(
        bytes
          .toString("utf8")
          .replace(/^\/\/[#@] sourceMappingURL=.*(?:\r?\n|$)/gm, ""),
      );
    if (name.endsWith(".png")) bytes = stripPngMetadata(bytes);
    inspect(name, bytes);
    entries[name] = [new Uint8Array(bytes), { mtime: fixedTime }];
  }
}
await collect(root);
if (manifest.manifest_version !== 3 || manifest.description.length > 132)
  throw new Error("Invalid Store manifest metadata");
for (const name of [
  "manifest.json",
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  manifest.side_panel.default_path,
  "privacy.html",
  "feedback.html",
  "feedback.js",
  "feedback.css",
  "german.wasm",
  "german.pack.gz",
  "romanian.pack.gz",
  "grammar-offscreen.html",
  "grammar-offscreen.js",
  "german-worker.js",
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((item) => item.js),
  ...manifest.web_accessible_resources.flatMap((item) => item.resources),
])
  if (!entries[name]) throw new Error(`Missing packaged resource: ${name}`);
// Chrome rejects any second file named manifest.json, even license metadata.
const manifestFiles = Object.keys(entries).filter(
  (name) => path.posix.basename(name).toLowerCase() === "manifest.json",
);
if (manifestFiles.length !== 1 || manifestFiles[0] !== "manifest.json")
  throw new Error(
    `Store package must contain exactly one root manifest.json: ${manifestFiles.join(", ")}`,
  );
const zip = zipSync(entries, { level: 9 });
const verified = unzipSync(zip);
if (
  !verified["manifest.json"] ||
  Object.keys(verified).length !== Object.keys(entries).length
)
  throw new Error("Store ZIP verification failed");
for (const [name, bytes] of Object.entries(verified)) {
  if (
    name.endsWith(".map") ||
    (name.endsWith(".js") &&
      Buffer.from(bytes).includes(Buffer.from("sourceMappingURL=")))
  )
    throw new Error(`Development source map remains in ${name}`);
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, zip, { flag: "wx" });
await mkdir("artifacts", { recursive: true });
await writeFile(
  `artifacts/grammai-${manifest.version}-store-audit.json`,
  JSON.stringify(
    {
      archive: path.basename(output),
      version: manifest.version,
      bytes: zip.length,
      sha256: createHash("sha256").update(zip).digest("hex"),
      entries: Object.keys(entries),
      removed,
      inspectedResourcesIncludingNested: scanned,
      privateMachineMarkers: 0,
      credentialPatterns: 0,
      sourceMaps: 0,
      imageMetadataRemoved: true,
      manifestAtRoot: true,
      manifestCount: manifestFiles.length,
      note: "Automated marker/pattern audit; no browser profiles, user settings, credentials or test artifacts are packaged. Public support contact and third-party license attributions are retained.",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Created ${output} (${(zip.length / 1e6).toFixed(1)} MB; ${Object.keys(entries).length} files).`,
);
