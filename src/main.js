const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  shell,
} = require("electron");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-1";
const DEFAULT_ENGINE = "openai";
const DEFAULT_MLX_MODEL = "mlx-community/whisper-large-v3-turbo";

const DEFAULT_SHORTCUT = "Alt+Space";
const FALLBACK_SHORTCUT = "Control+Alt+Space";

// 🎤 key option: remap the dictation key (consumer usage 0xCF) to F13 with
// hidutil, so it becomes a bindable plain key. A LaunchAgent reapplies the
// mapping at login; disabling removes both. The F13 binding lives alongside
// the regular shortcut rather than replacing it — usage 0xCF only exists on
// the built-in keyboard, so an external keyboard's shortcut never collides
// with it and both can stay registered at once.
const MIC_KEY_SHORTCUT = "F13";
const MIC_KEY_AGENT_LABEL = "app.verse.mic-key";
const MIC_KEY_MAPPING = JSON.stringify({
  UserKeyMapping: [
    {
      HIDKeyboardModifierMappingSrc: 0xc000000cf,
      HIDKeyboardModifierMappingDst: 0x700000068,
    },
  ],
});
const MIC_KEY_MAPPING_OFF = JSON.stringify({ UserKeyMapping: [] });

const HISTORY_LIMIT = 200;

const PANEL_WIDTH = 300;
const PANEL_HEIGHT = 148;
const PANEL_HEIGHT_PREVIEW = 196;

// The app was renamed from "whisper-electron" to "Verse"; adopt the old
// data directory (settings, history, local MLX engine) on first launch.
function migrateLegacyUserData() {
  const appData = app.getPath("appData");
  const oldRoot = path.join(appData, "whisper-electron");
  const newRoot = path.join(appData, "Verse");
  if (!fsSync.existsSync(oldRoot) || fsSync.existsSync(path.join(newRoot, "settings.json"))) {
    return;
  }
  try {
    if (!fsSync.existsSync(newRoot)) {
      fsSync.renameSync(oldRoot, newRoot);
      return;
    }
    for (const item of ["settings.json", "history.json", "local-mlx"]) {
      const source = path.join(oldRoot, item);
      const target = path.join(newRoot, item);
      if (fsSync.existsSync(source) && !fsSync.existsSync(target)) {
        fsSync.renameSync(source, target);
      }
    }
  } catch {
    // If migration fails the app still works, just with fresh settings.
  }
}

migrateLegacyUserData();

let tray = null;
let panelWindow = null;
let settingsWindow = null;
let historyWindow = null;
let recorderState = "idle"; // idle | recording | transcribing
let activeShortcut = null;
let escapeRegistered = false;
let micKeyRegistered = false;

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function historyPath() {
  return path.join(app.getPath("userData"), "history.json");
}

function statsPath() {
  return path.join(app.getPath("userData"), "stats.json");
}

const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힯]/gu;

function wordCount(text) {
  const cjkCharacters = (text.match(CJK_PATTERN) || []).length;
  const spacedWords = (text.replace(CJK_PATTERN, " ").match(/\S+/gu) || []).length;
  return cjkCharacters + spacedWords;
}

function entryAudioMs(entry) {
  if (entry.durationMs) return entry.durationMs;
  // Entries older than duration tracking: assume a 150 words-per-minute pace.
  return (wordCount(entry.text) / 150) * 60_000;
}

// Transcribe-time estimate for the panel's ETA. Learned per engine as a
// two-parameter fit — elapsed ≈ overhead + rate × audio length — over the
// most recent samples. A single elapsed/duration ratio would oscillate
// forever when short and long recordings alternate (overhead dominates the
// short ones); the intercept absorbs it instead.
const DEFAULT_ETA_RATES = { openai: 0.35, mlx: 0.5, apple: 0.25 };
const ETA_SAMPLE_LIMIT = 16;
const ETA_MIN_SPREAD_MS = 2000; // std-dev of durations needed to trust a slope

function normalizeEtaRates(raw) {
  const rates = {};
  for (const [engine, value] of Object.entries(raw || {})) {
    const rate = Number(value);
    if (Number.isFinite(rate) && rate > 0) rates[engine] = Math.min(rate, 5);
  }
  return rates;
}

