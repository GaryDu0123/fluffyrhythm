import { CLIP_DURATION, TRAVEL_TIME, createChart, judgeDelta, normalizeScore, rankFor } from "./game-core.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const audio = $("#game-audio");
const menuBgm = $("#menu-bgm");
const uiButtonSound = $("#ui-button-sfx");
const screens = $$(".screen");
const defaultChart = createChart();
let chart = defaultChart;
let noteById = new Map();
let laneNotes = [[], [], [], []];

let mode = "start";
let rawScore = 0;
let combo = 0;
let maxCombo = 0;
let counts = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
let animationId = 0;
let offsetMs = Number(localStorage.getItem("naru-rhythm-offset") || 0);
let pausedByVisibility = false;
let resumeMode = "playing";
const mvVideo = $("#mv-video");
let mvReady = Boolean(mvVideo);
let spawnCursor = 0;
const activeNoteIds = new Set();

const MV_START_SECONDS = 0;
const PREROLL_DURATION = 3;
const SONG_MUTED_FOR_TAP_TEST = false;
const TapAudioContext = window.AudioContext || window.webkitAudioContext;
let tapAudioContext = null;
let tapAudioGain = null;
let tapSoundBuffer = null;
let tapSoundLoadPromise = null;
let menuBgmUnlocked = false;
let menuBgmFadeTimer = 0;
let menuBgmFadeToken = 0;
let menuBgmStartTimer = 0;

const keyMap = { KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3 };

function setActiveChart(notes) {
  chart = notes.map((note, id) => ({ id, time: note.time, lane: note.lane }));
  noteById = new Map(chart.map((note) => [note.id, { ...note, state: "waiting", el: null }]));
  laneNotes = [0, 1, 2, 3].map((lane) => chart.filter((note) => note.lane === lane).map((note) => note.id));
  spawnCursor = 0;
  activeNoteIds.clear();
}

setActiveChart(defaultChart);

const chartReady = fetch("./chart.json", { cache: "no-store" })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("chart fetch failed")))
  .then((data) => {
    if (!Array.isArray(data.notes) || !data.notes.length) return;
    const valid = data.notes.every((note) => Number.isFinite(note?.time) && note.time >= 0 && note.time <= CLIP_DURATION && Number.isInteger(note?.lane) && note.lane >= 0 && note.lane <= 3);
    if (!valid) return;
    setActiveChart(data.notes);
    const count = $("#note-count");
    if (count) count.textContent = String(chart.length);
  })
  .catch(() => { /* 公開譜面を取得できない場合は内蔵譜面で継続する。 */ });

function showScreen(id) {
  screens.forEach((screen) => screen.classList.toggle("active", screen.id === id));
  window.clearTimeout(menuBgmStartTimer);
  if (id === "game-screen") fadeMenuBgm(0, true);
  else if (menuBgmUnlocked) startMenuBgm(id === "result-screen" ? 1000 : 0);
}

function fadeMenuBgm(targetVolume, pauseAtEnd = false) {
  if (!menuBgm) return;
  window.clearInterval(menuBgmFadeTimer);
  const token = ++menuBgmFadeToken;
  const from = menuBgm.volume;
  const steps = 12;
  let step = 0;
  menuBgmFadeTimer = window.setInterval(() => {
    if (token !== menuBgmFadeToken) return;
    step += 1;
    menuBgm.volume = from + (targetVolume - from) * Math.min(1, step / steps);
    if (step >= steps) {
      window.clearInterval(menuBgmFadeTimer);
      if (pauseAtEnd) menuBgm.pause();
    }
  }, 24);
}

function startMenuBgm(delayMs = 0) {
  if (!menuBgm || !menuBgmUnlocked || $("#game-screen").classList.contains("active")) return;
  menuBgmStartTimer = window.setTimeout(() => {
    if (!menuBgmUnlocked || $("#game-screen").classList.contains("active")) return;
    menuBgm.volume = Math.min(menuBgm.volume, 0.24);
    void menuBgm.play().then(() => {
      if (!$("#game-screen").classList.contains("active")) fadeMenuBgm(0.24);
      else { menuBgm.pause(); menuBgm.volume = 0; }
    }).catch(() => {
      const status = $("#loading-status");
      if (status) status.textContent = "BGMを再生できません。端末の音量をご確認ください。";
    });
  }, delayMs);
}

