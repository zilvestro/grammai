import type { Category, Issue } from "./engine";
import type { LanguageMode, WritingLanguage } from "./language";
import {
  defaultShortcuts,
  sanitizeShortcuts,
  type Shortcuts,
} from "./shortcuts";
export interface CustomPrompt {
  id: string;
  name: string;
  instruction: string;
}
export interface Settings {
  theme: "system" | "light" | "dark";
  customPrompts: CustomPrompt[];
  enabled: boolean;
  disabledSites: string[];
  dictionary: string[];
  dialect: "en-US" | "en-GB";
  languageMode: LanguageMode;
  /** Language that automatic translation uses for English text. */
  translatePartner: Exclude<WritingLanguage, "en">;
  categories: Record<Category, boolean>;
  aiProvider: "auto" | "claude" | "codex";
  aiModel: string;
  shortcuts: Shortcuts;
}
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  customPrompts: [],
  enabled: true,
  aiProvider: "auto",
  aiModel: "",
  shortcuts: defaultShortcuts(),
  disabledSites: [],
  dictionary: [],
  dialect: "en-US",
  languageMode: "auto",
  translatePartner: "de",
  categories: {
    correctness: true,
    clarity: true,
    engagement: true,
    delivery: true,
  },
};
export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  const settings = stored.settings as Partial<Settings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    categories: { ...DEFAULT_SETTINGS.categories, ...settings?.categories },
    shortcuts: sanitizeShortcuts(settings?.shortcuts),
  };
}
export async function updateSettings(
  patch: Partial<Settings>,
): Promise<Settings> {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}
export type RewriteStyle =
  | "custom"
  | "rephrase"
  | "confident"
  | "simple"
  | "improve"
  | "concise"
  | "formal"
  | "friendly"
  | "fix"
  | "translate-auto"
  | "translate-en"
  | "translate-de"
  | "translate-ro";
export function isTranslation(style?: RewriteStyle) {
  return typeof style === "string" && style.startsWith("translate-");
}
export interface RewriteView {
  phase: "loading" | "ready" | "error";
  style: RewriteStyle;
  scope: "selection" | "field";
  customPromptId?: string;
  original?: string;
  result?: string;
  provider?: string;
  model?: string;
  targetLanguage?: WritingLanguage;
  error?: string;
}
export interface Snapshot {
  editorId: string;
  version: number;
  issues: Issue[];
  words: number;
  score: number;
  tone: string;
  readingMinutes: number;
  enabled: boolean;
  limited: boolean;
  checking?: boolean;
  checkError?: string;
  language?: WritingLanguage;
  tabId?: number;
  frameId?: number;
  canUndo?: boolean;
  rewrite?: RewriteView;
}
export const categoryLabels: Record<Category, string> = {
  correctness: "Correctness",
  clarity: "Clarity",
  engagement: "Engagement",
  delivery: "Delivery",
};
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function undoButton(available: boolean, undo: () => void) {
  const button = el("button", "icon undo-control");
  button.type = "button";
  button.title = button.ariaLabel = "Undo last correction";
  button.disabled = !available;
  button.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 4-5 5 5 5M3 9h11a7 7 0 0 1 0 14"/></svg>';
  button.onclick = undo;
  return button;
}
