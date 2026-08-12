import './style.css';
import * as api from './api.js';
import { h, clear, icon, ICONS, toast, modal } from './ui.js';
import { initPeer, getPeer, send, destroyPeer } from './peer.js';
import { session, start, end, on, onChange, changed, dial } from './session.js';
import { loginView, friendsView, workspaceView, sessionBar } from './views.js';
import { resetChat, sysMessage } from './chat.js';
import { resetBoard } from './board.js';
import { resetFiles } from './files.js';
import { incoming as incomingCall, hangup } from './voice.js';
import { incomingShare, resetScreen } from './screen.js';

const app = document.getElementById('app');

const state = {
  user: null,
  peerId: null,
  friends: [],
  pending: [],
  config: { googleClientId: null, devLogin: false },
  dialing: false,
};

let pollTimer = null;
let heartbeatTimer = null;

async function boot() {
  try {
    state.config = await api.get('/config');
  } catch {
    render(h('div', { class: 'login' },
      h('div', { class: 'login-card' },
        h('h1', {}, 'Server unreachable'),
        h('p', {}, 'Could not reach the API. Start it with npm run dev:api and reload.'))));
    return;
  }

  if (api.getToken()) {
    try {
      state.user = await api.get('/me');
    } catch {
      api.setToken(null);
    }
  }
  state.user ? enterApp() : renderLogin();
}

function renderLogin() {
  render(loginView({
    googleClientId: state.config.googleClientId,
    devLogin: state.config.devLogin,
    onDone: (user) => { state.user = user; enterApp(); },
  }));
}

async function enterApp() {
  renderShell(h('div', { class: 'friends-wrap' },
    h('div', { class: 'connecting' }, h('div', { class: 'spinner' }), 'Connecting…')));

  try {
    state.peerId = await initPeer();
  } catch (e) {
    console.error('peer init failed', e);
    renderShell(h('div', { class: 'friends-wrap' },
      h('div', { class: 'friends' },
        h('div', { class: 'empty' },
          h('div', { style: { marginBottom: '10px' } }, 'Could not reach the signaling server.'),
          h('button', { class: 'btn', onClick: () => location.reload() }, 'Try again')))));
    return;
  }

  getPeer().on('connection', onIncomingConn);
  getPeer().on('call', (call) => {
    // session.friend.peer_id goes stale on every poll, so check the live connection
    if (!session.active || call.peer !== session.conn?.peer) { call.close(); return; }
    if (call.metadata?.kind === 'screen') incomingShare(call);
    else incomingCall(call);
  });

  await beat();
  heartbeatTimer = setInterval(beat, 20000);
  await refresh();
  pollTimer = setInterval(refresh, 10000);
  draw();
}

async function beat() {
  try { await api.post('/heartbeat', { peer_id: state.peerId }); } catch {}
}

async function refresh() {
  try {
    const [friends, pending] = await Promise.all([api.get('/friends'), api.get('/friends/pending')]);
    state.friends = friends;
    state.pending = pending;
    if (!session.active) draw();
  } catch {}
}

function onIncomingConn(conn) {
  if (conn.label?.startsWith('xfer:')) return;

  if (session.active) {
    conn.on('open', () => { send(conn, 'session-decline'); setTimeout(() => conn.close(), 300); });
    return;
  }

  const friend = state.friends.find((f) => f.peer_id === conn.peer);
  if (!friend) { conn.on('open', () => conn.close()); return; }

  conn.on('open', () => {
    modal({
      title: 'Session request',
      body: `${friend.display_name} wants to start a session.`,
      actions: [
        { label: 'Decline', onClick: () => { send(conn, 'session-decline'); setTimeout(() => conn.close(), 300); } },
        { label: 'Accept', kind: 'primary', onClick: () => {
          send(conn, 'session-accept');
          beginSession(conn, friend);
        } },
      ],
    });
  });
}

async function startSession(friend) {
  if (state.dialing) return;
  state.dialing = true;
  toast(`Calling ${friend.display_name}…`);

  let conn;
  try {
    conn = await dial(friend.peer_id);
  } catch {
    state.dialing = false;
    toast(`${friend.display_name} is unavailable`, 'err');
    return;
  }

  const decided = new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 45000);
    conn.on('data', (raw) => {
      if (raw?.type === 'session-accept') { clearTimeout(t); resolve('accept'); }
      if (raw?.type === 'session-decline') { clearTimeout(t); resolve('decline'); }
    });
    conn.on('close', () => { clearTimeout(t); resolve('closed'); });
  });

  const result = await decided;
  state.dialing = false;

  if (result === 'accept') { beginSession(conn, friend); return; }
  try { conn.close(); } catch {}
  toast(result === 'decline' ? `${friend.display_name} declined` : 'No answer', 'err');
}

function beginSession(conn, friend) {
  resetChat();
  resetBoard();
  resetFiles();
  start(conn, friend);
  sysMessage(`Session started with ${friend.display_name}. Nothing here is saved.`);
}

on('ended', (reason) => {
  hangup(true);
  resetChat();
  resetBoard();
  resetFiles();
  if (reason) toast(reason);
  refresh();
});

on('session-decline', () => {
  const name = session.friend?.display_name || 'Your friend';
  end(`${name} ended the session.`);
});

onChange(() => draw());

async function logout() {
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  if (session.active) end();
  try { await api.post('/presence/clear', { token: api.getToken() }); } catch {}
  destroyPeer();
  api.setToken(null);
  location.reload();
}

function draw() {
  if (!state.user) { renderLogin(); return; }
  if (session.active) {
    renderShell(workspaceView(), sessionBar());
    return;
  }
  renderShell(friendsView({
    friends: state.friends,
    pending: state.pending,
    onStart: startSession,
    onRefresh: refresh,
    onLogout: logout,
  }));
}

function renderShell(content, right) {
  const bar = h('div', { class: 'topbar' },
    h('div', { class: 'logo' }, '消'),
    session.active
      ? h('div', { class: 'bar-title' },
          h('span', {}, session.friend.display_name),
          h('span', { class: 'row-sub' },
            h('span', { class: 'dot' + (session.reconnecting ? ' busy' : ' on') }),
            session.reconnecting ? 'Reconnecting' : 'Live'))
      : h('div', { class: 'bar-title' }, h('span', {}, 'kieru')),
    right || (state.user
      ? h('div', { class: 'bar-right' },
          h('span', { class: 'bar-user' }, state.user.display_name),
          h('button', { class: 'btn-ghost btn-sm', onClick: logout }, 'Sign out'))
      : null)
  );
  render(h('div', { class: 'shell' }, bar, h('div', { class: 'body-row' }, content)));
}

function render(node) {
  clear(app).append(node);
}

// beforeunload doesn't fire on mobile. both can run, the endpoint is idempotent.
function goingAway() {
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  if (session.active) end();
  api.clearPresenceBeacon();
}
window.addEventListener('pagehide', goingAway);
window.addEventListener('beforeunload', goingAway);

document.addEventListener('visibilitychange', () => {
  if (!state.user) return;
  if (document.hidden) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (!session.active) api.clearPresenceBeacon();
  } else if (!heartbeatTimer) {
    beat();
    heartbeatTimer = setInterval(beat, 20000);
    refresh();
  }
});

boot();
