import { getPeer } from './peer.js';
import { session, changed } from './session.js';
import { modal, toast } from './ui.js';

export const voice = { call: null, local: null, remote: null, muted: false, state: 'idle' };

let audioEl = null;

function playRemote(stream) {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.autoplay = true;
    audioEl.setAttribute('playsinline', '');  // ios won't play inline without this
    document.body.append(audioEl);
  }
  audioEl.srcObject = stream;

  audioEl.play().catch((e) => {
    console.warn('[voice] autoplay blocked:', e.name, '- waiting for a gesture');
    toast('Tap anywhere to hear audio', 'err');
    const retry = () => {
      audioEl.play().then(() => {
        console.log('[voice] audio started after gesture');
        off();
      }).catch(() => {});
    };
    const off = () => {
      document.removeEventListener('pointerdown', retry);
      document.removeEventListener('keydown', retry);
    };
    document.addEventListener('pointerdown', retry);
    document.addEventListener('keydown', retry);
  });
}

async function mic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Mic needs https. Open the https:// url, not http://', 'err');
    console.error('[voice] no getUserMedia — insecure context?', location.origin);
    return null;
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const track = s.getAudioTracks()[0];
    if (track) track.enabled = true;
    return s;
  } catch (e) {
    console.error('[voice] getUserMedia failed:', e.name, e.message);
    toast(`Mic blocked: ${e.name}`, 'err');
    return null;
  }
}

export async function startCall() {
  const target = session.conn?.peer;
  if (voice.state !== 'idle' || !target) return;
  const stream = await mic();
  if (!stream) return;
  if (!session.conn?.open) { stream.getTracks().forEach((t) => t.stop()); return; }
  voice.local = stream;
  voice.state = 'calling';
  changed();

  const call = getPeer().call(target, stream);
  bind(call);
}

export function answer(call) {
  mic().then((stream) => {
    if (!stream) { call.close(); voice.state = 'idle'; changed(); return; }
    voice.local = stream;
    voice.state = 'connecting';
    changed();
    call.answer(stream);
    bind(call);
  });
}

export function incoming(call) {
  if (voice.state !== 'idle') { call.close(); return; }
  voice.state = 'ringing';
  changed();
  const close = modal({
    title: 'Incoming call',
    body: `${session.friend?.display_name || 'Your friend'} is calling.`,
    actions: [
      { label: 'Decline', onClick: () => { call.close(); voice.state = 'idle'; changed(); } },
      { label: 'Answer', kind: 'primary', onClick: () => answer(call) },
    ],
  });
  call.on('close', () => { close(); if (voice.state === 'ringing') { voice.state = 'idle'; changed(); } });
}

function bind(call) {
  voice.call = call;

  const ring = setTimeout(() => {
    if (voice.state !== 'live') { toast('No answer', 'err'); hangup(false); }
  }, 45000);

  call.on('stream', (remote) => {
    clearTimeout(ring);
    voice.remote = remote;
    voice.state = 'live';
    playRemote(remote);
    changed();

    const mine = voice.local?.getAudioTracks()[0];
    if (mine && !voice.muted) mine.enabled = true;
  });
  call.on('close', () => { clearTimeout(ring); hangup(true); });
  call.on('error', (e) => { clearTimeout(ring); console.error('call error', e); hangup(true); });

  // don't re-acquire the mic here. tried it, it stopped the live track and cut audio.
}

export function hangup(remoteEnded) {
  if (voice.call && !remoteEnded) { try { voice.call.close(); } catch {} }
  voice.local?.getTracks().forEach((t) => t.stop());
  if (audioEl) audioEl.srcObject = null;
  voice.call = null;
  voice.local = null;
  voice.remote = null;
  voice.muted = false;
  voice.state = 'idle';
  changed();
}

export function toggleMute() {
  if (!voice.local) return;
  voice.muted = !voice.muted;
  voice.local.getAudioTracks().forEach((t) => { t.enabled = !voice.muted; });
  changed();
}
