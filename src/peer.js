import Peer from 'peerjs';
import { iceConfig, FORCE_RELAY } from './config.js';

export const PING_MS = 10000;
export const MISSED_PONG_LIMIT = 3;

let peer = null;
let ready = null;

export function getPeer() { return peer; }

export function initPeer() {
  if (ready) return ready;
  peer = new Peer({ config: iceConfig(), debug: 1 });

  ready = new Promise((resolve, reject) => {
    // the public peerjs cloud has no sla, and without this the app sits on
    // "Connecting…" forever
    const timer = setTimeout(() => {
      if (!peer?.open) reject(new Error('signaling server timed out'));
    }, 15000);

    peer.on('open', (id) => { clearTimeout(timer); resolve(id); });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') return;
      console.error('peer error', err.type, err);
      if (!peer.open) { clearTimeout(timer); reject(err); }
    });
  });

  peer.on('disconnected', () => {
    if (!peer.destroyed) peer.reconnect();
  });

  if (FORCE_RELAY) console.warn('force-relay on: all traffic through TURN');
  return ready;
}

export function destroyPeer() {
  peer?.destroy();
  peer = null;
  ready = null;
}

export async function connectionType(conn) {
  const pc = conn?.peerConnection;
  if (!pc) return 'direct';
  try {
    const stats = await pc.getStats();
    let pairId = null;
    const candidates = new Map();
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') candidates.set(r.id, r);
    });
    let pair = pairId ? stats.get(pairId) : null;
    if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (!pair) return 'direct';
    const local = candidates.get(pair.localCandidateId);
    const remote = candidates.get(pair.remoteCandidateId);
    return local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
  } catch {
    return 'direct';
  }
}

export function send(conn, type, payload) {
  if (conn?.open) conn.send({ type, payload, ts: Date.now() });
}
