import { h, clear, icon, ICONS, toast, initials } from './ui.js';
import * as api from './api.js';
import { session, end } from './session.js';
import { chatPanel } from './chat.js';
import { boardPanel } from './board.js';
import { filesPanel } from './files.js';
import { voice, startCall, hangup, toggleMute } from './voice.js';
import { screen, startShare, stopShare, setVideoEl } from './screen.js';

export function loginView({ googleClientId, devLogin, onDone }) {
  const card = h('div', { class: 'login-card' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }, '消'),
      h('div', { class: 'brand-text' },
        h('h1', {}, 'kieru'),
        h('div', { class: 'brand-sub' }, '消える · to vanish')
      )
    ),
    h('p', {}, 'A private room for two.')
  );

  if (googleClientId) {
    const target = h('div', { style: { display: 'flex', justifyContent: 'center' } });
    card.append(target);
    loadGoogle(googleClientId, target, onDone);
  }

  if (devLogin) {
    if (googleClientId) card.append(h('div', { class: 'divider' }, 'or'));
    const name = h('input', { class: 'field', placeholder: 'Enter a name', maxlength: 40 });
    const go = async () => {
      const v = name.value.trim();
      if (v.length < 2) return toast('Name must be at least 2 characters', 'err');
      try {
        const { token, user } = await api.post('/auth/dev', { name: v });
        api.setToken(token);
        onDone(user);
      } catch (e) { toast(e.message, 'err'); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    card.append(name, h('button', { class: 'btn', onClick: go }, 'Continue'));
  }

  if (!googleClientId && !devLogin) {
    card.append(h('p', { style: { color: 'var(--danger)' } }, 'No sign-in method configured. Set GOOGLE_CLIENT_ID on the server.'));
  }

  return h('div', { class: 'login' }, card, aboutBox());
}

function aboutBox() {
  const point = (title, body) =>
    h('div', { class: 'about-point' },
      h('div', { class: 'about-point-title' }, title),
      h('div', { class: 'about-point-body' }, body));

  const panel = h('div', { class: 'about-panel' },
    h('div', { class: 'about-inner' },
      point('Nothing is stored',
        'Messages, drawings and files are never written to any server. There is no history to read later, leak, or hand over.'),
      point('It goes straight to them',
        'Your data travels directly between the two browsers, never through us.'),
      point('What the server knows',
        'Your account, who your friends are, and whether you are online. Nothing you say or send.')
    )
  );

  const caret = h('span', { class: 'about-caret' }, '›');
  const btn = h('button', { class: 'about-toggle' }, caret, 'About kieru');

  btn.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    caret.classList.toggle('open', open);
    panel.style.maxHeight = open ? panel.scrollHeight + 'px' : '0px';
  });

  return h('div', { class: 'about-wrap' }, btn, panel);
}

function loadGoogle(clientId, target, onDone) {
  const busy = h('div', { class: 'gsi-busy' }, h('div', { class: 'spinner' }), 'Signing in…');

  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;

  s.onerror = () => {
    clear(target).append(h('div', { class: 'gsi-fail' }, 'Could not load Google sign-in. Check your connection and reload.'));
  };

  s.onload = () => {
    if (!window.google?.accounts?.id) return s.onerror();

    google.accounts.id.initialize({
      client_id: clientId,
      callback: async ({ credential }) => {
        // swap the button for a spinner, the round trip is otherwise silent and
        // the page looks frozen after you pick an account
        clear(target).append(busy);
        try {
          const { token, user } = await api.post('/auth/google', { credential });
          api.setToken(token);
          onDone(user);
        } catch (e) {
          clear(target);
          google.accounts.id.renderButton(target, GSI_BUTTON);
          toast(e.message || 'Sign-in failed', 'err');
        }
      },
    });

    google.accounts.id.renderButton(target, GSI_BUTTON);
  };

  document.head.append(s);
}

const GSI_BUTTON = {
  theme: 'filled_black',
  size: 'large',
  shape: 'pill',
  text: 'continue_with',
  width: 288,
};

// the friends list redraws every poll. keep the add-row alive across redraws or
// it steals focus and wipes whatever is half-typed in it.
let addRow = null;
let addInput = null;

function buildAddRow() {
  addInput = h('input', { class: 'field add-field', placeholder: 'Add someone by name or email' });

  const submit = async () => {
    const v = addInput.value.trim();
    if (!v) return;
    try {
      await api.post('/friends/request', { handle: v });
      addInput.value = '';
      toast('Request sent if that account exists');
    } catch (e) { toast(e.message, 'err'); }
  };

  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  addRow = h('div', { class: 'add-row' }, addInput, h('button', { class: 'btn add-btn', onClick: submit }, 'Add'));
}

