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
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: clientId,
      callback: async ({ credential }) => {
        try {
          const { token, user } = await api.post('/auth/google', { credential });
          api.setToken(token);
          onDone(user);
        } catch (e) { toast(e.message, 'err'); }
      },
    });
    google.accounts.id.renderButton(target, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with' });
  };
  document.head.append(s);
}

export function friendsView({ friends, pending, onStart, onRefresh, onLogout }) {
  const wrap = h('div', { class: 'friends' });

  const input = h('input', { class: 'field', placeholder: 'Friend name or email' });
  const add = async () => {
    const v = input.value.trim();
    if (!v) return;
    try {
      await api.post('/friends/request', { handle: v });
      input.value = '';
      toast('Request sent if that account exists');
      onRefresh();
    } catch (e) { toast(e.message, 'err'); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  input.className = 'field add-field';
  input.placeholder = 'Add someone by name or email';
  wrap.append(
    h('div', { class: 'add-row' }, input, h('button', { class: 'btn add-btn', onClick: add }, 'Add'))
  );

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
        f.online
          ? h('button', { class: 'btn', onClick: () => onStart(f) }, 'Start session')
          : h('span', { class: 'xfer-meta' }, 'unavailable')
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
    clear(mainSlot);
    mainSlot.append(activeTab === 'board' ? boardPanel() : activeTab === 'files' ? filesPanel() : screenPanel());
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

  return h('div', { class: 'ws' }, main, chatPanel());
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