function formatScore(score) {
  return String(score).padStart(7, "0");
}

function smoothMediaTime() {
  // The audio element is the single authoritative clock. A performance.now()
  // estimate can drift from Safari's real audio output over a long song.
  return audio.currentTime || 0;
}

function currentSongTime() {
  return smoothMediaTime() - PREROLL_DURATION;
}

function effectiveTime() {
  return currentSongTime() + offsetMs / 1000;
}

function resetState() {
  cancelAnimationFrame(animationId);
  audio.pause();
  audio.muted = SONG_MUTED_FOR_TAP_TEST;
  try { audio.currentTime = 0; } catch { /* Safari may reject seeking before metadata is ready. */ }
  spawnCursor = 0;
  activeNoteIds.clear();
  rawScore = 0;
  combo = 0;
  maxCombo = 0;
  counts = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
  noteById.forEach((note) => {
    note.state = "waiting";
    note.el?.remove();
    note.el = null;
  });
  $("#score").textContent = "0000000";
  $("#combo strong").textContent = "0";
  $("#progress-bar").style.width = "0%";
  $("#pause-overlay").hidden = true;
  $("#countdown").classList.remove("show", "pulse");
}

function setOffset(value) {
  offsetMs = Math.max(-200, Math.min(300, value));
  localStorage.setItem("naru-rhythm-offset", String(offsetMs));
  $("#offset-label").textContent = `${offsetMs > 0 ? "+" : ""}${offsetMs}ms`;
  $("#offset-output").textContent = `${offsetMs > 0 ? "+" : ""}${offsetMs}ms`;
}

function flashLane(laneIndex, clientX, clientY) {
  const lane = $(`.lane[data-lane="${laneIndex}"]`);
  if (!lane) return;
  const bounds = lane.getBoundingClientRect();
  const x = Number.isFinite(clientX) ? clientX - bounds.left : bounds.width / 2;
  const y = Number.isFinite(clientY) ? clientY - bounds.top : bounds.height * 0.86;
  const burst = document.createElement("i");
  burst.className = "hit-flash";
  burst.setAttribute("aria-hidden", "true");
  burst.style.left = `${Math.max(0, Math.min(bounds.width, x))}px`;
  burst.style.top = `${Math.max(0, Math.min(bounds.height, y))}px`;
  lane.append(burst);
  burst.addEventListener("animationend", () => burst.remove(), { once: true });
  window.setTimeout(() => burst.remove(), 360);
  lane.classList.add("pressed");
  window.setTimeout(() => lane.classList.remove("pressed"), 90);
}

function getTapAudioContext() {
  if (!TapAudioContext) return null;
  if (!tapAudioContext) {
    try {
      tapAudioContext = new TapAudioContext({ latencyHint: "interactive" });
    } catch {
      tapAudioContext = new TapAudioContext();
    }
    tapAudioGain = tapAudioContext.createGain();
    tapAudioGain.gain.value = 1.25;
    tapAudioGain.connect(tapAudioContext.destination);
  }
  return tapAudioContext;
}

function loadTapSound() {
  if (tapSoundBuffer) return Promise.resolve(tapSoundBuffer);
  if (tapSoundLoadPromise) return tapSoundLoadPromise;
  const context = getTapAudioContext();
  if (!context) return Promise.resolve(null);
  tapSoundLoadPromise = fetch("./assets/audio/tap-hit-trimmed.wav?v=10", { cache: "force-cache" })
    .then((response) => {
      if (!response.ok) throw new Error("tap sound fetch failed");
      return response.arrayBuffer();
    })
    .then((data) => context.decodeAudioData(data))
    .then((buffer) => {
      tapSoundBuffer = buffer;
      return buffer;
    })
    .catch(() => null);
  return tapSoundLoadPromise;
}

function unlockTapAudio() {
  const context = getTapAudioContext();
  if (!context) return;
  void loadTapSound();
  if (context.state === "suspended") void context.resume().catch(() => {});
}

function playButtonSound() {
  if (!uiButtonSound) return;
  try { uiButtonSound.currentTime = 0; } catch { /* metadata may still be loading */ }
  void uiButtonSound.play().catch(() => {});
}

