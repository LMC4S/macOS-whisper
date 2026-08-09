const searchInput = document.querySelector("#searchInput");
const clearButton = document.querySelector("#clearButton");
const countText = document.querySelector("#countText");
const list = document.querySelector("#list");
const emptyText = document.querySelector("#emptyText");

let entries = [];
let stats = null;

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const diffMs = now - date;
  if (diffMs < 60_000) return "Just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} min ago`;
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function formatTotalDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

const API_COST_PER_MINUTE = 0.006; // OpenAI whisper-1 pricing, USD

// Lifetime totals from the main process, not sums over the visible list —
// history keeps only the latest 200 entries, but these never shrink.
function statsLine() {
  if (!stats) return `${entries.length} transcript${entries.length === 1 ? "" : "s"}`;
  const parts = [`${stats.transcripts} transcript${stats.transcripts === 1 ? "" : "s"}`];
  parts.push(`${stats.words.toLocaleString()} word${stats.words === 1 ? "" : "s"}`);
  if (stats.audioMs > 0) parts.push(`${formatTotalDuration(stats.audioMs)} of audio`);
  const cost = (stats.openaiMs / 60_000) * API_COST_PER_MINUTE;
  if (cost > 0) {
    parts.push(cost < 0.01 ? "< $0.01 API cost" : `≈ $${cost.toFixed(2)} API cost`);
  }
  return parts.join(" · ");
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const visible = query
    ? entries.filter((entry) => entry.text.toLowerCase().includes(query))
    : entries;

  list.textContent = "";
  emptyText.hidden = visible.length > 0;
  emptyText.textContent = query ? "No matches." : "No transcripts yet.";
  countText.textContent = query
    ? `${visible.length} of ${entries.length} transcripts`
    : statsLine();

  for (const entry of visible) {
    const item = document.createElement("li");
    item.className = "entry";

    const meta = document.createElement("div");
    meta.className = "meta";
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatTime(entry.createdAt);
    const engine = document.createElement("span");
    engine.className = "engine";
    engine.textContent =
      entry.engine === "mlx" ? "MLX" : entry.engine === "apple" ? "APPLE" : "API";
    const copiedTag = document.createElement("span");
    copiedTag.className = "copied-tag";
    copiedTag.textContent = "Copied ✓";
    meta.append(time, engine, copiedTag);

    const text = document.createElement("p");
    text.className = "text";
    text.textContent = entry.text;

    const del = document.createElement("button");
    del.className = "delete";
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", async (event) => {
      event.stopPropagation();
      entries = await window.verse.deleteHistoryEntry(entry.id);
      render();
    });

    item.addEventListener("click", async (event) => {
      // A drag to select text shouldn't trigger a copy of the whole entry.
      if (window.getSelection()?.toString()) return;
      if (event.detail === 2) {
        item.classList.toggle("expanded");
        return;
      }
      await window.verse.copyText(entry.text);
      item.classList.add("copied");
      setTimeout(() => item.classList.remove("copied"), 1200);
    });

    item.append(meta, text, del);
    list.append(item);
  }
}

async function load() {
  [entries, stats] = await Promise.all([window.verse.getHistory(), window.verse.getStats()]);
  render();
}

searchInput.addEventListener("input", render);

clearButton.addEventListener("click", async () => {
  if (!entries.length) return;
  entries = await window.verse.clearHistory();
  render();
});

window.verse.onHistoryChanged(load);

load();
