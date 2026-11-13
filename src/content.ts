import { feedbackLink } from "./support";
import type { Issue, Category } from "./engine";
import { textStatistics } from "./statistics";
import {
  getSettings,
  updateSettings,
  el,
  undoButton,
  categoryLabels,
  isTranslation,
  type Settings,
  type Snapshot,
} from "./shared";
import { styles } from "./content-style";
import { themeStyles, resolvedTheme } from "./theme";
import {
  SHORTCUT_ACTIONS,
  formatCombo,
  shortcutForEvent,
} from "./shortcuts";
import { editorText, editorRange, selectedOffsets } from "./editor-text";
import { rewritePane, translationPane, rewriteStyles } from "./rewrite-ui";
import type { RewriteView, RewriteStyle } from "./shared";
import { createExtensionContext } from "./extension-context";
import type { WritingLanguage } from "./language";

type Editor = HTMLTextAreaElement | HTMLInputElement | HTMLElement;
interface Session {
  editor: Editor;
  id: string;
  version: number;
  text: string;
  issues: Issue[];
  dismissed: Set<string>;
  checking?: boolean;
  checkError?: string;
  language?: WritingLanguage;
  checkKey?: string;
  editing?: boolean;
  rewrite?: RewriteView & {
    requestId: string;
    source: string;
    offset: number;
    length: number;
  };
}
let settings: Settings;
let session: Session | null = null;
let panelOpen = false;
let compact = false;
let panelMode: "suggestions" | "rewrite" | "translate" = "suggestions";
let selection: {
  editor: Editor;
  text: string;
  offset: number;
  length: number;
} | null = null;
let filter: Category | "all" = "all";
let selected = 0;
let timer: ReturnType<typeof setTimeout>;
let checkRevision = 0;
let checkQueue: Promise<unknown> = Promise.resolve();
let wordTargets: Array<{
  issueId: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}> = [];
let wordPress: { editor: Editor; x: number; y: number; moved: boolean } | null =
  null;
let pointer: { x: number; y: number } | null = null;
let selectionDismissed = false;
let hoveredIssueId: string | undefined;
let cursorOverride: { editor: Editor; value: string; priority: string } | null =
  null;
let composing = false;
let listOpen = false;
let status = "";
let undoState: {
  editor: Editor;
  before: string;
  after: string;
  original: string;
  issue: Issue;
} | null = null;
const sessions = new WeakMap<Editor, Session>();
const listeners = new AbortController();
const observers = new Set<WeakRef<MutationObserver | ResizeObserver>>();
const context = createExtensionContext(() => {
  clearTimeout(timer);
  checkRevision++;
  listeners.abort();
  for (const reference of observers) reference.deref()?.disconnect();
  observers.clear();
  session = null;
  selection = null;
  undoState = null;
  panelOpen = false;
  wordTargets = [];
  wordPress = null;
  clearWordHover();
  ui.replaceChildren();
  marks.replaceChildren();
  host.remove();
});
function listen<K extends keyof DocumentEventMap>(
  target: EventTarget,
  type: K,
  listener: (event: DocumentEventMap[K]) => void,
  options: AddEventListenerOptions | boolean = {},
) {
  target.addEventListener(
    type,
    (event) => {
      if (context.available()) listener(event as DocumentEventMap[K]);
    },
    {
      ...(typeof options === "boolean" ? { capture: options } : options),
      signal: listeners.signal,
    },
  );
}
function observe<T extends MutationObserver | ResizeObserver>(observer: T): T {
  for (const reference of observers)
    if (!reference.deref()) observers.delete(reference);
  observers.add(new WeakRef(observer));
  return observer;
}
function notify(message: unknown) {
  void context.call(() => chrome.runtime.sendMessage(message)).catch(() => {});
}
const host = document.createElement("quill-assistant");
const shadow = host.attachShadow({ mode: "open" });
const style = el("style");
style.textContent = themeStyles + styles + rewriteStyles;
shadow.append(style);
const marks = el("div");
const ui = el("div");
const hoverMarks = el("div");
hoverMarks.setAttribute("aria-hidden", "true");
shadow.append(marks, hoverMarks, ui);
const selectionActions = el("div", "selection-actions");
selectionActions.setAttribute("role", "toolbar");
selectionActions.setAttribute("aria-label", "Actions for selected text");
shadow.append(selectionActions);
const mirror = el("div", "text-mirror");
mirror.setAttribute("aria-hidden", "true");
mirror.style.cssText =
  "position:fixed;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow:hidden;";