function playTapSound() {
  const context = getTapAudioContext();
  if (!context || !tapSoundBuffer || !tapAudioGain) {
    void loadTapSound();
    return;
  }
  const play = () => {
    const source = context.createBufferSource();
    source.buffer = tapSoundBuffer;
    source.connect(tapAudioGain);
    source.start(0);
  };
  if (context.state === "running") play();
  else void context.resume().then(play).catch(() => {});
}

void loadTapSound();

function syncMV() {
  if (!mvReady || !mvVideo) return;
  try {
    mvVideo.muted = true;
    const target = MV_START_SECONDS + Math.max(0, Math.min(CLIP_DURATION, currentSongTime()));
    if (Math.abs(mvVideo.currentTime - target) > 0.45) mvVideo.currentTime = target;
    const playPromise = mvVideo.play();
    if (playPromise) void playPromise.catch(() => {});
  } catch { /* The game audio remains authoritative if video playback is unavailable. */ }
}

function pauseMV() {
  if (!mvVideo) return;
  try { mvVideo.pause(); } catch { /* no-op */ }
}

function stopMV() {
  if (!mvVideo) return;
  try {
    mvVideo.pause();
    mvVideo.currentTime = MV_START_SECONDS;
  } catch { /* no-op */ }
}

function showJudgement(label) {
  const el = $("#judgement");
  el.className = `judgement ${label}`;
  el.textContent = label;
  el.getAnimations().forEach((animation) => animation.cancel());
  el.animate([
    { opacity: 0, transform: "translate(-50%,12px) scale(.8)" },
    { opacity: 1, transform: "translate(-50%,0) scale(1.08)", offset: .28 },
    { opacity: 0, transform: "translate(-50%,-10px) scale(1)" }
  ], { duration: 420, easing: "ease-out" });
}

function createNoteElement(note) {
  const lane = $(`.lane[data-lane="${note.lane}"]`);
  const el = document.createElement("i");
  el.className = "note";
  el.setAttribute("aria-hidden", "true");
  lane.appendChild(el);
  note.el = el;
  return el;
}

function markMiss(note) {
  if (note.state !== "waiting") return;
  note.state = "miss";
  activeNoteIds.delete(note.id);
  counts.MISS += 1;
  combo = 0;
  $("#combo strong").textContent = "0";
  showJudgement("MISS");
  if (note.el) {
    note.el.classList.add("missed");
    window.setTimeout(() => note.el?.remove(), 160);
  }
}

function tapLane(laneIndex, clientX, clientY) {
  if (mode !== "playing") return;
  flashLane(laneIndex, clientX, clientY);
  playTapSound();
  const now = effectiveTime();
  const candidateId = laneNotes[laneIndex]
    .map((id) => noteById.get(id))
    .find((note) => note.state === "waiting" && note.time >= now - 0.24);
  if (!candidateId) return;
  const judgement = judgeDelta(now - candidateId.time);
  if (!judgement) return;
  candidateId.state = "hit";
  activeNoteIds.delete(candidateId.id);
  rawScore += judgement.value;
  counts[judgement.label] += 1;
  combo += 1;
  maxCombo = Math.max(maxCombo, combo);
  $("#combo strong").textContent = String(combo);
  $("#score").textContent = formatScore(normalizeScore(rawScore, chart.length));
  showJudgement(judgement.label);
  if (candidateId.el) {
    const field = $("#playfield");
    candidateId.el.style.setProperty("--hit-y", `${field.clientHeight * .86}px`);
    candidateId.el.classList.add("hit");
    window.setTimeout(() => candidateId.el?.remove(), 190);
  }
}

