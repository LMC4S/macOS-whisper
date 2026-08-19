const shortcutButton = document.querySelector("#shortcutButton");
const micKeyToggle = document.querySelector("#micKeyToggle");
const autoPasteToggle = document.querySelector("#autoPasteToggle");
const notifyToggle = document.querySelector("#notifyToggle");
const livePreviewToggle = document.querySelector("#livePreviewToggle");
const engineSelect = document.querySelector("#engineSelect");
const openaiSection = document.querySelector("#openaiSection");
const mlxSection = document.querySelector("#mlxSection");
const appleHint = document.querySelector("#appleHint");
const mlxModelInput = document.querySelector("#mlxModelInput");
const saveEngineButton = document.querySelector("#saveEngineButton");
const apiKeyInput = document.querySelector("#apiKeyInput");
const saveApiKeyButton = document.querySelector("#saveApiKeyButton");
const apiKeyStatus = document.querySelector("#apiKeyStatus");
const localEngineText = document.querySelector("#localEngineText");
const installLocalEngineButton = document.querySelector("#installLocalEngineButton");
const removeLocalEngineButton = document.querySelector("#removeLocalEngineButton");
const openLocalEngineButton = document.querySelector("#openLocalEngineButton");
const statusText = document.querySelector("#statusText");

let localEngineInstalled = false;

function setStatus(message) {
  statusText.textContent = message || "";
}

function setBusy(isBusy) {
  for (const control of [
    engineSelect,
    saveEngineButton,
    saveApiKeyButton,
    installLocalEngineButton,
    openLocalEngineButton,
  ]) {
    control.disabled = isBusy;
  }
  removeLocalEngineButton.disabled = isBusy || !localEngineInstalled;
}

function shortcutLabel(accelerator) {
  return String(accelerator || "")
    .replace("Control", "⌃")
    .replace("Alt", "⌥")
    .replace("Shift", "⇧")
    .replace("Command", "⌘")
    .replaceAll("+", "");
}

function cleanErrorMessage(error) {
  return String(error?.message || error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/u,
    ""
  );
}

function applySettings(settings) {
  if (settings.shortcut) {
    shortcutButton.textContent =
      settings.micKeyEnabled && settings.shortcut === "F13"
        ? "Dictation Key"
        : shortcutLabel(settings.shortcut);
  }
  micKeyToggle.checked = Boolean(settings.micKeyEnabled);
  autoPasteToggle.checked = Boolean(settings.autoPaste);
  notifyToggle.checked = settings.notifications !== false;
  livePreviewToggle.checked = settings.livePreview === true;

  engineSelect.value = settings.engine || "openai";
  mlxModelInput.value = settings.mlxModel || "";
  openaiSection.hidden = engineSelect.value !== "openai";
  mlxSection.hidden = engineSelect.value !== "mlx";
  appleHint.hidden = engineSelect.value !== "apple";
  apiKeyStatus.textContent = settings.hasApiKey
    ? "A key is saved. Enter a new one to replace it."
    : "No key saved yet.";

  if (settings.version) {
    document.querySelector("#versionText").textContent = settings.version;
  }
}

function renderLocalEngineStatus(status) {
  localEngineInstalled = Boolean(status.installed);
  localEngineText.textContent = `${status.installed ? "Installed" : "Not installed"} — ${status.path}`;
  removeLocalEngineButton.disabled = !status.installed;
}

async function refreshLocalEngineStatus() {
  try {
    renderLocalEngineStatus(await window.verse.getLocalEngineStatus());
  } catch (error) {
    localEngineText.textContent = cleanErrorMessage(error);
  }
}

async function load() {
  try {
    applySettings(await window.verse.getSettings());
    await refreshLocalEngineStatus();
    setStatus("");
  } catch (error) {
    setStatus(cleanErrorMessage(error));
  }
}

// --- Shortcut recorder ---

const KEY_CODE_MAP = {
  Space: "Space",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Enter: "Return",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

function acceleratorKeyFromEvent(event) {
  const code = event.code;
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/u.test(code)) return code;
  if (/^Numpad[0-9]$/u.test(code)) return `num${code.slice(6)}`;
  return KEY_CODE_MAP[code] || null;
}

function acceleratorFromEvent(event) {
  const key = acceleratorKeyFromEvent(event);
  if (!key) return null;
  const modifiers = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Command");
  // Bare keys would swallow normal typing system-wide; only F-keys may stand alone.
  if (!modifiers.length && !/^F\d+$/u.test(key)) return null;
  return [...modifiers, key].join("+");
}

let capturingShortcut = false;

function stopCapturing(labelText) {
  capturingShortcut = false;
  shortcutButton.classList.remove("capturing");
  if (labelText) shortcutButton.textContent = labelText;
}

