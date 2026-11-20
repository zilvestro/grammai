// Runs from `npm version`: package.json is the source of truth, and the Chrome
// Web Store rejects an upload whose manifest version did not increase.
import { readFile, writeFile } from "node:fs/promises";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const file = "public/manifest.json";
const manifest = await readFile(file, "utf8");
const next = manifest.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
if (JSON.parse(next).version !== version)
  throw new Error(`Could not set the version in ${file}.`);
await writeFile(file, next);
console.log(`${file} → ${version}`);
