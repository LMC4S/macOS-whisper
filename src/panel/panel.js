const body = document.body;
const previewText = document.querySelector("#previewText");
const previewFinal = document.querySelector("#previewFinal");
const previewVolatile = document.querySelector("#previewVolatile");
const timerText = document.querySelector("#timer");
const meterCanvas = document.querySelector("#meter");
const meterContext = meterCanvas.getContext("2d");
const transcribeCanvas = document.querySelector("#transcribeMeter");
const transcribeContext = transcribeCanvas.getContext("2d");
const etaTimer = document.querySelector("#etaTimer");
const stopButton = document.querySelector("#stopButton");
const cancelButton = document.querySelector("#cancelButton");
const shortcutHint = document.querySelector("#shortcutHint");
const errorText = document.querySelector("#errorText");

let mediaRecorder = null;
let recordedChunks = [];
let cancelled = false;
let wantsWav = false;
let previewOn = false;
let previewContext = null;
let startedAt = 0;
let timer = null;
let audioContext = null;
let analyser = null;
let meterFrame = null;
let hideTimer = null;
let pendingAction = null; // stop/cancel requested during microphone warm-up
let warmupStart = 0;
let captureLive = false;
let dingContext = null;
let envelope = []; // coarse level history of the recording, for the transcribe view
let envelopeAt = 0;
let transcribeAnim = null;
let transcribeFrame = null;

function setState(state) {
  body.dataset.state = state;
  window.verse.reportRecorderState(
    state === "recording" ? "recording" : state === "transcribing" ? "transcribing" : "idle"
  );
}

