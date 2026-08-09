const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("verse", {
  // Settings window
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveApiKey: (apiKey) => ipcRenderer.invoke("settings:saveApiKey", apiKey),
  saveTranscriptionSettings: (payload) => ipcRenderer.invoke("settings:saveTranscription", payload),
  saveShortcut: (accelerator) => ipcRenderer.invoke("settings:saveShortcut", accelerator),
  saveAutoPaste: (enabled) => ipcRenderer.invoke("settings:saveAutoPaste", enabled),
  saveNotifications: (enabled) => ipcRenderer.invoke("settings:saveNotifications", enabled),
  saveLivePreview: (enabled) => ipcRenderer.invoke("settings:saveLivePreview", enabled),
  setMicKey: (enabled) => ipcRenderer.invoke("micKey:set", enabled),
  getLocalEngineStatus: () => ipcRenderer.invoke("localEngine:status"),
  installLocalEngine: () => ipcRenderer.invoke("localEngine:install"),
  removeLocalEngine: () => ipcRenderer.invoke("localEngine:remove"),
  openLocalEngineFolder: () => ipcRenderer.invoke("localEngine:open"),

  // History window
  getHistory: () => ipcRenderer.invoke("history:list"),
  getStats: () => ipcRenderer.invoke("history:stats"),
  deleteHistoryEntry: (id) => ipcRenderer.invoke("history:delete", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  copyText: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  onHistoryChanged: (callback) => ipcRenderer.on("history:changed", () => callback()),

  // Recording panel
  onRecorderCommand: (callback) =>
    ipcRenderer.on("recorder:command", (_event, payload) => callback(payload)),
  onPreviewText: (callback) =>
    ipcRenderer.on("preview:text", (_event, payload) => callback(payload)),
  sendPreviewAudio: (chunk) => ipcRenderer.send("preview:audio", chunk),
  reportRecorderState: (state) => ipcRenderer.send("recorder:state", state),
  completeRecording: (audio) => ipcRenderer.invoke("recorder:complete", audio),
  hidePanel: () => ipcRenderer.send("panel:hide"),
});
