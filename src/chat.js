import { h, clear, fmtTime } from './ui.js';
import { send } from './peer.js';
import { session, on } from './session.js';

const MAX_LEN = 4000;
let log = [];
let logEl = null;

export function resetChat() {
  log = [];
  if (logEl) clear(logEl);
}

export function sysMessage(text) {
  log.push({ sys: true, text });
  render();
}

function push(msg) {
  log.push(msg);
  render();
}

function render() {
  if (!logEl) return;
  clear(logEl);
  for (const m of log) {
    if (m.sys) {
      logEl.append(h('div', { class: 'msg-sys' }, m.text));
      continue;
    }
    logEl.append(
      h('div', { class: 'msg' + (m.mine ? ' mine' : '') },
        h('div', { class: 'msg-bubble' }, m.text),
        h('div', { class: 'msg-time' }, fmtTime(m.ts))
      )
    );
  }
  logEl.scrollTop = logEl.scrollHeight;
}

on('chat', (payload, ts) => {
  const text = String(payload?.text ?? '').slice(0, MAX_LEN);
  if (!text) return;
  push({ text, mine: false, ts: ts || Date.now() });
});

export function chatPanel() {
  logEl = h('div', { class: 'chat-log' });

  const input = h('textarea', {
    placeholder: 'Message',
    rows: 1,
    maxlength: MAX_LEN,
    onInput: (e) => {
      e.target.style.height = '36px';
      e.target.style.height = Math.min(e.target.scrollHeight, 110) + 'px';
    },
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    },
  });

  function submit() {
    const text = input.value.trim().slice(0, MAX_LEN);
    if (!text || !session.conn?.open) return;
    send(session.conn, 'chat', { text });
    push({ text, mine: true, ts: Date.now() });
    input.value = '';
    input.style.height = '36px';
  }

  render();

  return h('div', { class: 'ws-side' },
    logEl,
    h('div', { class: 'composer' },
      input,
      h('button', { class: 'btn', onClick: submit }, 'Send')
    )
  );
}
