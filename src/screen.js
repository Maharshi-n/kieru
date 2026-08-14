import { getPeer } from './peer.js';
import { session, changed, on } from './session.js';
import { toast } from './ui.js';
import * as api from './api.js';

// separate connection from voice so sharing never renegotiates the audio call
export const screen = { sending: null, receiving: null, call: null, state: 'idle' };

// relayed sharing is metered, so every user gets a small daily budget. the
// server holds the real count; this is just what we last heard from it.
export const quota = { used: 0, budget: 20, left: 20, known: false };
let tickTimer = null;

export async function loadQuota() {
  try {
    const { used, budget } = await api.get('/share/quota');
    quota.used = used;
    quota.budget = budget;
    quota.left = Math.max(0, budget - used);
    quota.known = true;
    changed();
  } catch {}
}

const TICK_MS = 5000;

function startMetering() {
  const spend = async (seconds) => {
    try {
      const r = await api.post('/share/tick', { seconds });
      quota.used = r.used;
      quota.budget = r.budget;
      quota.left = Math.max(0, r.budget - r.used);
      quota.known = true;
      if (r.exhausted) {
        stopShare();
        toast('Daily screen share limit reached. It resets tomorrow.', 'err');
      }
      changed();
    } catch {}
  };

  let elapsed = 0;
  const started = Date.now();
  tickTimer = setInterval(() => {
    const total = Math.floor((Date.now() - started) / 1000);
    const chunk = total - elapsed;
    if (chunk < 1) return;
    elapsed = total;
    // stop locally the moment the budget runs out instead of waiting for the
    // round trip, otherwise a slow reply leaks seconds
    if (total >= quota.left) { stopShare(); toast('Daily screen share limit reached. It resets tomorrow.', 'err'); }
    spend(chunk);
  }, TICK_MS);
}

function stopMetering() {
  clearInterval(tickTimer);
  tickTimer = null;
}

let videoEl = null;

export function setVideoEl(el) {
  videoEl = el;
  if (el && screen.receiving) attach();
}

function attach() {
  if (!videoEl || !screen.receiving) return;
  videoEl.srcObject = screen.receiving;
  videoEl.play().catch(() => {});
}

export async function startShare() {
  if (screen.state !== 'idle' || !session.conn?.open) return;
  let stream;
  const relayed = session.type === 'relay';

  if (relayed) {
    await loadQuota();
    if (quota.known && quota.left <= 0) {
      toast('You have used your daily screen share time. It resets tomorrow.', 'err');
      return;
    }
  }

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // relayed frames cost turn quota, so ask for less of them
      video: relayed
        ? { frameRate: { ideal: 5, max: 10 }, width: { max: 1280 } }
        : { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast(`Screen share failed: ${e.name}`, 'err');
    return;
  }

  screen.sending = stream;
  screen.state = 'sending';
  if (relayed) startMetering();
  changed();

  stream.getVideoTracks()[0].addEventListener('ended', stopShare);

  screen.call = getPeer().call(session.conn.peer, stream, { metadata: { kind: 'screen' } });

  // frameRate alone is a hint; the encoder bitrate is what actually bounds the bytes
  setTimeout(() => {
    const sender = screen.call?.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    params.encodings[0].maxBitrate = relayed ? 300_000 : 1_500_000;
    sender.setParameters(params).catch((e) => console.warn('[screen] bitrate cap failed', e));
  }, 1000);
  screen.call.on('close', () => { if (screen.state === 'sending') stopShare(); });
  screen.call.on('error', (e) => { console.error('[screen] call error', e); stopShare(); });
}

export function stopShare() {
  stopMetering();
  screen.sending?.getTracks().forEach((t) => t.stop());
  if (screen.call && screen.state === 'sending') { try { screen.call.close(); } catch {} }
  screen.sending = null;
  screen.call = null;
  if (screen.state === 'sending') screen.state = 'idle';
  changed();
}

export function incomingShare(call) {
  if (screen.receiving) { call.close(); return; }
  call.answer();
  screen.state = 'receiving';
  call.on('stream', (remote) => {
    screen.receiving = remote;
    changed();
    attach();
    toast('Your friend is sharing their screen');
  });
  const done = () => {
    screen.receiving?.getTracks().forEach((t) => t.stop());
    screen.receiving = null;
    if (videoEl) videoEl.srcObject = null;
    if (screen.state === 'receiving') screen.state = 'idle';
    changed();
  };
  call.on('close', done);
  call.on('error', done);
}

export function resetScreen() {
  stopShare();
  screen.receiving?.getTracks().forEach((t) => t.stop());
  screen.receiving = null;
  screen.state = 'idle';
  if (videoEl) videoEl.srcObject = null;
}

on('ended', resetScreen);