function recordingType() {
  // WebM/Opus: Electron's MediaRecorder advertises audio/mp4 but records
  // zero bytes with it. Engines that cannot read WebM get a WAV conversion.
  const candidates = ["audio/webm", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

// Decode the recording with Chromium's decoder and re-encode as 16 kHz mono
// WAV, for engines that cannot read WebM (Apple's Speech framework).
async function blobToWav(blob) {
  const decodeContext = new AudioContext();
  let decoded;
  try {
    decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer());
  } finally {
    decodeContext.close().catch(() => {});
  }
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  const wav = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) wav.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  wav.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, rate, true);
  wav.setUint32(28, rate * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  writeString(36, "data");
  wav.setUint32(40, samples.length * 2, true);
  for (let i = 0, offset = 44; i < samples.length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    wav.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([wav.buffer], { type: "audio/wav" });
}

function extensionForType(type) {
  if (type.includes("mp4")) return "mp4";
  return "webm";
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function startTimer() {
  startedAt = Date.now();
  timerText.textContent = "00:00";
  timer = window.setInterval(() => {
    timerText.textContent = formatTime(Date.now() - startedAt);
  }, 250);
}

function stopTimer() {
  window.clearInterval(timer);
  timer = null;
}

const BAR_COUNT = 28;
const WARMUP_SWEEP_MS = 650; // pace of the power-on sweep ≈ a cold mic's wake time
const CAPTURE_LIVE_TIMEOUT_MS = 1500; // digital silence still counts as live eventually

function renderBars(levelAt, alphaAt) {
  const { width, height } = meterCanvas;
  meterContext.clearRect(0, 0, width, height);
  const gap = 4;
  const barWidth = (width - gap * (BAR_COUNT - 1)) / BAR_COUNT;
  for (let index = 0; index < BAR_COUNT; index += 1) {
    const level = levelAt(index);
    const barHeight = Math.max(4, level * height);
    const x = index * (barWidth + gap);
    const y = (height - barHeight) / 2;
    meterContext.fillStyle = `rgba(255, 255, 255, ${alphaAt(index, level)})`;
    meterContext.beginPath();
    meterContext.roundRect(x, y, barWidth, barHeight, barWidth / 2);
    meterContext.fill();
  }
}

// Power-on sweep drawn while the microphone wakes: bars ignite left to
// right, paced to a typical cold start, and hold lit if the mic is slower.
function renderSweepFrame() {
  const progress = ((performance.now() - warmupStart) / WARMUP_SWEEP_MS) * BAR_COUNT;
  const t = performance.now() / 1000;
  renderBars(
    (i) => (i < progress ? 0.3 + 0.08 * Math.sin(t * 4 + i) : 0.04),
    (i) => (i < progress ? 0.45 + 0.3 * Math.max(0, 1 - (progress - i) / 6) : 0.16)
  );
}

function startSweep() {
  const loop = () => {
    renderSweepFrame();
    meterFrame = window.requestAnimationFrame(loop);
  };
  window.cancelAnimationFrame(meterFrame);
  meterFrame = window.requestAnimationFrame(loop);
}

// The moment real audio flows: ready tone, red dot, timer starts. Recording
// duration is measured from here, so the silent warm-up isn't counted.
function goLive() {
  captureLive = true;
  body.classList.remove("warming");
  playDing();
  startTimer();
}

function startMeter(stream) {
  // A silent sink: the meter only analyses the mic; the default sink would
  // needlessly open the output device (slow to wake on USB speakers).
  audioContext = new AudioContext({ sinkId: { type: "none" } });
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);

  const bins = new Uint8Array(analyser.frequencyBinCount);
  const attachedAt = performance.now();

  const draw = () => {
    analyser.getByteFrequencyData(bins);
    if (
      !captureLive &&
      (bins.some((bin) => bin > 0) || performance.now() - attachedAt > CAPTURE_LIVE_TIMEOUT_MS)
    ) {
      goLive();
    }
    if (captureLive) {
      const now = performance.now();
      if (now - envelopeAt >= 80) {
        // Coarse envelope of the whole take; becomes the transcribe waveform.
        envelopeAt = now;
        let sum = 0;
        for (let i = 0; i < bins.length; i += 1) sum += bins[i];
        envelope.push(sum / bins.length / 255);
      }
      renderBars(
        (i) => bins[Math.floor((i / BAR_COUNT) * bins.length * 0.7)] / 255,
        (_i, level) => 0.35 + level * 0.55
      );
    } else {
      renderSweepFrame();
    }
    meterFrame = window.requestAnimationFrame(draw);
  };
  window.cancelAnimationFrame(meterFrame);
  meterFrame = window.requestAnimationFrame(draw);
}

// --- Ready tone ------------------------------------------------------------

// Created when the warm-up begins so the output device wakes in parallel
// with the microphone; the tone then plays on time instead of waiting for
// USB speakers to spin up.
function warmDing() {
  dropDing();
  try {
    dingContext = new AudioContext();
  } catch {
    dingContext = null;
  }
}

function playDing() {
  const context = dingContext;
  dingContext = null;
  if (!context) return;
  try {
    const t = context.currentTime;
    for (const [frequency, peak] of [
      [1318.5, 0.1],
      [1975.5, 0.045],
    ]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(t);
      oscillator.stop(t + 0.3);
    }
    setTimeout(() => context.close().catch(() => {}), 600);
  } catch {}
}

function dropDing() {
  dingContext?.close().catch(() => {});
  dingContext = null;
}

// --- Transcribing view: a reading head sweeps the recording's waveform ------

// The recording's envelope, resampled to the meter's bar count and
// normalized so the loudest moment reaches full height.
function envelopeToBars() {
  if (!envelope.length) return Array.from({ length: BAR_COUNT }, () => 0.15);
  const levels = [];
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const from = Math.floor((i / BAR_COUNT) * envelope.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / BAR_COUNT) * envelope.length));
    levels.push(Math.max(...envelope.slice(from, to)));
  }
  const peak = Math.max(...levels, 0.001);
  return levels.map((level) => Math.max(0.08, (level / peak) * 0.95));
}

function transcribeProgress(anim, now) {
  const linear = (now - anim.start) / anim.etaMs;
  return linear < 0.9 ? linear : 0.9 + 0.08 * (1 - Math.exp(-(linear - 0.9) * 2.2));
}

function drawTranscribe(levels, progress) {
  const { width, height } = transcribeCanvas;
  transcribeContext.clearRect(0, 0, width, height);
  const gap = 4;
  const barWidth = (width - gap * (BAR_COUNT - 1)) / BAR_COUNT;
  const front = progress * BAR_COUNT;
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const x = i * (barWidth + gap);
    // Ink: ghost bars ahead of the head, solid behind, 1.5-bar blend.
    const t = Math.max(0, Math.min(1, (front - i) / 1.5));
    const alpha = 0.22 + t * 0.63;
    const barHeight = Math.max(4, levels[i] * height);
    const y = (height - barHeight) / 2;
    transcribeContext.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    transcribeContext.beginPath();
    transcribeContext.roundRect(x, y, barWidth, barHeight, barWidth / 2);
    transcribeContext.fill();
  }
  const headX = progress * width;
  transcribeContext.save();
  transcribeContext.shadowColor = "rgba(255, 255, 255, 0.85)";
  transcribeContext.shadowBlur = 9;
  transcribeContext.fillStyle = "rgba(255, 255, 255, 0.95)";
  transcribeContext.fillRect(headX - 0.75, 2, 1.5, height - 4);
  transcribeContext.restore();
}