shortcutButton.addEventListener("click", () => {
  if (capturingShortcut) return;
  capturingShortcut = true;
  shortcutButton.dataset.previous = shortcutButton.textContent;
  shortcutButton.textContent = "Press keys…";
  shortcutButton.classList.add("capturing");
  setStatus("Recording shortcut — press Esc to cancel.");
});

window.addEventListener(
  "keydown",
  async (event) => {
    if (!capturingShortcut) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      stopCapturing(shortcutButton.dataset.previous);
      setStatus("");
      return;
    }
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;

    const accelerator = acceleratorFromEvent(event);
    if (!accelerator) {
      setStatus("Use a function key alone, or add ⌘, ⌥, ⌃, or ⇧ to that key.");
      return;
    }
    try {
      const settings = await window.verse.saveShortcut(accelerator);
      stopCapturing();
      applySettings(settings);
      setStatus(`Shortcut set to ${shortcutLabel(settings.shortcut)}.`);
    } catch (error) {
      stopCapturing(shortcutButton.dataset.previous);
      setStatus(cleanErrorMessage(error));
    }
  },
  true
);

// --- Toggles ---

micKeyToggle.addEventListener("change", async () => {
  micKeyToggle.disabled = true;
  try {
    const settings = await window.verse.setMicKey(micKeyToggle.checked);
    applySettings(settings);
    setStatus(
      settings.micKeyEnabled
        ? "The dictation key now starts recording, alongside the shortcut."
        : "The dictation key is back to Apple Dictation."
    );
  } catch (error) {
    micKeyToggle.checked = !micKeyToggle.checked;
    setStatus(cleanErrorMessage(error));
  } finally {
    micKeyToggle.disabled = false;
  }
});

autoPasteToggle.addEventListener("change", async () => {
  try {
    const settings = await window.verse.saveAutoPaste(autoPasteToggle.checked);
    applySettings(settings);
    setStatus(settings.autoPaste ? "Auto-paste on." : "Auto-paste off — clipboard only.");
  } catch (error) {
    setStatus(cleanErrorMessage(error));
  }
});

livePreviewToggle.addEventListener("change", async () => {
  try {
    const settings = await window.verse.saveLivePreview(livePreviewToggle.checked);
    applySettings(settings);
    setStatus(settings.livePreview ? "Live preview on." : "Live preview off.");
  } catch (error) {
    setStatus(cleanErrorMessage(error));
  }
});

notifyToggle.addEventListener("change", async () => {
  try {
    const settings = await window.verse.saveNotifications(notifyToggle.checked);
    applySettings(settings);
    setStatus(settings.notifications ? "Notifications on." : "Notifications off.");
  } catch (error) {
    setStatus(cleanErrorMessage(error));
  }
});

// --- Transcription ---

engineSelect.addEventListener("change", async () => {
  setBusy(true);
  try {
    const settings = await window.verse.saveTranscriptionSettings({
      engine: engineSelect.value,
      mlxModel: mlxModelInput.value,
    });
    applySettings(settings);
    setStatus(
      settings.engine === "mlx"
        ? "Local MLX enabled."
        : settings.engine === "apple"
          ? "Apple Speech enabled."
          : "OpenAI API enabled."
    );
  } catch (error) {
    setStatus(cleanErrorMessage(error));
  } finally {
    setBusy(false);
  }
});

saveEngineButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    const settings = await window.verse.saveTranscriptionSettings({
      engine: engineSelect.value,
      mlxModel: mlxModelInput.value,
    });
    applySettings(settings);
    setStatus("Model saved.");
  } catch (error) {
    setStatus(cleanErrorMessage(error));
  } finally {
    setBusy(false);
  }
});

saveApiKeyButton.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus("Enter an API key first.");
    return;
  }
  setBusy(true);
  try {
    const settings = await window.verse.saveApiKey(apiKey);
    apiKeyInput.value = "";
    applySettings(settings);
    setStatus("API key saved.");
  } catch (error) {
    setStatus(cleanErrorMessage(error));
  } finally {
    setBusy(false);
  }
});

installLocalEngineButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Installing Local MLX… this can take a few minutes.");
  try {
    renderLocalEngineStatus(await window.verse.installLocalEngine());
    setStatus("Local MLX installed.");
  } catch (error) {
    setStatus(cleanErrorMessage(error));
  } finally {
    setBusy(false);
  }
});

removeLocalEngineButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    renderLocalEngineStatus(await window.verse.removeLocalEngine());
    setStatus("Local MLX removed.");
  } catch (error) {
    setStatus(cleanErrorMessage(error));
  } finally {
    setBusy(false);
  }
});

openLocalEngineButton.addEventListener("click", async () => {
  try {
    await window.verse.openLocalEngineFolder();
  } catch (error) {
    setStatus(cleanErrorMessage(error));
  }
});

load();