export function friendsView({ friends, pending, onStart, onRefresh, onLogout, dialingId }) {
  const wrap = h('div', { class: 'friends' });

  if (!addRow) buildAddRow();
  wrap.append(addRow);

  if (pending.length) {
    const sec = h('div', { class: 'section' }, h('div', { class: 'label' }, `Requests (${pending.length})`));
    for (const p of pending) {
      const respond = async (accept) => {
        try {
          await api.post('/friends/respond', { friendship_id: p.friendship_id, accept });
          onRefresh();
        } catch (e) { toast(e.message, 'err'); }
      };
      sec.append(
        h('div', { class: 'row' },
          avatar(p),
          h('div', { class: 'row-main' }, h('div', { class: 'row-name' }, p.display_name)),
          h('button', { class: 'btn-icon', title: 'Accept', onClick: () => respond(true) }, icon(ICONS.check, 16, 'var(--success)')),
          h('button', { class: 'btn-icon', title: 'Decline', onClick: () => respond(false) }, icon(ICONS.x, 16, 'var(--danger)'))
        )
      );
    }
    wrap.append(sec);
  }

  const sec = h('div', { class: 'section' }, h('div', { class: 'label' }, `Friends (${friends.length})`));
  if (!friends.length) {
    sec.append(h('div', { class: 'empty' }, 'No friends yet. Add someone by their name or email.'));
  }
  for (const f of friends) {
    sec.append(
      h('div', { class: 'row' },
        avatar(f),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-name' }, f.display_name),
          h('div', { class: 'row-sub' },
            h('span', { class: 'dot' + (f.online ? ' on' : '') }),
            f.online ? 'Online' : 'Offline'
          )
        ),
        dialingId === f.user_id
          ? h('button', { class: 'btn', disabled: true }, h('span', { class: 'spinner' }), 'Calling…')
          : f.online
            ? h('button', { class: 'btn', disabled: dialingId != null, onClick: () => onStart(f) }, 'Start session')
            : h('span', { class: 'xfer-meta' }, 'offline')
      )
    );
  }
  wrap.append(sec);

  return h('div', { class: 'friends-wrap' }, wrap);
}

function screenPanel() {
  const video = h('video', { autoplay: true, playsinline: true, muted: true, class: 'screen-video' });
  setVideoEl(video);

  const sending = screen.state === 'sending';
  const bar = h('div', { class: 'screen-bar' },
    sending
      ? h('button', { class: 'btn-danger', onClick: stopShare }, icon(ICONS.x, 15), 'Stop sharing')
      : h('button', { class: 'btn-ghost', onClick: startShare }, icon(ICONS.screen, 15), 'Share my screen'),
    sending ? h('span', { class: 'xfer-meta' }, 'They can see your screen') : null
  );

  const empty = h('div', { class: 'screen-empty' },
    sending ? 'Sharing your screen.' : 'Nothing shared yet.');

  return h('div', { class: 'screen-wrap' },
    h('div', { class: 'screen-stage' }, screen.receiving ? video : empty),
    bar
  );
}

function avatar(u) {
  if (u.avatar_url) return h('img', { class: 'avatar', src: u.avatar_url, alt: '' });
  return h('div', { class: 'avatar' }, initials(u.display_name));
}

let activeTab = 'board';

export function workspaceView() {
  const TABS = [['board', 'Whiteboard'], ['files', 'Files'], ['screen', 'Screen']];
  const tabs = TABS.map(([t, label]) =>
    h('button', {
      class: 'tab' + (activeTab === t ? ' on' : ''),
      onClick: () => { activeTab = t; rerenderMain(); },
    }, label)
  );

  const mainSlot = h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' } });
  function rerenderMain() {
    // detach rather than clear: these panels cache their dom and clearing would
    // throw away the canvas and in-flight transfer rows
    mainSlot.replaceChildren(
      activeTab === 'board' ? boardPanel() : activeTab === 'files' ? filesPanel() : screenPanel()
    );
    for (const [i, [t]] of TABS.entries()) tabs[i].classList.toggle('on', t === activeTab);
  }
  rerenderMain();

  const main = h('div', { class: 'ws-main' },
    h('div', { class: 'tabs' }, ...tabs),
    mainSlot
  );

  if (session.reconnecting) {
    main.style.position = 'relative';
    main.append(
      h('div', { class: 'overlay' },
        h('div', { class: 'spinner' }),
        h('div', {}, 'Reconnecting…')
      )
    );
  }

  const side = chatPanel();
  side.style.width = sideWidth + 'px';

  return h('div', { class: 'ws' }, main, resizeGrip(side), side);
}

// drag the divider to resize the chat panel. width survives redraws.
let sideWidth = 320;

function resizeGrip(side) {
  const grip = h('div', { class: 'ws-grip' });

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    const startX = e.clientX;
    const startW = side.offsetWidth;

    const move = (ev) => {
      const w = Math.min(Math.max(startW - (ev.clientX - startX), 240), window.innerWidth - 320);
      sideWidth = w;
      side.style.width = w + 'px';
    };
    const up = () => {
      grip.classList.remove('dragging');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  return grip;
}

export function sessionBar() {
  const f = session.friend;
  const live = voice.state === 'live';
  const busy = voice.state === 'calling' || voice.state === 'connecting';

  const callBtn = live || busy
    ? h('button', { class: 'btn-danger', onClick: () => hangup(false) },
        icon(ICONS.phone, 15), voice.state === 'calling' ? 'Cancel' : live ? 'Hang up' : 'Connecting')
    : h('button', { class: 'btn-ghost', onClick: startCall }, icon(ICONS.phone, 15), 'Call');

  return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginLeft: 'auto' } },
    h('span', { class: 'xfer-meta', title: 'Connection type' },
      session.type === 'relay' ? 'relayed' : 'direct'),
    live ? h('button', {
      class: 'btn-icon' + (voice.muted ? ' on' : ''),
      title: voice.muted ? 'Unmute' : 'Mute',
      onClick: toggleMute,
    }, icon(voice.muted ? ICONS.micOff : ICONS.mic, 16)) : null,
    callBtn,
    h('button', { class: 'btn-ghost', onClick: () => end('You left the session.') }, icon(ICONS.leave, 15), 'Leave')
  );
}
