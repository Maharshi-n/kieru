import { getPeer, send, connectionType, PING_MS, MISSED_PONG_LIMIT } from './peer.js';
import * as api from './api.js';

export const session = {
  active: false,
  conn: null,
  friend: null,        // {user_id, display_name, peer_id, avatar_url}
  type: 'direct',      // direct | relay
  reconnecting: false,
  handlers: {},        // type -> fn(payload, ts)
};

let pingTimer = null;
let missed = 0;
let reconnectAbort = false;

export function on(type, fn) { session.handlers[type] = fn; }

function emit(type, payload, ts) {
  session.handlers[type]?.(payload, ts);
}

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function changed() { listeners.forEach((f) => f()); }

export function start(conn, friend) {
  session.active = true;
  session.conn = conn;
  session.friend = friend;
  session.reconnecting = false;
  missed = 0;
  wire(conn);
  refreshType();
  startPing();
  changed();
}

function refreshType() {
  setTimeout(async () => {
    if (!session.conn) return;
    session.type = await connectionType(session.conn);
    changed();
  }, 1200);
}

function wire(conn) {
  conn.on('data', (raw) => {
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      emit('binary', raw);
      return;
    }
    const { type, payload, ts } = raw || {};
    if (type === 'ping') { send(conn, 'pong'); return; }
    if (type === 'pong') { missed = 0; return; }
    emit(type, payload, ts);
  });

  conn.on('close', () => { if (session.active) tryReconnect(); });
  conn.on('error', (e) => { console.error('conn error', e); if (session.active) tryReconnect(); });
}

function startPing() {
  clearInterval(pingTimer);
  missed = 0;
  pingTimer = setInterval(() => {
    if (!session.conn?.open) return;
    missed += 1;
    if (missed > MISSED_PONG_LIMIT) { tryReconnect(); return; }
    send(session.conn, 'ping');
  }, PING_MS);
}

async function tryReconnect() {
  if (!session.active || session.reconnecting) return;
  session.reconnecting = true;
  reconnectAbort = false;
  clearInterval(pingTimer);
  try { session.conn?.close(); } catch {}
  session.conn = null;
  changed();

  const delays = [1000, 2000, 4000, 8000, 15000];
  for (const wait of delays) {
    await sleep(wait);
    if (reconnectAbort || !session.active || !session.friend) return;

    let peerId = session.friend.peer_id;
    try {
      const friends = await api.get('/friends');
      if (reconnectAbort || !session.active || !session.friend) return;
      const f = friends.find((x) => x.user_id === session.friend.user_id);
      if (f?.online && f.peer_id) {
        peerId = f.peer_id;
        session.friend.peer_id = peerId;
      } else {
        continue; // they're offline, keep waiting out the backoff
      }
    } catch {
      continue;
    }

    const conn = await dial(peerId).catch(() => null);
    if (conn && (reconnectAbort || !session.active)) { try { conn.close(); } catch {} return; }
    if (conn) {
      session.conn = conn;
      session.reconnecting = false;
      missed = 0;
      wire(conn);
      refreshType();
      startPing();
      send(conn, 'session-accept');
      changed();
      return;
    }
  }
  end('Could not reconnect. Session ended.');
}

function dial(peerId, timeout = 12000) {
  return new Promise((resolve, reject) => {
    console.log('[session] dialing', peerId);
    const conn = getPeer().connect(peerId, { reliable: true });

    const pc = () => conn.peerConnection;
    const probe = setInterval(() => {
      if (pc()) console.log('[session] ice:', pc().iceConnectionState, '| gathering:', pc().iceGatheringState);
    }, 2000);

    const stop = () => { clearTimeout(timer); clearInterval(probe); };
    const timer = setTimeout(() => {
      console.error('[session] dial timed out. ice was:', pc()?.iceConnectionState,
        '- if this is "checking" or "failed", you need TURN');
      stop();
      try { conn.close(); } catch {}
      reject(new Error('timeout'));
    }, timeout);

    conn.on('open', () => { stop(); console.log('[session] connected'); resolve(conn); });
    conn.on('error', (e) => { stop(); console.error('[session] dial error', e?.type, e); reject(e); });
  });
}

export { dial };

export function end(reason) {
  reconnectAbort = true;
  clearInterval(pingTimer);
  if (session.conn) { try { session.conn.close(); } catch {} }
  session.active = false;
  session.conn = null;
  session.friend = null;
  session.reconnecting = false;
  session.type = 'direct';
  emit('ended', reason);
  changed();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
