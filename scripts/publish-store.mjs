// Uploads a packaged ZIP to the Chrome Web Store (API v2) and submits it for
// review. Authenticates as a service account; uses no dependencies.
//
//   CWS_SERVICE_ACCOUNT_KEY  JSON key of the service account added under
//                            Developer Dashboard → Account
//   CWS_PUBLISHER_ID         Developer Dashboard → Publisher → Settings
//   CWS_ITEM_ID              the 32-character extension ID
//
// Usage: node scripts/publish-store.mjs ZIP_PATH [--upload-only]
import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";

const [zipPath, flag] = process.argv.slice(2);
if (!zipPath || (flag && flag !== "--upload-only"))
  throw new Error(
    "Usage: node scripts/publish-store.mjs ZIP_PATH [--upload-only]",
  );
const env = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};
const key = JSON.parse(env("CWS_SERVICE_ACCOUNT_KEY"));
const item = `publishers/${env("CWS_PUBLISHER_ID")}/items/${env("CWS_ITEM_ID")}`;
const api = "https://chromewebstore.googleapis.com";
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const claims = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/chromewebstore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 600,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(claims)
    .sign(key.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${claims}.${signature}`,
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token)
    throw new Error(
      `Google rejected the service account: ${body.error_description || body.error || response.status}`,
    );
  return body.access_token;
}
async function call(token, method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  if (!response.ok)
    throw new Error(
      `${method} ${new URL(url).pathname} failed (${response.status}): ${json.error?.message || text.slice(0, 500)}`,
    );
  return json;
}

const token = await accessToken();
const zip = await readFile(zipPath);
let { uploadState, crxVersion } = await call(
  token,
  "POST",
  `${api}/upload/v2/${item}:upload`,
  zip,
);
// Large packages are processed asynchronously.
for (
  let attempt = 0;
  uploadState === "IN_PROGRESS" && attempt < 60;
  attempt++
) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const status = await call(token, "GET", `${api}/v2/${item}:fetchStatus`);
  uploadState = status.lastAsyncUploadState ?? uploadState;
}
if (uploadState !== "SUCCEEDED")
  throw new Error(`The Store did not accept the package: ${uploadState}.`);
console.log(`Uploaded${crxVersion ? ` version ${crxVersion}` : ""}.`);
if (flag === "--upload-only") {
  console.log("Left as a draft; submit it for review in the Dashboard.");
} else {
  const { state, warningInfo } = await call(
    token,
    "POST",
    `${api}/v2/${item}:publish`,
  );
  for (const warning of warningInfo?.warnings ?? [])
    console.warn(`Store warning: ${warning.reason} ${warning.description}`);
  if (["REJECTED", "CANCELLED"].includes(state))
    throw new Error(`The Store refused the submission: ${state}.`);
  console.log(`Submitted: ${state}. It goes live once review passes.`);
}