shadow.append(mirror);
function ensureHost() {
  if (!host.isConnected)
    (document.body || document.documentElement).append(host);
}
function isField(e: unknown): e is Editor {
  if (
    !(e instanceof HTMLElement) ||
    e.closest(
      'quill-assistant,[data-quill="false"],pre,code,[role="spinbutton"]',
    ) ||
    ["numeric", "decimal", "tel"].includes(e.getAttribute("inputmode") || "") ||
    e.getAttribute("aria-disabled") === "true" ||
    e.getAttribute("aria-readonly") === "true"
  )
    return false;
  if (e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement) {
    if (e.disabled || e.readOnly || e.getAttribute("aria-readonly") === "true")
      return false;
    if (e instanceof HTMLInputElement && !["text", ""].includes(e.type))
      return false;
    if (
      /password|one-time|cc-|credit|card|username|email|address|tel|search/i.test(
        [e.autocomplete, e.name, e.id, e.getAttribute("aria-label")].join(" "),
      )
    )
      return false;
    // HTML type=text is also used for amounts, PINs and constrained number fields.
    const pattern = e.getAttribute("pattern") || "";
    if (
      pattern &&
      !/[a-zA-Z]/.test(pattern.replace(/\\d/g, "")) &&
      /[0-9]|\\d/.test(pattern)
    )
      return false;
    return true;
  }
  return (
    e.isContentEditable &&
    e.getAttribute("contenteditable") !== "false" &&
    e.getAttribute("aria-readonly") !== "true"
  );
}
function fieldFrom(target: EventTarget | null): Editor | null {
  if (!(target instanceof HTMLElement)) return null;
  const field = target.closest(
    'textarea,input,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]',
  );
  return isField(field) ? field : null;
}
function read(e: Editor): string {
  return e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement
    ? e.value
    : editorText(e);
}
function enabled() {
  return (
    context.available() &&
    settings?.enabled &&
    !settings.disabledSites.includes(location.hostname)
  );
}
function visibleIssues() {
  return (session?.issues || []).filter((i) => !session!.dismissed.has(key(i)));
}
function key(i: Issue) {
  return `${i.ruleId}:${i.offset}:${i.original}`;
}
function filtered() {
  return visibleIssues().filter(
    (i) => filter === "all" || i.category === filter,
  );
}
function sendState() {
  if (!context.available() || !session) return;
  const stats = textStatistics(session.text.slice(0, 20000));
  const issues = visibleIssues();
  const state: Snapshot = {
    editorId: session.id,
    version: session.version,
    issues,
    words: stats.words,
    score: Math.max(
      0,
      100 -
        issues.reduce((n, i) => n + (i.category === "correctness" ? 7 : 3), 0),
    ),
    tone: stats.tone,
    readingMinutes: stats.readingMinutes,
    enabled: !!enabled(),
    limited: session.text.length > 20000,
    checking: session.checking,
    checkError: session.checkError,
    language: session.language,
    canUndo:
      !!undoState &&
      undoState.editor === session.editor &&
      read(session.editor) === undoState.after,
    rewrite: session.rewrite
      ? {
          phase: session.rewrite.phase,
          style: session.rewrite.style,
          customPromptId: session.rewrite.customPromptId,
          scope: session.rewrite.scope,
          original: session.rewrite.original,
          result: session.rewrite.result,
          provider: session.rewrite.provider,
          model: session.rewrite.model,
          error: session.rewrite.error,
          targetLanguage: session.rewrite.targetLanguage,
        }
      : undefined,
  };
  notify({ type: "SNAPSHOT", state });
}
function deactivate() {
  checkRevision++;
  cancelRewrite(false);
  selection = null;
  selectionActions.replaceChildren();
  session = null;
  panelOpen = false;
  wordTargets = [];
  wordPress = null;
  clearWordHover();
  ui.replaceChildren();
  marks.replaceChildren();
  notify({ type: "CLEAR_STATE" });
}
function activate(editor: Editor) {
  if (!context.available()) return;
  if (session?.editor === editor) {
    schedule();
    return;
  }
  let next = sessions.get(editor);
  if (!next) {
    next = {
      editor,
      id: crypto.randomUUID(),
      version: 0,
      text: "",
      issues: [],
      dismissed: new Set(),
    };
    sessions.set(editor, next);
    listen(editor, "input", () => {
      if (session?.editor === editor && !composing) schedule();
    });
    listen(editor, "scroll", position, { passive: true });
    listen(editor, "compositionstart", () => {
      checkRevision++;
      if (session?.editor === editor) session.checkKey = undefined;
      composing = true;
      clearTimeout(timer);
    });
    listen(editor, "compositionend", () => {
      composing = false;
      schedule();
    });
    observe(
      new ResizeObserver(() => {
        if (!context.available()) return;
        if (session?.editor === editor) position();
      }),
    ).observe(editor);
    if (
      !(
        editor instanceof HTMLTextAreaElement ||
        editor instanceof HTMLInputElement
      )
    ) {
      // Controlled editors can intercept paste/input and commit text through React
      // without an input event reaching document. Observe the actual DOM commit.
      observe(
        new MutationObserver(() => {
          if (!context.available()) return;
          if (
            session?.editor === editor &&
            !composing &&
            read(editor) !== session.text
          )
            schedule();
        }),
      ).observe(editor, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  }
  cancelRewrite(false);
  clearWordHover();

  selection = null;
  session = next;
  selected = 0;
  status = "";
  undoState = null;
  run();
}
function schedule() {
  if (!context.available()) return;
  // Refocusing unchanged text must not cancel an in-flight check or redraw a form.
  if (
    session?.checkKey &&
    read(session.editor) === session.text &&
    !session.checkError
  )
    return;
  checkRevision++;
  clearTimeout(timer);
  timer = setTimeout(run, 150);
}
async function run() {
  if (!context.available() || !session || composing) return;
  if (!session.editor.isConnected || !isField(session.editor)) {
    deactivate();
    return;
  }
  const text = read(session.editor);
  const nextCheckKey = JSON.stringify([
    text,
    enabled(),
    settings.languageMode,
    settings.dialect,
    settings.categories,
    settings.dictionary,
  ]);
  if (
    session.checkKey === nextCheckKey &&
    !session.checking &&
    !session.checkError
  ) {
    sendState();
    render();
    position();
    return;
  }
  if (text !== session.text) {
    if (!undoState || undoState.after !== text) status = "";
    if (session.rewrite) {
      cancelRewrite(false);
      session.rewrite = undefined;
    }
    // Selection can already describe the newly committed DOM while this
    // debounced check still holds the previous draft. Keep that valid range.
    if (selection?.editor !== session.editor || selection.text !== text)
      selection = null;
    session.dismissed.clear();
    session.version++;
    session.text = text;
  }
  const current = session;
  current.checkKey = nextCheckKey;
  const revision = ++checkRevision;
  current.issues = [];
  current.checkError = undefined;
  current.checking = !!enabled();
  sendState();
  render();
  position();
  if (enabled()) {
    try {
      // During a cold start or a difficult spelling search, retain only the latest
      // pending draft for this frame instead of sending a backlog of old inputs.
      const request = checkQueue.then(() => {
        if (session !== current || revision !== checkRevision) return null;
        return context.call(() =>
          chrome.runtime.sendMessage({
            type: "CHECK_TEXT",
            text: text.slice(0, 20000),
          }),
        );
      });
      checkQueue = request.catch(() => {});
      const result = await request;
      if (
        session !== current ||
        revision !== checkRevision ||
        !current.editor.isConnected ||
        read(current.editor) !== text
      )
        return;
      if (result?.retryAfterMs) {
        current.language = result.language;
        sendState();
        render();
        position();
        // Only the local engine's bounded startup state retries automatically.
        // Typing replaces this timer, and context teardown cancels it as usual.
        timer = setTimeout(
          run,
          Math.min(3000, Math.max(500, result.retryAfterMs)),
        );
        return;
      }
      current.language = result?.language ?? current.language;
      if (!result?.ok)
        throw new Error(result?.error || "Local grammar check unavailable.");
      current.issues = result.issues;
      current.language = result.language;
    } catch (error) {
      if (session !== current || revision !== checkRevision) return;
      current.checkError =
        error instanceof Error
          ? error.message
          : "Local grammar check unavailable.";
    }
  }
  if (session !== current || revision !== checkRevision) return;
  current.checking = false;
  selected = Math.min(selected, Math.max(0, filtered().length - 1));
  sendState();
  render();
  position();
}
function button(
  label: string,
  cls: string,
  action: () => void,
  title?: string,
) {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) {
    b.title = title;
    b.setAttribute("aria-label", title);
  }
  b.addEventListener("click", () => {
    if (context.available()) action();
  });
  return b;
}
function render() {
  const openDetails = [
    ...ui.querySelectorAll<HTMLDetailsElement>(".panel details[open]"),
  ].map((node) => ({
    className: node.className,
    label: node.querySelector("summary")?.textContent,
    issue: node.closest<HTMLElement>(".card")?.dataset.issueId,
  }));
  const focused = shadow.activeElement;
  const restore =
    focused instanceof HTMLButtonElement && focused.closest(".panel");
  const label = restore ? focused.ariaLabel || focused.textContent : null;
  renderSurface();
  for (const node of ui.querySelectorAll<HTMLDetailsElement>(
    ".panel details",
  )) {
    if (
      openDetails.some(
        (previous) =>
          previous.className === node.className &&
          previous.label === node.querySelector("summary")?.textContent &&
          previous.issue ===
            node.closest<HTMLElement>(".card")?.dataset.issueId,
      )
    )
      node.open = true;
  }
  if (restore && panelOpen) {
    const controls = [
      ...shadow.querySelectorAll<HTMLButtonElement>(
        ".panel button:not(:disabled)",
      ),
    ];
    (
      controls.find(
        (button) => (button.ariaLabel || button.textContent) === label,
      ) ??
      shadow.querySelector<HTMLButtonElement>(
        ".rewrite-box button:not(:disabled)",
      ) ??
      controls[0]
    )?.focus({ preventScroll: true });
  }
}
function renderSurface() {
  host.dataset.theme = resolvedTheme(settings?.theme ?? "system");
  host.style.colorScheme = host.dataset.theme;
  const editingPrompt = shadow.activeElement;
  if (
    session &&
    enabled() &&
    panelOpen &&
    editingPrompt?.closest(".prompt-manager") &&
    (editingPrompt instanceof HTMLInputElement ||
      editingPrompt instanceof HTMLTextAreaElement)
  )
    return;
  wordTargets = [];
  ui.replaceChildren();
  marks.replaceChildren();
  if (!session || !enabled()) {
    selectionActions.replaceChildren();
    clearWordHover();
    return;
  }
  ensureHost();
  const issues = visibleIssues();
  const announce = el(
    "span",
    "visually-hidden",
    session.rewrite?.phase === "loading"
      ? isTranslation(session.rewrite.style)
        ? "Translating…"
        : "Rewriting…"
      : status,
  );
  announce.setAttribute("role", "status");
  ui.append(announce);
  if (!panelOpen) return;
  const panel = el("section", "panel");
  panel.setAttribute("aria-label", "grammai writing assistant");
  const head = el("div", "head");
  const logo = el("img", "brand-icon");
  logo.src = chrome.runtime.getURL("brand/icon.png");
  logo.alt = "";
  logo.width = logo.height = 26;
  head.append(logo, el("span", "title", "grammai"));
  const tools = el("div", "head-actions");
  tools.append(
    undoButton(!!undoState && read(session.editor) === undoState.after, () => {
      void undo();
    }),
    button(
      "⚙",
      "icon",
      () => notify({ type: "OPEN_SETTINGS" }),
      "Open settings",
    ),
    button("×", "icon", () => closePanel(), "Close assistant"),
  );
  head.append(tools);
  panel.append(head);
  if (!compact) {
    const tabs = el("div", "rewrite-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Writing tools");
    for (const mode of ["suggestions", "rewrite", "translate"] as const) {
      const tab = button(
        mode === "suggestions"
          ? "Suggestions"
          : mode === "rewrite"
            ? "Rewrite"
            : "Translate",
        "rewrite-tab",
        () => {
          panelMode = mode;
          render();
          position();
        },
      );
      tab.setAttribute("role", "tab");
      tab.tabIndex = panelMode === mode ? 0 : -1;
      tab.setAttribute("aria-selected", String(panelMode === mode));
      tabs.append(tab);
    }
    panel.append(tabs);
  } else panel.classList.add("compact");
  if (panelMode === "rewrite" || panelMode === "translate") {
    const callbacks = {
      generate: startRewrite,
      apply: applyRewrite,
      cancel: () => cancelRewrite(),
      promptsChanged: async () => {
        settings = await getSettings();
        render();
        position();
      },
    };
    panel.append(
      panelMode === "translate"
        ? translationPane(session.rewrite, callbacks, !!session.text.trim())
        : rewritePane(
            session.rewrite,
            callbacks,
            !!session.text.trim(),
            settings.customPrompts,
          ),
    );
    panel.append(assistantFooter());
    ui.append(panel);
    return;
  }
  if (!compact && issues.length > 1) {
    const filters = el("div", "filters");
    for (const f of [
      "all",
      "correctness",
      "clarity",
      "engagement",
      "delivery",
    ] as const) {
      const count =
        f === "all"
          ? issues.length
          : issues.filter((i) => i.category === f).length;
      if (!count) continue;
      const b = button(
        `${f === "all" ? "All" : categoryLabels[f]} ${count}`,
        "chip",
        () => {
          filter = f;
          selected = 0;
          render();
          position();
        },
      );
      b.setAttribute("aria-pressed", String(filter === f));
      filters.append(b);
    }
    panel.append(filters);
  }
  const shown = filtered();
  selected = Math.min(selected, Math.max(0, shown.length - 1));
  const heading = el("div", "section-title");
  heading.append(
    el(
      "span",
      "",
      session.checking
        ? "Checking…"
        : session.checkError
          ? "Check unavailable"
          : "Suggestions",
    ),
  );
  const nav = el("div", "nav");
  nav.append(
    el(
      "span",
      "count",
      shown.length ? `${selected + 1} / ${shown.length}` : "0",
    ),
  );
  const prev = button(
    "‹",
    "icon",
    () => navigateCorrection(-1),
    "Previous suggestion",
  );
  const next = button(
    "›",
    "icon",
    () => navigateCorrection(1),
    "Next suggestion",
  );
  prev.disabled = next.disabled = shown.length < 2;
  nav.append(prev, next);
  heading.append(nav);
  panel.append(heading);
  if (session.text.length > 20000)
    panel.append(el("p", "notice", "Checking the first 20,000 characters."));
  const issue = shown[selected];
  if (issue) panel.append(card(issue));
  else {
    const empty = el("div", "empty");
    empty.append(
      el(
        "h3",
        "",
        session.checking
          ? "Checking…"
          : session.checkError
            ? "Check unavailable"
            : issues.length
              ? "No suggestions in this category"
              : "No suggestions",
      ),
    );
    if (session.checkError)
      empty.append(
        el("p", "", session.checkError),
        button("Retry", "text-btn", () => schedule()),
      );
    panel.append(empty);
  }
  const actions = el("div", "suggestion-footer");
  actions.append(
    button(
      "Check context",
      "text-btn context-check",
      () => startRewrite("fix"),
      "Check context with AI",
    ),
  );
  if (compact)
    actions.append(
      button(`All ${issues.length} suggestions`, "text-btn", () => {
        compact = false;
        render();
        position();
      }),
    );
  else if (shown.length > 1)
    actions.append(
      button(
        listOpen ? "Hide list" : "Show all suggestions",
        "text-btn",
        () => {
          listOpen = !listOpen;
          render();
          position();
        },
      ),
    );
  panel.append(actions);
  if (listOpen && !compact) {
    const list = el("div", "list");
    shown.forEach((i, index) => {
      const b = button(
        i.original + " → " + (i.replacements[0] ?? "Review"),
        "list-item",
        () => {
          selected = index;
          listOpen = false;
          render();
          position();
        },
      );
      list.append(b);
    });
    panel.append(list);
  }
  if (!compact) panel.append(assistantFooter());
  ui.append(panel);
}
function closePanel() {
  panelOpen = false;
  render();
  position();
  session?.editor.focus({ preventScroll: true });
}
function assistantFooter() {
  const foot = el("div", "assistant-footer");
  foot.append(shortcutHelp(), feedbackLink());
  return foot;
}
function shortcutHelp() {
  const help = el("details", "shortcut-help");
  help.append(el("summary", "", "Keyboard shortcuts"));
  for (const action of SHORTCUT_ACTIONS) {
    const row = el("div", "shortcut-row");
    row.append(
      el("span", "", action.label),
      el("kbd", "", formatCombo(settings.shortcuts[action.id])),
    );
    help.append(row);
  }
  return help;
}
function navigateCorrection(direction: number) {
  if (!session || !enabled() || composing || !isField(session.editor)) return;
  const wasOpen = panelOpen && panelMode === "suggestions";
  filter = "all";
  const issues = filtered();
  if (!issues.length) return;
  selected = wasOpen
    ? (selected + direction + issues.length) % issues.length
    : direction > 0
      ? 0
      : issues.length - 1;
  panelMode = "suggestions";
  panelOpen = true;
  compact = true;
  // Reveal the actual passage while retaining the editor's controlled selection.
  const target = editorRange(
    session.editor,
    issues[selected].offset,
    issues[selected].length,
  );
  target?.startContainer.parentElement?.scrollIntoView({
    block: "nearest",
    inline: "nearest",
  });
  render();
  position();
}
function card(issue: Issue) {
  const c = el("article", "card");
  c.dataset.issueId = issue.id;
  c.append(el("h3", "", issue.shortMessage || categoryLabels[issue.category]));
  const diff = el("div", "diff");
  diff.append(
    el("span", "old", issue.original),
    el("span", "arrow", "→"),
    el(
      "span",
      "replacement",
      issue.replacements.length
        ? issue.replacements[0] || "Remove"
        : "Check spelling",
    ),
  );
  c.append(diff);
  const actions = el("div", "actions");
  if (issue.replacements.length)
    actions.append(
      button(
        "Accept",
        "accept",
        () => apply(issue, issue.replacements[0]),
        "Accept suggestion",
      ),
    );
  actions.append(button("Dismiss", "text-btn", () => dismiss(issue)));
  if (issue.kind === "spelling")
    actions.append(
      button(
        "＋ Dictionary",
        "text-btn dictionary",
        async () => {
          const next = await context.call(() =>
            updateSettings({
              dictionary: [
                ...new Set([...settings.dictionary, issue.original]),
              ],
            }),
          );
          if (next) {
            settings = next;
            status = "Added to dictionary";
            run();
          }
        },
        "Add to dictionary",
      ),
    );
  c.append(actions);
  if (issue.message) {
    const explanation = el("details", "explanation");
    explanation.append(el("summary", "", "Why?"), el("p", "", issue.message));
    c.append(explanation);
  }
  return c;
}
function textRange(
  editor: Editor,
  offset: number,
  length: number,
): Range | null {
  return editorRange(editor, offset, length);
}
async function replace(editor: Editor, issue: Issue, replacement: string) {
  if (
    !(editor instanceof HTMLTextAreaElement) &&
    !(editor instanceof HTMLInputElement)
  )
    replacement = replacement.replaceAll("\u00a0", " ");
  const before = read(editor);
  if (
    before.slice(issue.offset, issue.offset + issue.length) !== issue.original
  )
    return false;
  editor.focus();
  const controlledDraft =
    !(editor instanceof HTMLTextAreaElement) &&
    !(editor instanceof HTMLInputElement) &&
    !!editor.querySelector('[data-contents="true"] [data-offset-key]');
  if (controlledDraft) {
    // A React 18 focus update restores its previous controlled selection.
    // Let it commit before installing the replacement range, otherwise that
    // focus commit collapses our new selection and paste appends the text.
    await Promise.resolve();
    if (
      !context.available() ||
      session?.editor !== editor ||
      !editor.isConnected ||
      read(editor) !== before ||
      document.activeElement !== editor
    )
      return false;
  }
  if (
    editor instanceof HTMLTextAreaElement ||
    editor instanceof HTMLInputElement
  ) {
    if (
      !editor.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertReplacementText",
          data: replacement,
        }),
      )
    )
      return false;
    const setter = Object.getOwnPropertyDescriptor(
      editor instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(
      editor,
      before.slice(0, issue.offset) +
        replacement +
        before.slice(issue.offset + issue.length),
    );
    editor.setSelectionRange(
      issue.offset + replacement.length,
      issue.offset + replacement.length,
    );
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertReplacementText",
        data: replacement,
      }),
    );
  } else {
    const range = textRange(editor, issue.offset, issue.length);
    if (!range) return false;
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    if (controlledDraft) {
      // Draft controls both its model and rendered leaves. execCommand updates
      // the DOM through its spellcheck path, which can leave nativeRenderedContent
      // stale: Backspace changes the model but no longer updates visible text.
      // Let Draft perform a normal paste/delete transaction instead. Publish the
      // programmatic range first so React's controlled selection is current.
      document.dispatchEvent(new Event("selectionchange"));
      await Promise.resolve();
      if (
        !context.available() ||
        !editor.isConnected ||
        session?.editor !== editor ||
        !enabled() ||
        !isField(editor) ||
        (document.activeElement !== editor &&
          !editor.contains(document.activeElement)) ||
        read(editor) !== before
      )
        return false;
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", replacement);
      const event = replacement
        ? new ClipboardEvent("paste", {
            clipboardData: clipboard,
            bubbles: true,
            cancelable: true,
            composed: true,
          })
        : new KeyboardEvent("keydown", {
            key: "Backspace",
            code: "Backspace",
            keyCode: 8,
            which: 8,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
      editor.dispatchEvent(event);
      // Never fall back to a native DOM mutation after a controlled editor
      // rejects a transaction; the draft must remain editable and in sync.
      if (!event.defaultPrevented) return false;
      // React 18 commits controlled state after the discrete event returns.
      // Verify after that commit before publishing success or recording Undo.
      await Promise.resolve();
    } else {
      // Plain contenteditable editors support native replacement and undo.
      if (!document.execCommand("insertText", false, replacement)) return false;
    }
  }
  return (
    read(editor) ===
    before.slice(0, issue.offset) +
      replacement +
      before.slice(issue.offset + issue.length)
  );
}
async function apply(issue: Issue, replacement: string) {
  if (!session || session.editing) return false;
  const current = session;
  if (read(current.editor) !== current.text) {
    status = "The draft changed. Suggestions refreshed.";
    run();
    return false;
  }
  const before = current.text;
  current.editing = true;
  try {
    if (!(await replace(current.editor, issue, replacement))) {
      if (session === current) {
        status = "This editor could not apply the suggestion.";
        run();
      }
      return false;
    }
    if (session !== current) return false;
    undoState = {
      editor: current.editor,
      before,
      after: read(current.editor),
      original: issue.original,
      issue: { ...issue, original: replacement, length: replacement.length },
    };
    status = "Suggestion accepted";
    run();
    return true;
  } finally {
    current.editing = false;
  }
}
async function undo() {
  if (!undoState || !session || session.editing) return false;
  const current = session;
  const u = undoState;
  if (current.editor !== u.editor || read(u.editor) !== u.after) {
    status = "The draft changed since this correction.";
    undoState = null;
    render();
    position();
    return false;
  }
  current.editing = true;
  try {
    if ((await replace(u.editor, u.issue, u.original)) && session === current) {
      undoState = null;
      status = "Correction undone";
      run();
      return true;
    }
    return false;
  } finally {
    current.editing = false;
  }
}
function dismiss(issue: Issue) {
  session?.dismissed.add(key(issue));
  status = "Suggestion dismissed";
  sendState();
  render();
  position();
}
function issueRects(
  issue: Pick<Issue, "offset" | "length">,
  offset = issue.offset,
  length = issue.length,
): DOMRect[] {
  if (!session) return [];
  const editor = session.editor;
  if (
    editor instanceof HTMLTextAreaElement ||
    editor instanceof HTMLInputElement
  ) {
    const range = document.createRange();
    const node = mirror.firstChild;
    if (!node || offset + length > (node.textContent?.length || 0)) return [];
    range.setStart(node, offset);
    range.setEnd(node, offset + length);
    return [...range.getClientRects()];
  }
  return [...(textRange(editor, offset, length)?.getClientRects() || [])];
}
function position() {
  if (!context.available()) return;
  wordTargets = [];
  marks.replaceChildren();
  if (!session || !enabled()) return;
  if (!session.editor.isConnected) {
    deactivate();
    return;
  }
  const editor = session.editor;
  const rect = editor.getBoundingClientRect();
  const inView =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < innerHeight;
  const panel = ui.querySelector<HTMLElement>(".panel");
  if (panel) {
    const width = panel.offsetWidth;
    panel.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, rect.right + 14 + width < innerWidth ? rect.right + 14 : rect.right - width))}px`;
    panel.style.top = `${Math.max(12, Math.min(innerHeight - panel.offsetHeight - 12, rect.top + 20))}px`;
  }
  if (!inView) {
    clearWordHover();
    return;
  }
  if (
    editor instanceof HTMLTextAreaElement ||
    editor instanceof HTMLInputElement
  ) {
    const cs = getComputedStyle(editor);
    for (const k of [
      "font",
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "lineHeight",
      "letterSpacing",
      "wordSpacing",
      "textAlign",
      "textIndent",
      "textTransform",
      "tabSize",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "borderStyle",
    ] as const)
      mirror.style[k] = cs[k];
    Object.assign(mirror.style, {
      boxSizing: "border-box",
      left: rect.left + "px",
      top: rect.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      whiteSpace: editor instanceof HTMLInputElement ? "pre" : "pre-wrap",
      overflowWrap:
        editor instanceof HTMLInputElement ? "normal" : "break-word",
      borderColor: "transparent",
    });
    if (editor instanceof HTMLInputElement) {
      // Native single-line inputs center their text inside the content box,
      // regardless of line-height. A div otherwise starts at the top padding.
      const contentHeight =
        rect.height -
        parseFloat(cs.borderTopWidth) -
        parseFloat(cs.borderBottomWidth) -
        parseFloat(cs.paddingTop) -
        parseFloat(cs.paddingBottom);
      mirror.style.lineHeight = `${Math.max(0, contentHeight)}px`;
    }
    mirror.textContent = session.text.slice(0, 20000);
    mirror.scrollTop = editor.scrollTop;
    mirror.scrollLeft = editor.scrollLeft;
  }
  for (const issue of visibleIssues().slice(0, 100)) {
    // Click the native text, not an overlay covering it. Expand partial-word
    // diagnoses (e.g. a lowercase first letter) to the whole word for hit testing.
    let start = issue.offset,
      end = issue.offset + issue.length;
    const wordCharacter = /[\p{L}\p{M}\p{N}'’]/u;
    while (start > 0 && wordCharacter.test(session.text[start - 1])) start--;
    while (end < session.text.length && wordCharacter.test(session.text[end]))
      end++;
    for (const r of issueRects(issue, start, end - start)) {
      const target = {
        issueId: issue.id,
        left: Math.max(r.left, rect.left, 0),
        right: Math.min(r.right, rect.right, innerWidth),
        top: Math.max(r.top, rect.top, 0),
        bottom: Math.min(r.bottom, rect.bottom, innerHeight),
      };
      if (target.right > target.left && target.bottom > target.top)
        wordTargets.push(target);
    }
    for (const r of issueRects(issue)) {
      const y = r.bottom - 1;
      if (y < rect.top || y > rect.bottom - 2 || y < 0 || y > innerHeight)
        continue;
      const x = Math.max(r.left, rect.left);
      const right = Math.min(r.right, rect.right);
      if (right <= x) continue;
      const line = button(
        "",
        "underline",
        () => {
          panelOpen = true;
          compact = true;
          panelMode = "suggestions";
          filter = "all";
          selected = visibleIssues().findIndex((i) => i.id === issue.id);
          render();
          position();
        },
        `${issue.shortMessage}: ${issue.original}`,
      );
      line.style.cssText = `left:${x}px;top:${y - 3}px;width:${right - x}px;border-color:var(--${issue.category})`;
      line.dataset.issueId = issue.id;
      marks.append(line);
    }
  }
  if (compact && panel && filtered()[selected]) {
    const target = wordTargets.find(
      (r) => r.issueId === filtered()[selected].id,
    );
    if (target) {
      panel.style.left = `${Math.max(12, Math.min(innerWidth - panel.offsetWidth - 12, target.left))}px`;
      panel.style.top = `${Math.max(12, target.bottom + 8 + panel.offsetHeight < innerHeight ? target.bottom + 8 : target.top - panel.offsetHeight - 8)}px`;
    }
  }
  updateWordHover(true);
  positionSelectionActions();
}

function clearWordHover() {
  hoveredIssueId = undefined;
  hoverMarks.replaceChildren();
  if (cursorOverride) {
    const { editor, value, priority } = cursorOverride;
    if (editor.style.getPropertyValue("cursor") === "pointer") {
      if (value) editor.style.setProperty("cursor", value, priority);
      else editor.style.removeProperty("cursor");
    }
    cursorOverride = null;
  }
}

function issueAtPoint(x: number, y: number) {
  return wordTargets.find(
    (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
  );
}

function updateWordHover(force = false) {
  if (
    !session ||
    !pointer ||
    !enabled() ||
    composing ||
    wordPress?.moved ||
    read(session.editor) !== session.text
  ) {
    clearWordHover();
    return;
  }
  const hit = document.elementFromPoint(pointer.x, pointer.y);
  const overMark =
    hit === host &&
    shadow
      .elementFromPoint(pointer.x, pointer.y)
      ?.classList.contains("underline");
  const target =
    fieldFrom(hit) === session.editor || overMark
      ? issueAtPoint(pointer.x, pointer.y)
      : undefined;
  if (!target) {
    clearWordHover();
    return;
  }
  const issue = visibleIssues().find((i) => i.id === target.issueId);
  if (!issue) {
    clearWordHover();
    return;
  }
  if (!force && hoveredIssueId === issue.id) return;
  hoveredIssueId = issue.id;
  hoverMarks.replaceChildren();
  for (const rect of wordTargets.filter((r) => r.issueId === issue.id)) {
    const mark = el("span", "word-highlight");
    mark.dataset.issueId = issue.id;
    mark.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.right - rect.left}px;height:${rect.bottom - rect.top}px;--highlight:var(--${issue.category})`;
    hoverMarks.append(mark);
  }
  if (!cursorOverride) {
    cursorOverride = {
      editor: session.editor,
      value: session.editor.style.getPropertyValue("cursor"),
      priority: session.editor.style.getPropertyPriority("cursor"),
    };
    session.editor.style.setProperty("cursor", "pointer", "important");
  }
}

