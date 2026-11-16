// Piloto: lê o controle de Xbox/PlayStation (Gamepad API), manda comandos ao
// carro por WebSocket e mostra o vídeo do carro por WebRTC (WHEP do MediaMTX).
//
// Dois jeitos de abrir esta página:
// - no celular, em https://carro.<tailnet>.ts.net (servida pelo próprio carro
//   via `tailscale serve`): controle e vídeo vêm da mesma origem;
// - no PC, em http://localhost (testes de bancada): fala direto com as portas.
"use strict";

const SEND_HZ = 50;
const PING_MS = 500;
const DEADZONE = 0.08;
const SPEED_LEVELS = [0.25, 0.5, 0.75, 1];
const VIDEO_STALL_MS = 700;
const ARM_MAX_THROTTLE = 0.05;

// Índices no mapeamento "standard" (controle de Xbox no Chrome/Edge).
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9 };

const DEFAULTS = { host: "carro", controlPort: 8765, videoPort: 8889, videoPath: "cam", requireVideo: true };
const STORAGE_KEY = "rc-pilot-settings";
const SERVED_BY_CAR = location.protocol === "https:";

const $ = (id) => document.getElementById(id);
const video = $("video");

const settings = loadSettings();
const state = {
  ws: null,
  connected: false,
  reconnectTimer: null,
  pc: null,
  videoRetryTimer: null,
  lastFrame: 0,
  armed: false,
  level: 0,
  rtt: null,
  input: { t: 0, s: 0, pad: null },
  sent: { t: 0, s: 0 },
  stalled: false,
  prevPressed: [],
  keys: new Set(),
  alertTimer: null,
  wakeLock: null,
};

function endpoints() {
  if (SERVED_BY_CAR) {
    return {
      control: `wss://${location.host}/control`,
      whep: `${location.origin}/${settings.videoPath}/whep`,
    };
  }
  return {
    control: `ws://${settings.host}:${settings.controlPort}/control`,
    whep: `http://${settings.host}:${settings.videoPort}/${settings.videoPath}/whep`,
  };
}

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // sem armazenamento: só não lembra na próxima vez
  }
}

function flash(message, ms = 2500) {
  const el = $("alert");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(state.alertTimer);
  state.alertTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- controle (WebSocket) ----------

function connectControl() {
  clearTimeout(state.reconnectTimer);
  if (state.ws) state.ws.close();

  const ws = new WebSocket(endpoints().control);
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "pong" && typeof msg.ts === "number") {
      state.rtt = performance.now() - msg.ts;
    } else if (msg.type === "hello") {
      console.info("carro:", msg);
    }
  };
  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    state.ws = null;
    state.connected = false;
    state.rtt = null;
    setArmed(false);
    if (ev.code === 4000) {
      flash("Outro piloto assumiu o carro.", 5000);
      return; // não brigar com o outro notebook
    }
    state.reconnectTimer = setTimeout(connectControl, 1000);
  };
}

function send(msg) {
  if (state.connected && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

// ---------- vídeo (WebRTC / WHEP) ----------

function stopVideo() {
  clearTimeout(state.videoRetryTimer);
  if (state.pc) {
    const pc = state.pc;
    state.pc = null;
    pc.close();
  }
  video.srcObject = null;
}

function retryVideo() {
  stopVideo();
  state.videoRetryTimer = setTimeout(startVideo, 2000);
}

function waitIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener("icegatheringstatechange", check); resolve(); };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(done, timeoutMs);
  });
}

async function startVideo() {
  stopVideo();
  const pc = new RTCPeerConnection();
  state.pc = pc;
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (ev) => {
    // Pede ao navegador o menor buffer possível: atraso importa mais que suavidade.
    try { ev.receiver.jitterBufferTarget = 0; } catch { /* navegador antigo */ }
    try { ev.receiver.playoutDelayHint = 0; } catch { /* idem */ }
    video.srcObject = ev.streams[0] || new MediaStream([ev.track]);
  };
  pc.onconnectionstatechange = () => {
    if (state.pc === pc && (pc.connectionState === "failed" || pc.connectionState === "closed")) retryVideo();
  };

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceGathering(pc, 2000);
    const res = await fetch(endpoints().whep, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) throw new Error(`WHEP respondeu ${res.status}`);
    if (state.pc !== pc) return;
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
  } catch (err) {
    console.warn("vídeo:", err);
    if (state.pc === pc) retryVideo();
  }
}