function normalizeEtaSamples(raw) {
  const samples = {};
  for (const [engine, list] of Object.entries(raw || {})) {
    if (!Array.isArray(list)) continue;
    const valid = list
      .filter(
        (pair) =>
          Array.isArray(pair) &&
          Number.isFinite(pair[0]) &&
          Number.isFinite(pair[1]) &&
          pair[0] > 0 &&
          pair[1] > 0
      )
      .slice(-ETA_SAMPLE_LIMIT);
    if (valid.length) samples[engine] = valid;
  }
  return samples;
}

function transcribeEtaMs(stats, engine, durationMs) {
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration <= 0) return 2000;

  const samples = stats.etaSamples[engine] || [];
  if (samples.length >= 4) {
    const n = samples.length;
    const meanD = samples.reduce((sum, [d]) => sum + d, 0) / n;
    const meanE = samples.reduce((sum, [, e]) => sum + e, 0) / n;
    const varD = samples.reduce((sum, [d]) => sum + (d - meanD) ** 2, 0) / n;
    // Only fit a slope when durations actually vary; a cluster of same-length
    // recordings can't distinguish overhead from rate.
    if (Math.sqrt(varD) >= ETA_MIN_SPREAD_MS) {
      const cov = samples.reduce((sum, [d, e]) => sum + (d - meanD) * (e - meanE), 0) / n;
      const rate = Math.max(0.02, Math.min(3, cov / varD));
      const overhead = Math.max(0, Math.min(5000, meanE - rate * meanD));
      return Math.max(1000, Math.min(30000, Math.round(overhead + rate * duration)));
    }
  }

  // Fallback: single-ratio estimate (EMA-learned, else engine default).
  const rate = stats.etaRates[engine] || DEFAULT_ETA_RATES[engine] || 0.4;
  return Math.max(1000, Math.min(30000, Math.round(rate * duration + 400)));
}

async function recordTranscribeSample(engine, durationMs, elapsedMs) {
  if (!Number.isFinite(durationMs) || durationMs < 1000 || elapsedMs <= 0) return;
  const stats = await loadStats();
  const samples = stats.etaSamples[engine] || [];
  samples.push([Math.round(durationMs), Math.round(elapsedMs)]);
  stats.etaSamples[engine] = samples.slice(-ETA_SAMPLE_LIMIT);
  // Keep the ratio fallback fresh for the days before the fit has spread.
  const sample = Math.max(0.05, Math.min(5, elapsedMs / durationMs));
  const previous = stats.etaRates[engine] || DEFAULT_ETA_RATES[engine] || sample;
  stats.etaRates[engine] = previous * 0.7 + sample * 0.3;
  await saveStats(stats);
}

// Lifetime totals across every engine. History is capped at HISTORY_LIMIT
// entries, so these counters are kept separately and only ever grow.
function statsFromEntries(entries) {
  const stats = { transcripts: 0, words: 0, audioMs: 0, openaiMs: 0, etaRates: {}, etaSamples: {} };
  for (const entry of entries) {
    stats.transcripts += 1;
    stats.words += wordCount(entry.text);
    stats.audioMs += entry.durationMs || 0;
    if (entry.engine === "openai") stats.openaiMs += entryAudioMs(entry);
  }
  return stats;
}

async function saveStats(stats) {
  await fs.mkdir(path.dirname(statsPath()), { recursive: true });
  await fs.writeFile(statsPath(), JSON.stringify(stats, null, 2) + "\n", "utf8");
}

async function loadStats() {
  try {
    const raw = await fs.readFile(statsPath(), "utf8");
    const stats = JSON.parse(raw);
    return {
      transcripts: Number(stats.transcripts) || 0,
      words: Number(stats.words) || 0,
      audioMs: Number(stats.audioMs) || 0,
      openaiMs: Number(stats.openaiMs) || 0,
      etaRates: normalizeEtaRates(stats.etaRates),
      etaSamples: normalizeEtaSamples(stats.etaSamples),
    };
  } catch {
    // First run: seed from whatever history survives the cap. Anything
    // already pruned is gone, so the lifetime clock starts from here.
    const stats = statsFromEntries(await loadHistory());
    await saveStats(stats);
    return stats;
  }
}

