import { feedbackLink } from "./support";
import {
  SHORTCUT_ACTIONS,
  comboFromEvent,
  defaultShortcuts,
  formatCombo,
  normalizeCombo,
} from "./shortcuts";
import { initializePageTheme } from "./theme";
import { promptManager } from "./prompt-manager";
import { rewriteStyles } from "./rewrite-ui";
import { getSettings, updateSettings, type Settings } from "./shared";

type Category = keyof Settings["categories"];
const enabled = document.querySelector<HTMLInputElement>("#enabled")!;
const dialect = document.querySelector<HTMLSelectElement>("#dialect")!;
const languageMode =
  document.querySelector<HTMLSelectElement>("#language-mode")!;
const translatePartner =
  document.querySelector<HTMLSelectElement>("#translate-partner")!;
const aiProvider = document.querySelector<HTMLSelectElement>("#ai-provider")!;
const aiModel = document.querySelector<HTMLInputElement>("#ai-model")!;
const aiTest = document.querySelector<HTMLButtonElement>("#ai-test")!;
const aiStatus = document.querySelector<HTMLElement>("#ai-status")!;
const categoryToggles = [
  ...document.querySelectorAll<HTMLInputElement>(".category-toggle"),
];
const dictionaryForm =
  document.querySelector<HTMLFormElement>("#dictionary-form")!;
const dictionaryWord =
  document.querySelector<HTMLInputElement>("#dictionary-word")!;
const dictionaryList =
  document.querySelector<HTMLUListElement>("#dictionary-list")!;
const sitesList = document.querySelector<HTMLUListElement>("#sites-list")!;
const status = document.querySelector<HTMLElement>("#status")!;
const shortcutRoot =
  document.querySelector<HTMLElement>("#keyboard-shortcuts")!;
let settings: Settings;
let saveQueue = Promise.resolve();
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(message: string, error = false): void {
  clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.toggle("error", error);
  if (!error)
    statusTimer = setTimeout(() => {
      status.textContent = "";
    }, 3500);
}

function save(patch: Partial<Settings>, message = "Preferences saved."): void {
  settings = { ...settings, ...patch };
  render();
  saveQueue = saveQueue.then(async () => {
    try {
      await updateSettings(patch);
      showStatus(message);
    } catch {
      showStatus("Could not save. Reload the page and try again.", true);
    }
  });
}

function render(): void {
  document.querySelector<HTMLSelectElement>("#appearance")!.value =
    settings.theme;
  enabled.checked = settings.enabled;
  dialect.value = settings.dialect;
  languageMode.value = settings.languageMode;
  translatePartner.value = settings.translatePartner;
  aiProvider.value = settings.aiProvider;
  // Keep an unfinished model edit when another preference changes.
  if (document.activeElement !== aiModel) aiModel.value = settings.aiModel;
  for (const toggle of categoryToggles)
    toggle.checked = settings.categories[toggle.dataset.category as Category];
  dictionaryList.replaceChildren();
  document.querySelector<HTMLElement>("#dictionary-empty")!.hidden =
    settings.dictionary.length > 0;
  for (const word of [...settings.dictionary].sort((a, b) =>
    a.localeCompare(b),
  )) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = word;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-word";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${word} from dictionary`);
    remove.addEventListener("click", () =>
      save(
        { dictionary: settings.dictionary.filter((entry) => entry !== word) },
        `Removed “${word}”.`,
      ),
    );
    item.append(label, remove);
    dictionaryList.append(item);
  }
  const promptRoot = document.querySelector<HTMLElement>("#custom-prompts")!;
  promptRoot.replaceChildren(
    promptManager(settings.customPrompts, async () => {
      settings = await getSettings();
      render();
      showStatus("Saved prompts updated.");
    }),
  );
  sitesList.replaceChildren();
  document.querySelector<HTMLElement>("#sites-empty")!.hidden =
    settings.disabledSites.length > 0;
  for (const domain of [...settings.disabledSites].sort()) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = domain;
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "button";
    resume.textContent = "Resume checking";
    resume.setAttribute("aria-label", `Resume checking on ${domain}`);
    resume.addEventListener("click", () =>
      save(
        {
          disabledSites: settings.disabledSites.filter(
            (site) => site !== domain,
          ),
        },
        `Checking resumed on ${domain}.`,
      ),
    );
    item.append(label, resume);
        sitesList.append(item);
      }
      renderShortcuts();
    }

enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
dialect.addEventListener("change", () =>
  save({ dialect: dialect.value as Settings["dialect"] }),
);
languageMode.addEventListener("change", () =>
  save({ languageMode: languageMode.value as Settings["languageMode"] }),
);
translatePartner.addEventListener("change", () =>
  save({
    translatePartner: translatePartner.value as Settings["translatePartner"],
  }),
);
aiProvider.addEventListener("change", () => {
  save({ aiProvider: aiProvider.value as Settings["aiProvider"] });
  aiStatus.textContent =
    "Provider saved. Test the connection to check availability.";
  aiStatus.classList.remove("error");
});
aiModel.addEventListener("change", () => {
  aiModel.value = aiModel.value.trim();
  save({ aiModel: aiModel.value });
});
aiTest.addEventListener("click", async () => {
  aiTest.disabled = true;
  aiStatus.classList.remove("error");
  aiStatus.textContent = "Checking your installed AI tools…";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = (await Promise.race([
      chrome.runtime.sendMessage({ type: "AI_STATUS" }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "The connection check timed out. Check the native bridge installation and try again.",
              ),
            ),
          15000,
        );
      }),
    ])) as
      | {
          ok: boolean;
          error?: string;
          providers?: {
            id: "claude" | "codex";
            available: boolean;
            version?: string;
          }[];
        }
      | undefined;
    if (!response?.ok)
      throw new Error(
        response?.error ||
          "Could not reach the local bridge. Install the grammai native bridge, then try again.",
      );
    if (!Array.isArray(response.providers))
      throw new Error(
        "The local bridge returned an invalid response. Update the bridge and try again.",
      );
    const providers = response.providers.filter(
      (provider) => provider.id === "claude" || provider.id === "codex",
    );
    const selected = settings.aiProvider;
    const available = providers.some(
      (provider) =>
        provider.available && (selected === "auto" || selected === provider.id),
    );
    aiStatus.replaceChildren();
    for (const id of ["claude", "codex"] as const) {
      const provider = providers.find((entry) => entry.id === id);
      const line = document.createElement("span");
      line.className = "ai-provider-result";
      line.textContent = `${id === "claude" ? "Claude" : "Codex"}: ${provider?.available ? `detected${provider.version ? ` (${provider.version})` : ""}` : "not found"}`;
      aiStatus.append(line);
    }
    const summary = document.createElement("span");
    summary.className = "ai-provider-result";
    summary.textContent = available
      ? "Connection ready. Your CLI must also be signed in; a rewrite verifies account access."
      : selected === "auto"
        ? "Install and sign in to Claude Code or Codex, then test again."
        : `Install and sign in to ${selected === "claude" ? "Claude Code" : "Codex"}, or choose another provider.`;
    aiStatus.append(summary);
    if (response.error) {
      const detail = document.createElement("span");
      detail.className = "ai-provider-result";
      detail.textContent = response.error;
      aiStatus.append(detail);
    }
    aiStatus.classList.toggle("error", !available);
  } catch (error) {
    aiStatus.textContent =
      error instanceof Error
        ? error.message
        : "Could not check the AI connection. Verify the native bridge installation.";
    aiStatus.classList.add("error");
  } finally {
    clearTimeout(timer);
    aiTest.disabled = false;
  }
});
for (const toggle of categoryToggles) {
  toggle.addEventListener("change", () =>
    save({
      categories: {
        ...settings.categories,
        [toggle.dataset.category as Category]: toggle.checked,
      },
    }),
  );
}
dictionaryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const word = dictionaryWord.value.trim().normalize("NFC");
  if (!word || /\s/.test(word)) {
    showStatus("Enter one word without spaces.", true);
    dictionaryWord.focus();
    return;
  }
  if (
    settings.dictionary.some(
      (entry) => entry.toLocaleLowerCase() === word.toLocaleLowerCase(),
    )
  ) {
    showStatus("That word is already in your dictionary.");
    return;
  }
  save(
    { dictionary: [...settings.dictionary, word] },
    `Added “${word}” to your dictionary.`,
  );
  dictionaryWord.value = "";
  dictionaryWord.focus();
});

function renderShortcuts(): void {
  for (const action of SHORTCUT_ACTIONS) {
    const input = shortcutRoot.querySelector<HTMLInputElement>(
      `.shortcut-input[data-shortcut="${action.id}"]`,
    );
    if (input && document.activeElement !== input) {
      input.value = formatCombo(settings.shortcuts[action.id]);
    }
  }
}

function buildShortcuts(): void {
  shortcutRoot.replaceChildren();
  for (const action of SHORTCUT_ACTIONS) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const label = document.createElement("span");
    label.textContent = action.label;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "shortcut-input";
    input.dataset.shortcut = action.id;
    input.readOnly = true;
    input.value = formatCombo(settings.shortcuts[action.id]);
    input.setAttribute("aria-label", `${action.label} shortcut`);
    input.addEventListener("focus", () => {
      input.value = "";
      showStatus(`Press the keys for ${action.label}. Click away to cancel.`);
    });
    input.addEventListener("blur", () => {
      input.value = formatCombo(settings.shortcuts[action.id]);
    });
    input.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Escape with a modifier cancels capture; plain Escape is itself a valid combo.
      if (
        event.key === "Escape" &&
        (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey)
      ) {
        input.blur();
        return;
      }
      const combo = comboFromEvent(event);
      if (!combo) return;
      const clash = SHORTCUT_ACTIONS.find(
        (entry) =>
          entry.id !== action.id &&
          normalizeCombo(settings.shortcuts[entry.id]) === combo,
      );
      if (clash) {
        showStatus(`That shortcut is already used by ${clash.label}.`, true);
        return;
      }
      save({ shortcuts: { ...settings.shortcuts, [action.id]: combo } });
      input.value = formatCombo(combo);
      input.blur();
    });
    row.append(label, input);
    shortcutRoot.append(row);
  }
  const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "button";
    reset.id = "reset-shortcuts";
    reset.textContent = "Reset to defaults";
  reset.addEventListener("click", () => {
    save({ shortcuts: defaultShortcuts() }, "Shortcuts reset to defaults.");
  });
  shortcutRoot.append(reset);
}

async function initialize(): Promise<void> {
  const controls = [
    ...document.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >("input, select, button"),
  ];
  controls.forEach((control) => {
    control.disabled = true;
  });
  try {
    settings = await getSettings();
        render();
        buildShortcuts();
        controls.forEach((control) => {
      control.disabled = false;
    });
  } catch {
    showStatus("Could not load preferences. Reload this page to retry.", true);
  }
}

const promptStyles = document.createElement("style");
promptStyles.textContent = rewriteStyles;
document.head.append(promptStyles);
void initialize();

void initializePageTheme();

document
  .querySelector<HTMLSelectElement>("#appearance")!
  .addEventListener("change", (event) =>
    save({
      theme: (event.target as HTMLSelectElement).value as Settings["theme"],
    }),
  );
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.settings) {
    settings = await getSettings();
    renderShortcuts();
  }
});

document.querySelector("#feedback-link")!.append(feedbackLink());