function render() {
  if (mode !== "countdown" && mode !== "playing") return;
  const mediaNow = smoothMediaTime();
  const songNow = mediaNow - PREROLL_DURATION;
  const countdown = $("#countdown");

  if (mode === "countdown") {
    if (songNow >= 0) {
      mode = "playing";
      countdown.classList.remove("show", "pulse");
      syncMV();
    } else {
      const label = mediaNow >= PREROLL_DURATION - .28 ? "GO!" : String(Math.max(1, 3 - Math.floor(mediaNow)));
      if (countdown.textContent !== label) {
        countdown.textContent = label;
        countdown.classList.remove("pulse");
        void countdown.offsetWidth;
        countdown.classList.add("pulse");
      }
      animationId = requestAnimationFrame(render);
      return;
    }
  }

  const now = songNow + offsetMs / 1000;
  const field = $("#playfield");
  const startY = -34;
  const targetY = field.clientHeight * .86;
  const distance = targetY - startY;

  while (spawnCursor < chart.length && chart[spawnCursor].time - now < TRAVEL_TIME) {
    const note = noteById.get(chart[spawnCursor].id);
    if (note?.state === "waiting") {
      createNoteElement(note);
      activeNoteIds.add(note.id);
    }
    spawnCursor += 1;
  }

  for (const id of activeNoteIds) {
    const note = noteById.get(id);
    if (!note || note.state !== "waiting") {
      activeNoteIds.delete(id);
      continue;
    }
    const until = note.time - now;
    if (until > -0.3) {
      const el = note.el;
      const progress = 1 - until / TRAVEL_TIME;
      el.style.transform = `translate3d(-50%, ${startY + progress * distance}px, 0)`;
    }
    if (until < -0.24) markMiss(note);
  }

  $("#progress-bar").style.width = `${Math.min(100, Math.max(0, (songNow / CLIP_DURATION) * 100))}%`;
  if (audio.ended || songNow >= CLIP_DURATION - .08) {
    finishGame();
    return;
  }
  animationId = requestAnimationFrame(render);
}

async function startCountdown() {
  if (mode === "starting" || mode === "countdown" || mode === "playing") return;
  resetState();
  mode = "starting";
  const countdown = $("#countdown");
  countdown.classList.add("show");
  countdown.textContent = "LOADING";

  // The file contains a silent three-second preroll. play() still runs inside
  // the tap event for Safari, while the actual song begins after 3-2-1.
  audio.muted = SONG_MUTED_FOR_TAP_TEST;
  try { audio.currentTime = 0; } catch { /* play() will begin at the start once loaded. */ }
  let playPromise;
  try {
    showScreen("game-screen");
    // Start the muted MV first in the user's tap gesture, before either media
    // element can consume that activation on mobile browsers.
    if (mvReady) syncMV();
    playPromise = audio.play();
    unlockTapAudio();
    await Promise.race([
      Promise.resolve(playPromise),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("audio-start-timeout")), 10000))
    ]);
  } catch {
    audio.pause();
    mode = "start";
    showScreen("select-screen");
    $("#play-selected-button").textContent = "再生できませんでした。もう一度タップしてください";
    return;
  }

  mode = "countdown";
  animationId = requestAnimationFrame(render);
}

function pauseGame(byVisibility = false) {
  if (mode !== "playing" && mode !== "countdown") return;
  resumeMode = mode;
  mode = "paused";
  pausedByVisibility = byVisibility;
  cancelAnimationFrame(animationId);
  audio.pause();
  pauseMV();
  $("#pause-overlay").hidden = false;
}

async function resumeGame() {
  if (mode !== "paused") return;
  try {
    const playPromise = audio.play();
    unlockTapAudio();
    await playPromise;
    mode = resumeMode;
    if (mode === "playing") syncMV();
    pausedByVisibility = false;
    $("#pause-overlay").hidden = true;
    animationId = requestAnimationFrame(render);
  } catch {
    $("#resume-button").textContent = "もう一度タップして再開";
  }
}

function finishGame() {
  if (mode === "result") return;
  mode = "result";
  cancelAnimationFrame(animationId);
  audio.pause();
  pauseMV();
  noteById.forEach((note) => { if (note.state === "waiting") markMiss(note); });
  const score = normalizeScore(rawScore, chart.length);
  const result = rankFor(score);
  $("#rank").textContent = result.rank;
  $("#result-message").textContent = result.title;
  $("#final-score").textContent = formatScore(score);
  $("#max-combo").textContent = String(maxCombo);
  $("#perfect-count").textContent = String(counts.PERFECT);
  $("#great-count").textContent = String(counts.GREAT);
  $("#good-count").textContent = String(counts.GOOD);
  $("#miss-count").textContent = String(counts.MISS);
  $("#accuracy").textContent = `${(score / 10_000).toFixed(1)}%`;

  const previousHighScore = Number(localStorage.getItem("naru-rhythm-highscore") || 0);
  const bestScore = Math.max(previousHighScore, score);
  if (score > previousHighScore) localStorage.setItem("naru-rhythm-highscore", String(score));
  $("#high-score-notice").textContent = score > previousHighScore
    ? "ハイスコア更新！"
    : `ハイスコア ${formatScore(bestScore)}`;

  const fullCombo = counts.MISS === 0 && maxCombo === chart.length;
  const fullComboDots = $("#full-combo-dots");
  fullComboDots.classList.toggle("complete", fullCombo);
  fullComboDots.setAttribute("aria-label", fullCombo ? "フルコンボ達成" : "フルコンボ未達成");
  showScreen("result-screen");
  sessionStorage.setItem("naru-rhythm-last", JSON.stringify({ score, rank: result.rank, maxCombo }));
}