function startTranscribeAnim(levels, etaMs) {
  stopTranscribeAnim();
  const anim = {
    start: performance.now(),
    etaMs,
    finishing: false,
    finishStart: 0,
    finishFrom: 0,
    resolve: null,
  };
  transcribeAnim = anim;
  const loop = (now) => {
    if (transcribeAnim !== anim) return;
    let progress;
    if (anim.finishing) {
      // The response arrived: race the head to the end in 160ms.
      progress = anim.finishFrom + (1 - anim.finishFrom) * Math.min(1, (now - anim.finishStart) / 160);
    } else {
      // Honest until 90% of the estimate, then hover until the real response.
      progress = transcribeProgress(anim, now);
      const remaining = anim.etaMs - (now - anim.start);
      etaTimer.textContent = remaining > 0 ? `≈${Math.max(1, Math.ceil(remaining / 1000))}s` : "…";
    }
    drawTranscribe(levels, Math.min(progress, 1));
    if (anim.finishing && progress >= 1) {
      transcribeAnim = null;
      anim.resolve?.();
      return;
    }
    transcribeFrame = window.requestAnimationFrame(loop);
  };
  transcribeFrame = window.requestAnimationFrame(loop);
}

function finishTranscribeAnim() {
  const anim = transcribeAnim;
  if (!anim) return Promise.resolve();
  return new Promise((resolve) => {
    anim.resolve = resolve;
    anim.finishing = true;
    anim.finishStart = performance.now();
    anim.finishFrom = Math.min(1, transcribeProgress(anim, anim.finishStart));
  });
}

function stopTranscribeAnim() {
  window.cancelAnimationFrame(transcribeFrame);
  transcribeFrame = null;
  const anim = transcribeAnim;
  transcribeAnim = null;
  anim?.resolve?.();
  transcribeContext.clearRect(0, 0, transcribeCanvas.width, transcribeCanvas.height);
}

// --- Live transcript preview: stream 16 kHz PCM to the main process --------

function startPreviewPump(stream) {
  previewFinal.textContent = "";
  previewVolatile.textContent = "";
  // Silent sink here too: this context only pumps mic samples to the main
  // process, and must not wake the output device (~450ms on USB speakers).
  previewContext = new AudioContext({ sampleRate: 16000, sinkId: { type: "none" } });
  const source = previewContext.createMediaStreamSource(stream);
  const processor = previewContext.createScriptProcessor(4096, 1, 1);
  const mute = previewContext.createGain();
  mute.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    window.verse.sendPreviewAudio(pcm.buffer);
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(previewContext.destination);
}

function stopPreviewPump() {
  if (previewContext) {
    previewContext.close().catch(() => {});
    previewContext = null;
  }
}

function appendPreview(kind, text) {
  if (!previewOn || !text) return;
  if (kind === "final") {
    const joiner = previewFinal.textContent && !/^\s/u.test(text) ? " " : "";
    previewFinal.textContent += joiner + text;
    previewVolatile.textContent = "";
  } else {
    const joiner = previewFinal.textContent && !/^\s/u.test(text) ? " " : "";
    previewVolatile.textContent = joiner + text;
  }
  previewText.scrollTop = previewText.scrollHeight;
}

window.verse.onPreviewText(({ kind, text }) => appendPreview(kind, text));

function stopMeter() {
  window.cancelAnimationFrame(meterFrame);
  meterFrame = null;
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }
  meterContext.clearRect(0, 0, meterCanvas.width, meterCanvas.height);
  body.classList.remove("warming");
  dropDing(); // no-op if the ready tone already played
}

function finishLater(delayMs) {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    setState("idle");
    window.verse.hidePanel();
  }, delayMs);
}

function showError(message) {
  stopMeter(); // also halts a still-running warm-up sweep
  errorText.textContent = message || "Something went wrong.";
  body.dataset.state = "error";
  window.verse.reportRecorderState("idle");
  finishLater(2600);
}