async function loadHistory() {
  try {
    const raw = await fs.readFile(historyPath(), "utf8");
    const entries = JSON.parse(raw);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

async function saveHistory(entries) {
  await fs.mkdir(path.dirname(historyPath()), { recursive: true });
  await fs.writeFile(historyPath(), JSON.stringify(entries, null, 2) + "\n", "utf8");
}

async function addHistoryEntry({ text, source, engine, durationMs }) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const duration = Number(durationMs);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    text: trimmed,
    source: String(source || ""),
    engine: String(engine || ""),
    createdAt: new Date().toISOString(),
    ...(Number.isFinite(duration) && duration > 0 ? { durationMs: Math.round(duration) } : {}),
  };
  // Load (and, on first run, seed) stats before the new entry lands in
  // history, so seeding never counts it twice.
  const stats = await loadStats();
  const entries = await loadHistory();
  entries.unshift(entry);
  await saveHistory(entries.slice(0, HISTORY_LIMIT));
  stats.transcripts += 1;
  stats.words += wordCount(entry.text);
  stats.audioMs += entry.durationMs || 0;
  if (entry.engine === "openai") stats.openaiMs += entryAudioMs(entry);
  await saveStats(stats);
  return entry;
}

function defaultSaveRoot() {
  return path.join(os.homedir(), "Documents", "Whisper");
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    const settings = JSON.parse(raw);
    return {
      apiKey: settings.apiKey || "",
      saveRoot: settings.saveRoot || defaultSaveRoot(),
      engine: settings.engine || DEFAULT_ENGINE,
      mlxModel: settings.mlxModel || DEFAULT_MLX_MODEL,
      shortcut: settings.shortcut || DEFAULT_SHORTCUT,
      autoPaste: settings.autoPaste !== false,
      notifications: settings.notifications !== false,
      livePreview: settings.livePreview === true,
    };
  } catch {
    return {
      apiKey: "",
      saveRoot: defaultSaveRoot(),
      engine: DEFAULT_ENGINE,
      mlxModel: DEFAULT_MLX_MODEL,
      shortcut: DEFAULT_SHORTCUT,
      autoPaste: true,
      notifications: true,
      livePreview: false,
    };
  }
}

async function saveSettings(nextSettings) {
  const current = await loadSettings();
  const settings = { ...current, ...nextSettings };
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settings;
}

function extensionForAudio(fileName, mimeType) {
  const ext = path.extname(fileName || "").toLowerCase();
  if (ext) return ext;
  if ((mimeType || "").includes("mp4")) return ".mp4";
  if ((mimeType || "").includes("mpeg")) return ".mp3";
  if ((mimeType || "").includes("wav")) return ".wav";
  if ((mimeType || "").includes("ogg")) return ".ogg";
  return ".webm";
}

function audioBufferFromPayload(audio) {
  if (!audio || !audio.bytes) {
    throw new Error("No audio is ready.");
  }
  return Buffer.from(audio.bytes);
}

function tempAudioPath(fileName) {
  const extension = extensionForAudio(fileName, "");
  return path.join(
    app.getPath("temp"),
    `verse-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`
  );
}

function appResourcePath(...parts) {
  return path.join(app.getAppPath(), ...parts);
}

function unpackedResourcePath(...parts) {
  if (!app.isPackaged) return appResourcePath(...parts);
  return path.join(process.resourcesPath, "app.asar.unpacked", ...parts);
}

function localMlxScriptPath() {
  return unpackedResourcePath("src", "local_mlx_transcribe.py");
}

function appleHelperPath() {
  return unpackedResourcePath("src", "bin", "verse-apple-transcribe");
}

function appleStreamPath() {
  return unpackedResourcePath("src", "bin", "verse-apple-stream");
}

function localEngineRoot() {
  return path.join(app.getPath("userData"), "local-mlx");
}

function localEngineVenvPath() {
  return path.join(localEngineRoot(), "venv");
}

function localEnginePythonPath() {
  return path.join(localEngineVenvPath(), "bin", "python3");
}

function localEngineEnv() {
  const root = localEngineRoot();
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
    HF_HOME: path.join(root, "huggingface"),
    HF_HUB_CACHE: path.join(root, "huggingface", "hub"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  };
}

