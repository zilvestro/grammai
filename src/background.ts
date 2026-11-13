import {
  getSettings,
  isTranslation,
  type RewriteStyle,
  type Snapshot,
} from "./shared";
import { nativeRequest, cancelNative } from "./native-client";
import { createBinaryModuleFromUrl } from "harper.js";
import { createLiveChecker } from "./live-engine";
import { detectLanguage, type WritingLanguage } from "./language";
import { checkLocal } from "./lt-client";
const checker = createLiveChecker(
  createBinaryModuleFromUrl(
    chrome.runtime.getURL("harper_wasm_slim_bg.wasm"),
    "slim",
  ),
);
/** Automatic translation goes to English, or from English to the chosen partner language. */
function translationTarget(
  style: RewriteStyle,
  text: string,
  partner: WritingLanguage,
): WritingLanguage {
  if (style === "translate-en") return "en";
  if (style === "translate-de") return "de";
  if (style === "translate-ro") return "ro";
  return detectLanguage(text) === "en" ? partner : "en";
}
const snapshots = new Map<number, Snapshot>();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const tabId = sender.tab?.id;
  if (message.type === "CHECK_TEXT") {
    if (typeof message.text !== "string" || message.text.length > 20000) {
      respond({ ok: false, error: "Draft exceeds the live check limit." });
      return;
    }
    getSettings()
      .then(async (settings) => {
        if (!settings.enabled) return { ok: true, issues: [] };
        const language = detectLanguage(message.text, settings.languageMode);
        if (!message.text.trim()) return { ok: true, issues: [], language };
        if (language !== "en") {
          const response = await checkLocal(language, message.text, settings);
          return { ...response, language };
        }
        const issues = await checker.check(message.text, settings);
        return { ok: true, issues, language };
      })
      .then(respond)
      .catch(() =>
        respond({
          ok: false,
          error:
            "Local grammar check unavailable. Reload grammai and try again.",
        }),
      );
    return true;
  } else if (message.type === "AI_STATUS") {
    nativeRequest({ operation: "status" }).then(respond);
    return true;
  } else if (message.type === "AI_REWRITE") {
    if (
      tabId === undefined ||
      typeof message.text !== "string" ||
      !message.text.trim() ||
      message.text.length > 12000 ||
      typeof message.requestId !== "string"
    ) {
      respond({
        ok: false,
        error: "Select between 1 and 12,000 characters to rewrite.",
      });
      return;
    }
    getSettings()
      .then((settings) => {
        const custom = settings.customPrompts.find(
          (p) => p.id === message.customPromptId,
        );
        if (message.style === "custom" && !custom)
          return {
            ok: false,
            error: "This saved prompt no longer exists. Choose another prompt.",
          };
        return nativeRequest(
          {
            operation: isTranslation(message.style) ? "translate" : "rewrite",
            text: message.text,
            style: message.style,
            ...(message.style === "custom"
              ? { instruction: custom!.instruction }
              : {}),
            provider: settings.aiProvider,
            model: isTranslation(message.style) ? "" : settings.aiModel,
            ...(isTranslation(message.style)
              ? {
                  targetLanguage: translationTarget(
                    message.style,
                    message.text,
                    settings.translatePartner,
                  ),
                }
              : {}),
          },
          message.requestId,
          tabId,
        );
      })
      .then(respond)
      .catch(() =>
        respond({ ok: false, error: "Could not start the local AI request." }),
      );
    return true;
  } else if (message.type === "AI_CANCEL") {
    cancelNative(message.requestId, tabId);
    respond({ ok: true });
  } else if (message.type === "CLEAR_STATE" && tabId !== undefined) {
    const previous = snapshots.get(tabId);
    if (previous?.frameId === (sender.frameId ?? 0)) {
      snapshots.delete(tabId);
      chrome.runtime
        .sendMessage({ type: "STATE_CLEARED", tabId })
        .catch(() => {});
    }
    respond({ ok: true });
  } else if (message.type === "SNAPSHOT" && tabId !== undefined) {
    // All draft state stays in worker memory and expires on navigation or worker suspension.
    const state: Snapshot = {
      ...message.state,
      tabId,
      frameId: sender.frameId ?? 0,
    };
    snapshots.set(tabId, state);
    chrome.runtime
      .sendMessage({ type: "STATE_CHANGED", state })
      .catch(() => {});
    respond({ ok: true });
  } else if (message.type === "GET_STATE") {
    respond(snapshots.get(message.tabId) ?? null);
  } else if (
    message.type === "APPLY" ||
    message.type === "DISMISS" ||
    message.type === "FOCUS_ISSUE" ||
    message.type === "REWRITE_START" ||
    message.type === "REWRITE_APPLY" ||
    message.type === "REWRITE_CANCEL" ||
    message.type === "UNDO"
  ) {
    const state = snapshots.get(message.tabId);
    if (
      !state ||
      state.editorId !== message.editorId ||
      state.version !== message.version
    ) {
      respond({
        ok: false,
        error:
          "The draft changed. Select the text field to refresh suggestions.",
      });
      return;
    }
    chrome.tabs
      .sendMessage(message.tabId, message, { frameId: state.frameId ?? 0 })
      .then(respond)
      .catch(() =>
        respond({
          ok: false,
          error: "Select a text field on this page first.",
        }),
      );
    return true;
  } else if (message.type === "OPEN_FEEDBACK") {
    chrome.tabs
      .create({ url: chrome.runtime.getURL("feedback.html") })
      .then(() => respond({ ok: true }))
      .catch(() => respond({ ok: false }));
    return true;
  } else if (message.type === "OPEN_HELP") {
    const topic = message.topic === "german" ? "german" : "ai";
    chrome.tabs
      .create({ url: chrome.runtime.getURL(`help.html#${topic}`) })
      .then(() => respond({ ok: true }))
      .catch(() => respond({ ok: false }));
    return true;
  } else if (message.type === "OPEN_SETTINGS") {
    chrome.runtime.openOptionsPage();
    respond({ ok: true });
  }
});
chrome.tabs.onRemoved.addListener((id) => snapshots.delete(id));
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading") snapshots.delete(id);
});