async function transcribe(file, durationMs) {
  setState("transcribing");
  const plan = await window.verse.getTranscribePlan(durationMs).catch(() => null);
  startTranscribeAnim(envelopeToBars(), plan?.etaMs || 2000);
  try {
    const audio = {
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name,
      mimeType: file.type,
      durationMs,
    };
    await window.verse.completeRecording(audio);
    await finishTranscribeAnim();
    body.dataset.state = "done";
    window.verse.reportRecorderState("idle");
    finishLater(1100);
  } catch (error) {
    stopTranscribeAnim();
    const message = String(error?.message || error).replace(
      /^Error invoking remote method '[^']+': (Error: )?/u,
      ""
    );
    showError(message);
  }
}

async function startRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") return;
  window.clearTimeout(hideTimer);
  // Paint the recording view before waiting on the microphone: after a few
  // idle minutes the audio device takes ~half a second to warm up, and a
  // blank panel reads as lag. Until capture is live the panel shows a
  // distinct warming state — grey dot, dim title, "…" timer, power-on sweep
  // across the meter — then flips with a ready tone when audio flows.
  pendingAction = null;
  captureLive = false;
  envelope = [];
  envelopeAt = 0;
  stopTranscribeAnim();
  warmupStart = performance.now();
  timerText.textContent = "…";
  body.classList.add("warming");
  setState("recording");
  startSweep();
  warmDing();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = recordingType();
    const options = mimeType ? { mimeType } : undefined;
    recordedChunks = [];
    cancelled = false;
    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) recordedChunks.push(event.data);
    });

    mediaRecorder.addEventListener("stop", async () => {
      const durationMs = Date.now() - startedAt;
      stream.getTracks().forEach((track) => track.stop());
      stopTimer();
      stopMeter();
      stopPreviewPump();

      if (cancelled) {
        recordedChunks = [];
        setState("idle");
        window.verse.hidePanel();
        return;
      }

      const type = mediaRecorder.mimeType || mimeType || "audio/webm";
      let blob = new Blob(recordedChunks, { type });
      recordedChunks = [];
      let extension = extensionForType(type);
      if (wantsWav && !type.includes("wav")) {
        try {
          blob = await blobToWav(blob);
          extension = "wav";
        } catch {
          // Fall through with the original recording; the engine reports
          // a clearer error than a silent failure here would.
        }
      }
      const file = new File([blob], `recording-${Date.now()}.${extension}`, { type: blob.type });
      await transcribe(file, durationMs);
    });

    mediaRecorder.start();
    // Baseline for durationMs in case recording stops before capture goes
    // live; goLive() re-anchors it to the first real audio.
    startedAt = Date.now();
    startMeter(stream);
    if (previewOn) {
      try {
        startPreviewPump(stream);
      } catch {
        // Preview is best effort; recording continues without it.
      }
    }
    // A stop or cancel that arrived while the microphone was warming up.
    if (pendingAction === "stop") stopRecording();
    else if (pendingAction === "cancel") cancelRecording();
    pendingAction = null;
  } catch (error) {
    showError(error?.message || "Microphone access was blocked.");
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  } else if (body.dataset.state === "recording") {
    pendingAction = "stop";
  }
}

function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    cancelled = true;
    mediaRecorder.stop();
  } else if (body.dataset.state === "recording") {
    pendingAction = "cancel";
  }
}

function shortcutLabel(accelerator) {
  return String(accelerator || "")
    .replace("Control", "⌃")
    .replace("Alt", "⌥")
    .replace("Shift", "⇧")
    .replace("Command", "⌘")
    .replaceAll("+", "");
}

window.verse.onRecorderCommand(({ action, shortcut, wav, preview }) => {
  if (shortcut) shortcutHint.textContent = shortcutLabel(shortcut);
  if (action === "start") {
    wantsWav = Boolean(wav);
    previewOn = Boolean(preview);
    body.classList.toggle("preview-on", previewOn);
    startRecording();
  }
  if (action === "stop") stopRecording();
  if (action === "cancel") cancelRecording();
});

stopButton.addEventListener("click", stopRecording);
cancelButton.addEventListener("click", cancelRecording);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") cancelRecording();
  if (event.key === "Enter" || event.key === " ") stopRecording();
});

window.verse
  .getSettings()
  .then((settings) => {
    shortcutHint.textContent = shortcutLabel(settings.shortcut);
  })
  .catch(() => {});