function pythonCandidates() {
  return [
    "/opt/homebrew/bin/python3",
    "/Library/Developer/CommandLineTools/usr/bin/python3",
    "/usr/bin/python3",
    "python3",
  ];
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: options.env || localEngineEnv(),
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `Command exited with ${code}.`));
    });
  });
}

async function findSystemPython() {
  let lastError = null;
  for (const candidate of pythonCandidates()) {
    try {
      await runProcess(candidate, ["--version"], { env: localEngineEnv() });
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Could not find python3.");
}

function runPython(script, args) {
  return new Promise((resolve, reject) => {
    const pythonPath = localEnginePythonPath();
    if (!fsSync.existsSync(pythonPath)) {
      reject(new Error("Install Local MLX in Settings before using the local engine."));
      return;
    }

    const child = spawn(pythonPath, [script, ...args], {
      env: localEngineEnv(),
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `Python exited with ${code}.`));
    });
  });
}

async function localEngineStatus() {
  const pythonPath = localEnginePythonPath();
  const root = localEngineRoot();
  if (!fsSync.existsSync(pythonPath)) {
    return {
      installed: false,
      path: root,
      message: "Not installed",
    };
  }

  try {
    await runProcess(pythonPath, ["-c", "import mlx_whisper"], { env: localEngineEnv() });
    return {
      installed: true,
      path: root,
      message: "Installed",
    };
  } catch (error) {
    return {
      installed: false,
      path: root,
      message: error.message || "Install is incomplete",
    };
  }
}

async function installLocalEngine() {
  const root = localEngineRoot();
  const pythonPath = localEnginePythonPath();
  await fs.mkdir(root, { recursive: true });

  if (!fsSync.existsSync(pythonPath)) {
    const systemPython = await findSystemPython();
    await runProcess(systemPython, ["-m", "venv", localEngineVenvPath()], { env: localEngineEnv() });
  }

  await runProcess(pythonPath, ["-m", "pip", "install", "--upgrade", "pip"], { env: localEngineEnv() });
  await runProcess(pythonPath, ["-m", "pip", "install", "--upgrade", "mlx-whisper"], {
    env: localEngineEnv(),
  });
  return localEngineStatus();
}

async function removeLocalEngine() {
  const root = localEngineRoot();
  await fs.rm(root, { recursive: true, force: true });
  return localEngineStatus();
}

async function openLocalEngineFolder() {
  const root = localEngineRoot();
  await fs.mkdir(root, { recursive: true });
  await shell.openPath(root);
}

async function ensureLocalEngineReady() {
  const status = await localEngineStatus();
  if (!status.installed) {
    throw new Error("Install Local MLX in Settings before using the local engine.");
  }
  if (!fsSync.existsSync(localMlxScriptPath())) {
    throw new Error(`Local MLX helper is missing: ${localMlxScriptPath()}`);
  }
  return status;
}

function micKeyAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${MIC_KEY_AGENT_LABEL}.plist`);
}

function micKeyEnabled() {
  return fsSync.existsSync(micKeyAgentPath());
}

function micKeyAgentPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MIC_KEY_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/hidutil</string>
    <string>property</string>
    <string>--set</string>
    <string>${MIC_KEY_MAPPING.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

async function setMicKey(enabled) {
  if (enabled) {
    await runProcess("/usr/bin/hidutil", ["property", "--set", MIC_KEY_MAPPING], {
      env: process.env,
    });
    await fs.mkdir(path.dirname(micKeyAgentPath()), { recursive: true });
    await fs.writeFile(micKeyAgentPath(), micKeyAgentPlist(), "utf8");
  } else {
    await runProcess("/usr/bin/hidutil", ["property", "--set", MIC_KEY_MAPPING_OFF], {
      env: process.env,
    });
    await fs.rm(micKeyAgentPath(), { force: true });
  }
}

function publicSettings(settings) {
  return {
    hasApiKey: Boolean(settings.apiKey),
    engine: settings.engine,
    mlxModel: settings.mlxModel,
    shortcut: activeShortcut || settings.shortcut,
    autoPaste: settings.autoPaste,
    notifications: settings.notifications,
    livePreview: settings.livePreview,
    micKeyEnabled: micKeyEnabled(),
    version: app.getVersion(),
  };
}

async function transcribeWithMlx(audio, settings) {
  await ensureLocalEngineReady();
  const buffer = audioBufferFromPayload(audio);
  const audioPath = tempAudioPath(audio.fileName || "recording.webm");
  await fs.writeFile(audioPath, buffer);
  try {
    const output = await runPython(localMlxScriptPath(), [
      audioPath,
      "--model",
      settings.mlxModel || DEFAULT_MLX_MODEL,
    ]);
    const result = JSON.parse(output);
    if (result.error) throw new Error(result.error);
    if (typeof result.text !== "string") {
      throw new Error("MLX response did not include transcript text.");
    }
    return { text: result.text, usage: null };
  } finally {
    await fs.unlink(audioPath).catch(() => {});
  }
}

// Runs the helper and reports its JSON error message even on a non-zero
// exit (the helper prints {"error": ...} to stdout and exits 1).
function runAppleHelper(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(appleHelperPath(), args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          reject(new Error(result.error));
          return;
        }
        resolve(result);
      } catch {
        reject(
          new Error(stderr.trim() || stdout.trim() || `Apple Speech helper exited with ${code}.`)
        );
      }
    });
  });
}

async function transcribeWithApple(audio) {
  if (!fsSync.existsSync(appleHelperPath())) {
    throw new Error("Apple Speech helper is missing — run scripts/build_apple_helper.sh.");
  }
  const buffer = audioBufferFromPayload(audio);
  if (!buffer.length) {
    throw new Error("The recording came back empty.");
  }
  const audioPath = tempAudioPath(audio.fileName || "recording.wav");
  await fs.writeFile(audioPath, buffer);
  try {
    const result = await runAppleHelper([audioPath]);
    if (typeof result.text !== "string") {
      throw new Error("Apple Speech did not return transcript text.");
    }
    return { text: result.text, usage: null };
  } finally {
    await fs.unlink(audioPath).catch(() => {});
  }
}

async function transcribeWithOpenAi(audio, settings) {
  if (!settings.apiKey) throw new Error("Save an OpenAI API key first.");

  const buffer = audioBufferFromPayload(audio);
  const blob = new Blob([buffer], {
    type: audio.mimeType || "application/octet-stream",
  });
  const form = new FormData();
  form.append("model", DEFAULT_MODEL);
  form.append("file", blob, audio.fileName || "recording.webm");

  const response = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error?.message || `OpenAI returned HTTP ${response.status}.`);
  }
  if (typeof result.text !== "string") {
    throw new Error("OpenAI response did not include transcript text.");
  }
  return {
    text: result.text,
    usage: result.usage || null,
  };
}

// --- Menu bar UI -----------------------------------------------------------

function trayIcon(name) {
  const image = nativeImage.createFromPath(appResourcePath("src", "assets", `${name}.png`));
  image.setTemplateImage(name.endsWith("Template"));
  return image;
}

const trayIcons = {};

function updateTrayIcon() {
  if (!tray) return;
  const name =
    recorderState === "recording"
      ? "recording"
      : recorderState === "transcribing"
        ? "busyTemplate"
        : "quoteTemplate";
  if (!trayIcons[name]) trayIcons[name] = trayIcon(name);
  tray.setImage(trayIcons[name]);
  tray.setToolTip(
    recorderState === "recording"
      ? "Verse — recording"
      : recorderState === "transcribing"
        ? "Verse — transcribing"
        : "Verse"
  );
}

function shortcutLabel(accelerator) {
  return String(accelerator || "")
    .replace("Control", "⌃")
    .replace("Alt", "⌥")
    .replace("Shift", "⇧")
    .replace("Command", "⌘")
    .replaceAll("+", "");
}

function menuPreview(text) {
  const compact = String(text || "").replace(/\s+/gu, " ").trim();
  return compact.length > 52 ? `${compact.slice(0, 52)}…` : compact;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label:
        recorderState === "recording"
          ? "Stop Recording"
          : recorderState === "transcribing"
            ? "Transcribing…"
            : "Start Recording",
      enabled: recorderState !== "transcribing",
      accelerator: activeShortcut || undefined,
      registerAccelerator: false,
      click: () => toggleRecording(),
    },
    { type: "separator" },
    { label: "History…", click: () => openHistoryWindow() },
    { type: "separator" },
    {
      label: "Settings…",
      accelerator: "Command+,",
      registerAccelerator: false,
      click: () => openSettingsWindow(),
    },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: "Quit Verse", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  trayIcons.quoteTemplate = trayIcon("quoteTemplate");
  tray = new Tray(trayIcons.quoteTemplate);
  updateTrayIcon();
}

function positionPanel() {
  if (!tray || !panelWindow) return;
  const bounds = tray.getBounds();
  const x = Math.round(bounds.x + bounds.width / 2 - PANEL_WIDTH / 2);
  const y = Math.round(bounds.y + bounds.height + 8);
  panelWindow.setPosition(x, y, false);
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    vibrancy: "hud",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    hiddenInMissionControl: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  panelWindow.setAlwaysOnTop(true, "status");
  panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWindow.loadFile(path.join(__dirname, "panel", "index.html"));
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 700,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Verse Settings",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "settings", "index.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function openHistoryWindow() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.show();
    historyWindow.focus();
    return;
  }
  historyWindow = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 380,
    minHeight: 400,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Verse History",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  historyWindow.loadFile(path.join(__dirname, "history", "index.html"));
  historyWindow.on("closed", () => {
    historyWindow = null;
  });
}

function notifyHistoryChanged() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.webContents.send("history:changed");
  }
}

function sendPanel(channel, payload) {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send(channel, payload);
  }
}

async function notify(title, body) {
  if (!Notification.isSupported()) return;
  const settings = await loadSettings();
  if (settings.notifications === false) return;
  new Notification({ title, body: String(body || ""), silent: false }).show();
}

// --- Recording state machine ------------------------------------------------

// --- Live transcript preview (Apple SpeechAnalyzer, best effort) ----------

let previewProcess = null;

function startPreview() {
  if (previewProcess || !fsSync.existsSync(appleStreamPath())) return false;
  try {
    previewProcess = spawn(appleStreamPath(), [], { env: process.env });
  } catch {
    previewProcess = null;
    return false;
  }
  const child = previewProcess;
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "volatile" || event.type === "final") {
          sendPanel("preview:text", { kind: event.type, text: event.text });
        }
      } catch {
        // Not JSON — ignore.
      }
    }
  });
  child.on("error", () => {
    if (previewProcess === child) previewProcess = null;
  });
  child.on("close", () => {
    if (previewProcess === child) previewProcess = null;
  });
  return true;
}

function stopPreview() {
  if (!previewProcess) return;
  const child = previewProcess;
  previewProcess = null;
  try {
    child.stdin.end();
  } catch {}
  setTimeout(() => child.kill(), 400);
}

ipcMain.on("preview:audio", (_event, chunk) => {
  if (!previewProcess) return;
  try {
    previewProcess.stdin.write(Buffer.from(chunk));
  } catch {}
});

async function startRecording() {
  if (recorderState !== "idle" || !panelWindow) return;
  const settings = await loadSettings();
  if (recorderState !== "idle") return;
  const preview = settings.livePreview !== false && startPreview();
  panelWindow.setContentSize(PANEL_WIDTH, preview ? PANEL_HEIGHT_PREVIEW : PANEL_HEIGHT);
  positionPanel();
  panelWindow.showInactive();
  sendPanel("recorder:command", {
    action: "start",
    shortcut: activeShortcut,
    wav: settings.engine === "apple",
    preview,
  });
}

function stopRecording() {
  if (recorderState !== "recording") return;
  sendPanel("recorder:command", { action: "stop" });
}

function cancelRecording() {
  if (recorderState !== "recording") return;
  sendPanel("recorder:command", { action: "cancel" });
}

function toggleRecording() {
  if (recorderState === "recording") {
    stopRecording();
  } else if (recorderState === "idle") {
    startRecording();
  }
}

function updateEscapeShortcut() {
  const wanted = recorderState === "recording";
  if (wanted && !escapeRegistered) {
    escapeRegistered = globalShortcut.register("Escape", () => cancelRecording());
  } else if (!wanted && escapeRegistered) {
    globalShortcut.unregister("Escape");
    escapeRegistered = false;
  }
}

function setRecorderState(state) {
  const next = state === "recording" || state === "transcribing" ? state : "idle";
  if (next === recorderState) return;
  recorderState = next;
  if (next !== "recording") stopPreview();
  updateTrayIcon();
  updateEscapeShortcut();
  rebuildTrayMenu();
}

function registerToggleShortcut(preferred) {
  const tryRegister = (accelerator) => {
    try {
      return globalShortcut.register(accelerator, () => toggleRecording());
    } catch {
      return false;
    }
  };

  if (tryRegister(preferred)) return preferred;
  if (preferred !== FALLBACK_SHORTCUT && tryRegister(FALLBACK_SHORTCUT)) {
    notify(
      "Shortcut unavailable",
      `${shortcutLabel(preferred)} is taken by another app. Using ${shortcutLabel(FALLBACK_SHORTCUT)} instead.`
    );
    return FALLBACK_SHORTCUT;
  }
  notify("Shortcut unavailable", "Could not register a global shortcut. Use the menu bar icon.");
  return null;
}

function syncMicKeyShortcut() {
  const wanted = micKeyEnabled() && activeShortcut !== MIC_KEY_SHORTCUT;
  if (wanted && !micKeyRegistered) {
    try {
      micKeyRegistered = globalShortcut.register(MIC_KEY_SHORTCUT, () => toggleRecording());
    } catch {
      micKeyRegistered = false;
    }
  } else if (!wanted && micKeyRegistered) {
    globalShortcut.unregister(MIC_KEY_SHORTCUT);
    micKeyRegistered = false;
  }
}

function pasteIntoFrontApp() {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ]);
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- IPC ---------------------------------------------------------------------

ipcMain.handle("settings:get", async () => {
  const settings = await loadSettings();
  return publicSettings(settings);
});

ipcMain.handle("settings:saveApiKey", async (_event, apiKey) => {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Enter an API key first.");
  const settings = await saveSettings({ apiKey: key });
  return publicSettings(settings);
});

ipcMain.handle("settings:saveTranscription", async (_event, payload) => {
  const engine = ["mlx", "apple"].includes(payload?.engine) ? payload.engine : "openai";
  const mlxModel = String(payload?.mlxModel || DEFAULT_MLX_MODEL).trim() || DEFAULT_MLX_MODEL;
  const settings = await saveSettings({ engine, mlxModel });
  return publicSettings(settings);
});

async function rebindShortcut(accelerator) {
  // The mic-key binding may hold the accelerator we are about to claim;
  // release it first and re-sync afterwards.
  if (micKeyRegistered) {
    globalShortcut.unregister(MIC_KEY_SHORTCUT);
    micKeyRegistered = false;
  }
  if (activeShortcut) globalShortcut.unregister(activeShortcut);
  let registered = false;
  try {
    registered = globalShortcut.register(accelerator, () => toggleRecording());
  } catch {
    registered = false;
  }
  if (!registered) {
    if (activeShortcut) globalShortcut.register(activeShortcut, () => toggleRecording());
    syncMicKeyShortcut();
    throw new Error(`Could not register ${shortcutLabel(accelerator)} — it may be taken by another app.`);
  }
  activeShortcut = accelerator;
  const settings = await saveSettings({ shortcut: accelerator });
  syncMicKeyShortcut();
  rebuildTrayMenu();
  return settings;
}

ipcMain.handle("settings:saveShortcut", async (_event, accelerator) => {
  const next = String(accelerator || "").trim();
  if (!next) throw new Error("Press a key combination first.");
  const settings = await rebindShortcut(next);
  return publicSettings(settings);
});

ipcMain.handle("micKey:set", async (_event, enabled) => {
  await setMicKey(Boolean(enabled));
  let settings = await loadSettings();
  if (!enabled && settings.shortcut === MIC_KEY_SHORTCUT) {
    // Legacy state from when 🎤 replaced the shortcut: F13 has no physical
    // key once the remap is gone, so fall back to the default.
    settings = await rebindShortcut(DEFAULT_SHORTCUT);
  }
  syncMicKeyShortcut();
  return publicSettings(settings);
});

ipcMain.handle("settings:saveAutoPaste", async (_event, enabled) => {
  const settings = await saveSettings({ autoPaste: Boolean(enabled) });
  return publicSettings(settings);
});

ipcMain.handle("settings:saveNotifications", async (_event, enabled) => {
  const settings = await saveSettings({ notifications: Boolean(enabled) });
  return publicSettings(settings);
});

ipcMain.handle("settings:saveLivePreview", async (_event, enabled) => {
  const settings = await saveSettings({ livePreview: Boolean(enabled) });
  return publicSettings(settings);
});

ipcMain.handle("localEngine:status", async () => {
  return localEngineStatus();
});

ipcMain.handle("localEngine:install", async () => {
  return installLocalEngine();
});

ipcMain.handle("localEngine:remove", async () => {
  return removeLocalEngine();
});

ipcMain.handle("localEngine:open", async () => {
  await openLocalEngineFolder();
  return { ok: true };
});

ipcMain.handle("history:list", async () => {
  return loadHistory();
});

ipcMain.handle("history:stats", async () => {
  return loadStats();
});

// ETA for the panel's transcribing view.
ipcMain.handle("transcribe:plan", async (_event, durationMs) => {
  const settings = await loadSettings();
  const stats = await loadStats();
  return { etaMs: transcribeEtaMs(stats, settings.engine, durationMs) };
});

ipcMain.handle("history:delete", async (_event, id) => {
  const entries = await loadHistory();
  const next = entries.filter((entry) => entry.id !== id);
  await saveHistory(next);
  return next;
});

ipcMain.handle("history:clear", async () => {
  const entries = await loadHistory();
  if (!entries.length) return entries;

  const options = {
    type: "warning",
    buttons: ["Clear All", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Clear all transcripts?",
    detail: `This permanently deletes all ${entries.length} entries from history.`,
  };
  const parent = historyWindow && !historyWindow.isDestroyed() ? historyWindow : null;
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (response !== 0) return entries;

  await saveHistory([]);
  return [];
});

ipcMain.handle("clipboard:writeText", async (_event, text) => {
  clipboard.writeText(String(text || ""));
  return { ok: true };
});

ipcMain.on("recorder:state", (_event, state) => {
  setRecorderState(state);
});

ipcMain.on("panel:hide", () => {
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide();
});

ipcMain.handle("recorder:complete", async (_event, audio) => {
  const settings = await loadSettings();
  try {
    const startedAt = Date.now();
    const result =
      settings.engine === "mlx"
        ? await transcribeWithMlx(audio, settings)
        : settings.engine === "apple"
          ? await transcribeWithApple(audio)
          : await transcribeWithOpenAi(audio, settings);
    await recordTranscribeSample(settings.engine, Number(audio?.durationMs), Date.now() - startedAt).catch(
      () => {}
    );
    const text = String(result.text || "").trim();
    if (!text) throw new Error("The transcript came back empty.");
    clipboard.writeText(text);
    await addHistoryEntry({
      text,
      source: audio?.fileName || "recording",
      engine: settings.engine,
      durationMs: audio?.durationMs,
    }).catch(() => {});

    let pasted = false;
    if (settings.autoPaste) {
      if (panelWindow && panelWindow.isFocused()) {
        // A click on the panel focused us; give focus back before pasting.
        panelWindow.hide();
        await delay(250);
      }
      pasted = await pasteIntoFrontApp();
    }
    if (pasted) {
      notify("Pasted", menuPreview(text));
    } else if (settings.autoPaste) {
      notify(
        "Copied to clipboard",
        "To paste automatically, allow Verse under System Settings → Privacy & Security → Accessibility."
      );
    } else {
      notify("Copied to clipboard", menuPreview(text));
    }
    notifyHistoryChanged();
    return { text };
  } catch (error) {
    notify("Transcription failed", error.message);
    throw error;
  }
});

// --- App lifecycle -----------------------------------------------------------

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  createTray();
  createPanelWindow();
  const settings = await loadSettings();
  activeShortcut = registerToggleShortcut(settings.shortcut || DEFAULT_SHORTCUT);
  syncMicKeyShortcut();
  rebuildTrayMenu();
});

app.on("window-all-closed", () => {
  // Menu bar app: keep running with no windows.
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