function openWordSuggestion(event: MouseEvent) {
  const press = wordPress;
  wordPress = null;
  if (
    !press ||
    press.moved ||
    event.button !== 0 ||
    event.detail !== 1 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !session ||
    session.editor !== press.editor ||
    fieldFrom(event.target) !== press.editor ||
    Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5 ||
    read(press.editor) !== session.text
  )
    return;
  // Let native caret placement, shift-click, double-click and drag selection work.
  if (
    press.editor instanceof HTMLTextAreaElement ||
    press.editor instanceof HTMLInputElement
  ) {
    if (press.editor.selectionStart !== press.editor.selectionEnd) return;
  } else if (getSelection()?.isCollapsed === false) return;
  const target = wordTargets.find(
    (r) =>
      event.clientX >= r.left &&
      event.clientX <= r.right &&
      event.clientY >= r.top &&
      event.clientY <= r.bottom,
  );
  if (!target) return;
  const index = visibleIssues().findIndex(
    (issue) => issue.id === target.issueId,
  );
  if (index < 0) return;
  panelOpen = true;
  compact = true;
  panelMode = "suggestions";
  filter = "all";
  selected = index;
  render();
  position();
}
function rememberSelection(updateToolbar = true) {
  if (!session || document.activeElement === host) return;
  const editor = session.editor;
  const previous = selection;
  if (
    document.activeElement !== editor &&
    !editor.contains(document.activeElement)
  )
    return;
  if (
    editor instanceof HTMLTextAreaElement ||
    editor instanceof HTMLInputElement
  ) {
    const start = editor.selectionStart ?? 0,
      end = editor.selectionEnd ?? 0;
    selection =
      end > start
        ? { editor, text: read(editor), offset: start, length: end - start }
        : null;
  } else {
    const sel = getSelection();
    const offsets = sel?.rangeCount
      ? selectedOffsets(editor, sel.getRangeAt(0))
      : null;
    selection = offsets ? { editor, text: read(editor), ...offsets } : null;
  }
  if (
    !selection ||
    previous?.editor !== selection.editor ||
    previous.offset !== selection.offset ||
    previous.length !== selection.length ||
    previous.text !== selection.text
  )
    selectionDismissed = false;
  if (updateToolbar) positionSelectionActions();
}
function positionSelectionActions() {
  selectionActions.replaceChildren();
  if (
    !selection ||
    selectionDismissed ||
    !session ||
    !enabled() ||
    panelOpen ||
    !isField(session.editor) ||
    selection.editor !== session.editor ||
    selection.text !== read(session.editor) ||
    !selection.text
      .slice(selection.offset, selection.offset + selection.length)
      .trim() ||
    (document.activeElement !== session.editor &&
      !session.editor.contains(document.activeElement) &&
      document.activeElement !== host)
  )
    return;
  // The saved range also supports clicking the toolbar without losing the selection.
  if (document.activeElement !== host) {
    if (
      session.editor instanceof HTMLTextAreaElement ||
      session.editor instanceof HTMLInputElement
    ) {
      if (session.editor.selectionStart === session.editor.selectionEnd) return;
    } else if (getSelection()?.isCollapsed !== false) return;
  }
  const field = session.editor.getBoundingClientRect();
  const range =
    session.editor instanceof HTMLTextAreaElement ||
    session.editor instanceof HTMLInputElement
      ? null
      : textRange(session.editor, selection.offset, selection.length);
  const rect =
    range?.getBoundingClientRect() ??
    (selection.text === session.text ? issueRects(selection)[0] : null) ??
    field;
  if (
    rect.bottom < 0 ||
    rect.top > innerHeight ||
    field.width <= 0 ||
    field.height <= 0
  )
    return;
  if (session.rewrite?.phase === "loading") {
    selectionActions.append(
      el(
        "span",
        "selection-progress",
        isTranslation(session.rewrite.style) ? "Translating…" : "Rewriting…",
      ),
      button("Cancel", "selection-action", () => cancelRewrite()),
    );
  } else {
    const rewrite = button("Rewrite", "selection-action", () => {
      panelOpen = true;
      compact = false;
      panelMode = "rewrite";
      render();
      position();
    });
    const translate = button("Translate", "selection-action", () => {
      compact = false;
      startRewrite("translate-auto");
    });
    rewrite.ariaLabel = "Rewrite";
    translate.ariaLabel = "Translate";
    rewrite.append(el("kbd", "", formatCombo(settings.shortcuts.rewrite)));
        translate.append(el("kbd", "", formatCombo(settings.shortcuts.translate)));
    selectionActions.append(rewrite, translate);
  }
  const width = selectionActions.offsetWidth;
  const height = selectionActions.offsetHeight;
  selectionActions.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left))}px`;
  selectionActions.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, rect.top >= height + 12 ? rect.top - height - 8 : rect.bottom + 8))}px`;
}
function cancelRewrite(refresh = true) {
  if (session?.rewrite?.phase === "loading")
    notify({ type: "AI_CANCEL", requestId: session.rewrite.requestId });
  if (session) session.rewrite = undefined;
  if (refresh) {
    sendState();
    render();
    position();
  }
}
async function startRewrite(
  style: RewriteStyle = "improve",
  customPromptId?: string,
) {
  if (!session || !enabled()) return;
  const savedSelection = selection;
  if (read(session.editor) !== session.text) run();
  if (!session) return;
  const current = session;
  const source = current.text;
  const previous = current.rewrite;
  const picked =
    savedSelection?.editor === current.editor && savedSelection.text === source
      ? savedSelection
      : previous?.phase === "ready" &&
          previous.source === source &&
          previous.scope === "selection"
        ? { offset: previous.offset, length: previous.length }
        : null;
  const offset = picked?.offset ?? 0,
    length = picked?.length ?? source.length;
  const text = source.slice(offset, offset + length);
  cancelRewrite(false);
  const requestId = crypto.randomUUID();
  current.rewrite = {
    phase: "loading",
    style,
    customPromptId,
    scope: picked ? "selection" : "field",
    original: text,
    source,
    offset,
    length,
    requestId,
  };
  if (isTranslation(style)) {
    if (panelMode !== "translate") panelOpen = false;
    session.editor.focus({ preventScroll: true });
  } else {
    panelMode = "rewrite";
    panelOpen = true;
  }
  compact = false;

  status = "";
  if (!text.trim() || text.length > 12000) {
    current.rewrite.phase = "error";
    current.rewrite.error =
      "Select between 1 and 12,000 characters to rewrite.";
    sendState();
    render();
    position();
    return;
  }
  sendState();
  render();
  position();
  try {
    const response = await context.call(() =>
      chrome.runtime.sendMessage({
        type: "AI_REWRITE",
        text,
        style,
        customPromptId,
        requestId,
      }),
    );
    if (session !== current || current.rewrite?.requestId !== requestId) return;
    if (read(current.editor) !== source) {
      current.rewrite = undefined;
      status = "The draft changed. Generate a new rewrite.";
      run();
      return;
    }
    if (
      !response?.ok ||
      typeof response.text !== "string" ||
      !response.text.trim()
    )
      throw new Error(
        response?.error || "The provider returned no rewrite. Try again.",
      );
    current.rewrite = {
      ...current.rewrite,
      phase: "ready",
      result: response.text,
      provider: response.provider,
      model: response.model,
      targetLanguage: response.targetLanguage,
    };
    if (isTranslation(style)) {
      await applyRewrite();
      return;
    }
  } catch (error) {
    if (session !== current || current.rewrite?.requestId !== requestId) return;
    current.rewrite.phase = "error";
    current.rewrite.error =
      error instanceof Error ? error.message : "The rewrite failed. Try again.";
    if (isTranslation(style)) {
      panelMode = "translate";
      panelOpen = true;
    }
  }
  sendState();
  render();
  position();
}
async function applyRewrite() {
  if (
    !session?.rewrite ||
    session.editing ||
    session.rewrite.phase !== "ready" ||
    session.rewrite.result === undefined
  )
    return false;
  const rewrite = session.rewrite;
  if (read(session.editor) !== rewrite.source) {
    cancelRewrite(false);
    status = "The draft changed. Generate a new rewrite.";
    run();
    return false;
  }
  const issue: Issue = {
    id: rewrite.requestId,
    ruleId: "rewrite",
    offset: rewrite.offset,
    length: rewrite.length,
    original: rewrite.original ?? "",
    replacements: [rewrite.result!],
    message: isTranslation(rewrite.style) ? "AI translation" : "AI rewrite",
    shortMessage: isTranslation(rewrite.style) ? "Translation" : "Rewrite",
    category: "clarity",
    kind: "style",
  };
  const current = session;
  const ok = await apply(issue, rewrite.result!);
  if (session !== current) return false;
  if (ok && session === current) current.rewrite = undefined;
  if (!ok && session?.rewrite) {
    panelMode = isTranslation(rewrite.style) ? "translate" : "rewrite";
    panelOpen = true;
  }
  if (ok && isTranslation(rewrite.style)) {
    panelOpen = false;
  }
  status = ok
    ? isTranslation(rewrite.style)
      ? "Translation applied"
      : "Rewrite applied"
    : "The rewrite could not be applied. Your editor may have changed.";
  sendState();
  render();
  position();
  if (ok && isTranslation(rewrite.style))
    current.editor.focus({ preventScroll: true });
  return ok;
}
async function start() {
  const initial = await context.call(getSettings);
  if (!initial) return;
  settings = initial;
  listen(document, "selectionchange", () => rememberSelection());
  matchMedia("(prefers-color-scheme: dark)").addEventListener(
    "change",
    () => {
      if (context.available()) render();
    },
    { signal: listeners.signal },
  );
  listen(
    document,
    "copy",
    () => {
      if (!selection) return;
      selectionDismissed = true;
      selectionActions.replaceChildren();
    },
    true,
  );
  listen(
    document,
    "focusin",
    (event) => {
      if (event.composedPath().includes(host)) return;
      const field = fieldFrom(event.target);
      if (field) activate(field);
      else if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      )
        deactivate();
      else {
        selection = null;
        positionSelectionActions();
      }
    },
    true,
  );
  // React/Draft.js may stop bubbling. Capture input before page handlers and
  // resolve the current editing host again if the framework replaced it.
  listen(
    document,
    "input",
    (event) => {
      const field = fieldFrom(event.target);
      if (field && !composing) {
        clearWordHover();
        activate(field);
      }
    },
    true,
  );
  listen(
    document,
    "pointerdown",
    (event) => {
      wordPress = null;
      pointer = { x: event.clientX, y: event.clientY };
      if (event.composedPath().includes(host)) {
        // Keep the pressed toolbar button in the DOM until its click fires.
        rememberSelection(false);
        return;
      }
      const editor = fieldFrom(event.target);
      if (editor !== session?.editor) {
        selection = null;
        selectionActions.replaceChildren();
      }
      if (
        editor &&
        event.button === 0 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      )
        wordPress = {
          editor,
          x: event.clientX,
          y: event.clientY,
          moved: false,
        };
      if (panelOpen) {
        panelOpen = false;
        render();
        position();
      }
    },
    true,
  );
  listen(
    document,
    "pointermove",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (
        wordPress &&
        Math.hypot(event.clientX - wordPress.x, event.clientY - wordPress.y) > 5
      )
        wordPress.moved = true;
      updateWordHover();
    },
    { passive: true, capture: true },
  );
  listen(
    document,
    "pointercancel",
    () => {
      wordPress = null;
    },
    true,
  );
  listen(document, "click", openWordSuggestion, true);
  listen(document, "pointerleave", () => {
    pointer = null;
    clearWordHover();
  });
  // Clicks into another frame or the browser chrome do not reach this document.
  listen(window, "blur", () => {
    selectionActions.replaceChildren();
    pointer = null;
    clearWordHover();
    if (panelOpen) {
      panelOpen = false;
      render();
    }
  });
  listen(
    document,
    "keydown",
    (event) => {
      const ownControl = event.composedPath().includes(host);
      const editingPrompt =
        ownControl && shadow.activeElement?.closest(".prompt-manager");
      const field = fieldFrom(event.target);
      const action =
              !editingPrompt && !composing && (field || ownControl)
                ? shortcutForEvent(event, settings.shortcuts)
                : null;
      if (action && session && enabled() && isField(session.editor)) {
        if (field && field !== session.editor) activate(field);
        event.preventDefault();
                event.stopPropagation();
                if (action === "close") {
                  if (panelOpen) {
                    panelOpen = false;
                    render();
                    position();
                    session?.editor.focus();
                  } else {
                    selectionDismissed = true;
                    selectionActions.replaceChildren();
                  }
                  return;
                }
                if (action === "translate") {
          rememberSelection();
          void startRewrite("translate-auto");
        }
        if (action === "rewrite") {
          rememberSelection();
          panelOpen = true;
          compact = false;
          panelMode = "rewrite";
          render();
          position();
          shadow.querySelector<HTMLElement>(".rewrite-choice")?.focus();
        }
        if (action === "assistant") {
          panelOpen = !panelOpen;
          compact = false;
          panelMode = "suggestions";
          render();
          position();
        }
        if (action === "next" || action === "previous")
          navigateCorrection(action === "next" ? 1 : -1);
        if (action === "accept" && panelOpen && panelMode === "suggestions") {
          const issue = filtered()[selected];
          if (issue?.replacements.length)
            void apply(issue, issue.replacements[0]);
        }
        if (action === "dismiss" && panelOpen && panelMode === "suggestions") {
          const issue = filtered()[selected];
          if (issue) dismiss(issue);
        }
        if (action === "undo") void undo();
        return;
      }
      // Arrow keys change tabs, and Enter applies a rewrite preview without mouse input.
      const tab = ownControl ? shadow.activeElement : null;
      if (
        tab?.getAttribute("role") === "tab" &&
        ["ArrowLeft", "ArrowRight"].includes(event.key)
      ) {
        event.preventDefault();
        const modes = ["suggestions", "rewrite", "translate"] as const;
        panelMode =
          modes[
            (modes.indexOf(panelMode) + (event.key === "ArrowRight" ? 1 : 2)) %
              3
          ];
        render();
        position();
        shadow
          .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
          ?.focus();
        return;
      }
      if (
        fieldFrom(event.target) &&
        (/^(Arrow|Home|End)/.test(event.key) ||
          ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a"))
      )
        selectionDismissed = false;
      if (
              fieldFrom(event.target) &&
              (event.key.length === 1 ||
                ["Backspace", "Delete", "Enter"].includes(event.key))
            ) {
              clearWordHover();
            }
          },
          true,
        );
  listen(document, "keyup", (event) => {
    if (
      fieldFrom(event.target) &&
      (/^(Arrow|Home|End)/.test(event.key) ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a"))
    )
      rememberSelection();
  });
  observe(
    new MutationObserver(() => {
      if (!context.available()) return;
      if (session && !session.editor.isConnected) deactivate();
    }),
  ).observe(document.documentElement, { childList: true, subtree: true });
  listen(window, "scroll", position, { capture: true, passive: true });
  listen(window, "resize", position);
  chrome.storage.onChanged.addListener(async (changes) => {
    if (!context.available()) return;
    if (changes.settings) {
      const next = await context.call(getSettings).catch(() => undefined);
      if (!next) return;
      settings = next;
      run();
    }
  });
  chrome.runtime.onMessage.addListener((m, _sender, respond) => {
    if (!context.available()) return;
    if (m.type === "REQUEST_STATE") {
      sendState();
      respond({ ok: !!session });
      return;
    }
    if (
          ![
        "APPLY",
        "DISMISS",
        "FOCUS_ISSUE",
        "REWRITE_START",
        "REWRITE_APPLY",
        "REWRITE_CANCEL",
        "UNDO",
      ].includes(m.type)
    )
      return;
    if (
      !session ||
      m.editorId !== session.id ||
      m.version !== session.version ||
      read(session.editor) !== session.text
    ) {
      run();
      respond({
        ok: false,
        error: "The draft changed. Suggestions refreshed.",
      });
      return;
    }
    if (m.type === "REWRITE_START") {
      panelMode = "rewrite";
      startRewrite(m.style, m.customPromptId);
      respond({ ok: true });
      return;
    }
    if (m.type === "UNDO" || m.type === "REWRITE_APPLY") {
      const operation = m.type === "UNDO" ? undo() : applyRewrite();
      operation
        .then((ok) => respond({ ok }))
        .catch(() => respond({ ok: false }));
      return true;
    }
    if (m.type === "REWRITE_CANCEL") {
      cancelRewrite();
      respond({ ok: true });
      return;
    }
    const issue = visibleIssues().find((i) => i.id === m.issueId);
    if (!issue) {
      respond({ ok: false });
      return;
    }
    if (m.type === "APPLY") {
      if (!issue.replacements.length) {
        respond({ ok: false });
        return;
      }
      apply(issue, issue.replacements[0])
        .then((ok) => respond({ ok }))
        .catch(() => respond({ ok: false }));
      return true;
    } else if (m.type === "DISMISS") {
      dismiss(issue);
      respond({ ok: true });
    } else {
      panelOpen = true;
      filter = "all";
      selected = visibleIssues().findIndex((i) => i.id === issue.id);
      render();
      position();
      respond({ ok: true });
    }
  });
  const current = fieldFrom(document.activeElement);
  if (current) activate(current);
}
start().catch(() => {
  context.available();
});