function shareResult() {
  const score = $("#final-score").textContent;
  const rank = $("#rank").textContent;
  const shareUrl = "https://ubique.city/fluffyrhythm/";
  const songTitle = $("#result-title").textContent.trim();
  const text = `瀬名航＆鎖那のユニット「ubique」のリズムゲーム「Fluffy Rhythm」をやったよ！\nubique / ${songTitle}\nRANK ${rank} 獲得！(SCORE ${score})\n${shareUrl}`;
  const intentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  const popup = window.open(intentUrl, "_blank");
  if (popup) popup.opener = null;
  else location.href = intentUrl;
}

function selectSong() {
  showScreen("select-screen");
}

const noteCount = $("#note-count");
if (noteCount) noteCount.textContent = String(chart.length);
setOffset(offsetMs);

const markReady = () => { $("#start-label").textContent = "曲を選ぶ"; };
if (audio.readyState >= 3) markReady();
audio.addEventListener("canplay", markReady, { once: true });
audio.addEventListener("error", () => { $("#start-label").textContent = "音源を読み込めませんでした"; });
audio.load();

if (menuBgm) {
  menuBgm.volume = 0;
  const markBgmReady = () => {
    const status = $("#loading-status");
    if (status) status.textContent = "準備できました。音量にご注意ください。";
  };
  menuBgm.addEventListener("canplay", markBgmReady, { once: true });
  menuBgm.addEventListener("error", () => {
    const status = $("#loading-status");
    if (status) status.textContent = "準備できました。音が出ますので音量にご注意ください。";
  }, { once: true });
  menuBgm.load();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled || button.matches(".lane")) return;
  unlockTapAudio();
  playButtonSound();
}, true);

$("#loading-start-button").addEventListener("click", () => {
  menuBgmUnlocked = true;
  const gate = $("#loading-gate");
  gate.classList.add("dismissed");
  window.setTimeout(() => { gate.hidden = true; }, 430);
  startMenuBgm();
});

$("#start-button").addEventListener("click", () => {
  selectSong();
});
$("#select-back").addEventListener("click", () => showScreen("start-screen"));
$("#song-card").addEventListener("click", (event) => {
  const selected = event.currentTarget.classList.toggle("selected");
  event.currentTarget.setAttribute("aria-pressed", String(selected));
  $("#play-selected-button").disabled = !selected;
});
$("#play-selected-button").addEventListener("click", () => {
  // 選曲確認のタップを再生許可に使い、iOS Safariでも音源を開始する。
  $("#play-selected-button").textContent = "この曲で遊ぶ →";
  startCountdown();
});
$("#settings-button").addEventListener("click", () => {
  const settings = $("#settings");
  settings.hidden = !settings.hidden;
  $("#settings-button").setAttribute("aria-expanded", String(!settings.hidden));
});
$("#offset-minus").addEventListener("click", () => setOffset(offsetMs - 10));
$("#offset-plus").addEventListener("click", () => setOffset(offsetMs + 10));
$("#pause-button").addEventListener("click", () => pauseGame(false));
$("#resume-button").addEventListener("click", resumeGame);
$("#quit-button").addEventListener("click", () => { resetState(); stopMV(); mode = "start"; showScreen("select-screen"); });
$("#retry-button").addEventListener("click", () => showScreen("select-screen"));
$("#share-button").addEventListener("click", shareResult);

$$('.lane').forEach((lane) => {
  lane.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    tapLane(Number(lane.dataset.lane), event.clientX, event.clientY);
  });
});

window.addEventListener("keydown", (event) => {
  if (event.repeat || !(event.code in keyMap)) return;
  event.preventDefault();
  tapLane(keyMap[event.code]);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && (mode === "playing" || mode === "countdown")) pauseGame(true);
  else if (!document.hidden && pausedByVisibility) $("#resume-button").focus();
});
