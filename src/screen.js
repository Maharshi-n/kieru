import { getPeer } from './peer.js';
import { session, changed, on } from './session.js';
import { toast } from './ui.js';

// separate connection from voice so sharing never renegotiates the audio call
export const screen = { sending: null, receiving: null, call: null, state: 'idle' };

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