function watchFrames() {
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
    video.addEventListener("timeupdate", () => { state.lastFrame = performance.now(); });
    return;
  }
  const onFrame = () => {
    state.lastFrame = performance.now();
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

// ---------- entrada (controle de Xbox / teclado) ----------

function deadzone(v) {
  const a = Math.abs(v);
  return a < DEADZONE ? 0 : Math.sign(v) * (a - DEADZONE) / (1 - DEADZONE);
}

function firstPad() {
  for (const pad of navigator.getGamepads ? navigator.getGamepads() : []) {
    if (pad && pad.connected) return pad;
  }
  return null;
}

function readInput() {
  const pad = firstPad();
  if (pad) {
    const value = (i) => (pad.buttons[i] ? pad.buttons[i].value : 0);
    const pressed = pad.buttons.map((b) => b.pressed);
    const justPressed = (i) => pressed[i] && !state.prevPressed[i];

    const t = value(BTN.RT) - value(BTN.LT);
    if (justPressed(BTN.MENU)) setArmed(!state.armed, t);
    if (justPressed(BTN.B)) setArmed(false);
    if (justPressed(BTN.RB)) changeLevel(+1);
    if (justPressed(BTN.LB)) changeLevel(-1);
    state.prevPressed = pressed;

    return { t, s: deadzone(pad.axes[0] || 0), pad };
  }
  state.prevPressed = [];
  const k = state.keys;
  return {
    t: (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0),
    s: (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0),
    pad: null,
  };
}

function setArmed(on, currentThrottle = state.input.t) {
  if (on && !state.connected) {
    flash("Conecte ao carro antes de armar.");
    return;
  }
  if (on && Math.abs(currentThrottle) > ARM_MAX_THROTTLE) {
    flash("Solte os gatilhos para armar.");
    return;
  }
  if (state.armed === on) return;
  state.armed = on;
  rumble(on ? 120 : 60);
}

function changeLevel(delta) {
  state.level = Math.max(0, Math.min(SPEED_LEVELS.length - 1, state.level + delta));
}

function rumble(ms) {
  const pad = firstPad();
  const actuator = pad && pad.vibrationActuator;
  if (actuator && actuator.playEffect) {
    actuator.playEffect("dual-rumble", { duration: ms, strongMagnitude: 0.6, weakMagnitude: 0.6 }).catch(() => {});
  }
}

function tick() {
  const input = readInput();
  state.input = input;

  state.stalled = settings.requireVideo && performance.now() - state.lastFrame > VIDEO_STALL_MS;
  let t = state.armed ? input.t * SPEED_LEVELS[state.level] : 0;
  if (state.stalled) t = 0; // sem imagem, sem acelerador

  state.sent = { t, s: input.s };
  send({ type: "cmd", t, s: input.s, armed: state.armed });
}

// ---------- tela ----------

function setChip(el, text, level) {
  el.textContent = text;
  el.className = `chip ${level}`;
}

function setBar(el, v) {
  const pct = Math.min(1, Math.abs(v)) * 50;
  el.style.width = `${pct}%`;
  el.style.left = v >= 0 ? "50%" : `${50 - pct}%`;
  el.classList.toggle("neg", v < 0);
}

function render() {
  setChip($("chip-link"), state.connected ? "controle: ok" : "controle: desconectado", state.connected ? "ok" : "bad");

  const hasVideo = performance.now() - state.lastFrame < VIDEO_STALL_MS;
  setChip($("chip-video"),
    hasVideo ? `vídeo: ${video.videoWidth}×${video.videoHeight}` : state.pc ? "vídeo: aguardando" : "vídeo: desligado",
    hasVideo ? "ok" : state.pc ? "warn" : "bad");
  $("no-video").hidden = hasVideo;

  if (state.rtt == null) setChip($("chip-rtt"), "ping: —", "");
  else setChip($("chip-rtt"), `ping: ${Math.round(state.rtt)} ms`, state.rtt < 120 ? "ok" : state.rtt < 250 ? "warn" : "bad");

  const pad = state.input.pad;
  if (pad) setChip($("chip-pad"), pad.mapping === "standard" ? "controle ok" : "controle sem mapeamento padrão", pad.mapping === "standard" ? "ok" : "warn");
  else setChip($("chip-pad"), "teclado", "warn");

  const armed = $("armed");
  armed.textContent = !state.armed ? "DESARMADO" : state.stalled ? "ARMADO · SEM VÍDEO" : "ARMADO";
  armed.className = `armed ${state.armed ? "on" : "off"}`;

  setBar($("bar-steer"), state.sent.s);
  setBar($("bar-throttle"), state.sent.t);
  $("level").textContent = `${state.level + 1}/${SPEED_LEVELS.length}`;

  requestAnimationFrame(render);
}

// ---------- ajustes e eventos ----------

function fillSettingsForm() {
  $("in-host").value = settings.host;
  $("in-control-port").value = settings.controlPort;
  $("in-video-port").value = settings.videoPort;
  $("in-video-path").value = settings.videoPath;
  $("in-require-video").checked = settings.requireVideo;
}

function readSettingsForm() {
  settings.host = $("in-host").value.trim() || DEFAULTS.host;
  settings.controlPort = Number($("in-control-port").value) || DEFAULTS.controlPort;
  settings.videoPort = Number($("in-video-port").value) || DEFAULTS.videoPort;
  settings.videoPath = $("in-video-path").value.trim() || DEFAULTS.videoPath;
  settings.requireVideo = $("in-require-video").checked;
  saveSettings();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
}

// Celular apagando a tela no meio da rua = carro desarmado. Pede pra ficar acesa.
async function keepScreenOn() {
  if (!navigator.wakeLock || (state.wakeLock && !state.wakeLock.released)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // negado (bateria fraca, navegador sem suporte): segue sem
  }
}

$("btn-connect").addEventListener("click", () => {
  readSettingsForm();
  connectControl();
  startVideo();
  keepScreenOn();
  $("settings").hidden = true;
});
$("btn-settings").addEventListener("click", () => { $("settings").hidden = !$("settings").hidden; });
$("btn-fullscreen").addEventListener("click", toggleFullscreen);
$("in-require-video").addEventListener("change", readSettingsForm);

window.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
  const key = ev.key.toLowerCase();
  if (key === " ") { ev.preventDefault(); if (!ev.repeat) setArmed(!state.armed); return; }
  if (key === "escape") { setArmed(false); return; }
  if (key === "q" && !ev.repeat) changeLevel(-1);
  if (key === "e" && !ev.repeat) changeLevel(+1);
  if (key === "f" && !ev.repeat) toggleFullscreen();
  state.keys.add(key);
});
window.addEventListener("keyup", (ev) => state.keys.delete(ev.key.toLowerCase()));
window.addEventListener("blur", () => { state.keys.clear(); setArmed(false); });
// Aba em segundo plano: o navegador desacelera os timers e o carro ficaria aos trancos.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) setArmed(false);
  else if (state.connected) keepScreenOn(); // o wake lock cai quando a aba some
});
window.addEventListener("gamepaddisconnected", () => { setArmed(false); flash("Controle desconectado."); });

$("direct-fields").hidden = SERVED_BY_CAR;
fillSettingsForm();
watchFrames();
setInterval(tick, 1000 / SEND_HZ);
setInterval(() => send({ type: "ping", ts: performance.now() }), PING_MS);
requestAnimationFrame(render);
