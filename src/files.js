import streamSaver from 'streamsaver';
import { h, clear, icon, ICONS, fmtBytes, toast, modal } from './ui.js';
import { send } from './peer.js';
import { session, on, dial, changed } from './session.js';
import { getPeer } from './peer.js';
import * as api from './api.js';

const CHUNK = 16 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;

// relayed bytes come out of a metered TURN quota, so they get a daily allowance
// spent across however many files you like. direct stays uncapped.
export const fileQuota = { used: 0, budget: 10 * 1024 * 1024, left: 10 * 1024 * 1024, known: false };

function applyQuota({ used, budget }) {
  fileQuota.used = used;
  fileQuota.budget = budget;
  fileQuota.left = Math.max(0, budget - used);
  fileQuota.known = true;
  changed();
}

export async function loadFileQuota() {
  try { applyQuota(await api.get('/files/quota')); } catch {}
}

async function refund(bytes) {
  try {
    await api.post('/files/refund', { bytes });
    applyQuota({ used: Math.max(0, fileQuota.used - bytes), budget: fileQuota.budget });
  } catch {}
}

const xfers = new Map();
let listEl = null;
const quotaEl = h('div', { class: 'relay-warn', style: { display: 'none' } });

export function resetFiles() {
  for (const x of xfers.values()) {
    x.abort?.();
    if (x.held && x.status !== 'done') refund(x.held);
  }
  xfers.clear();
  if (listEl) clear(listEl);
  filesEl = null;
  listEl = null;
}

function upsert(id, patch) {
  const cur = xfers.get(id) || {};
  xfers.set(id, { ...cur, ...patch });
  renderList();
}

function renderList() {
  paintQuota();
  if (!listEl) return;
  clear(listEl);
  for (const [id, x] of [...xfers].reverse()) {
    const pct = x.size ? Math.min(100, Math.round((x.done / x.size) * 100)) : 0;
    const bar = h('div', { class: 'bar' }, h('i', { style: { width: pct + '%' } }));
    listEl.append(
      h('div', { class: 'xfer' },
        h('div', { class: 'xfer-top' },
          icon(ICONS.file, 14, 'var(--files)'),
          h('span', { class: 'xfer-name' }, x.name),
          h('span', { class: 'xfer-meta' }, x.status === 'done' ? fmtBytes(x.size) : `${pct}%`)
        ),
        x.status === 'active' ? bar : null,
        h('div', { class: 'xfer-meta' },
          x.dir === 'out' ? 'Sending' : 'Receiving',
          ' · ',
          x.status === 'done' ? 'complete' : x.status === 'failed' ? 'failed' : fmtBytes(x.size)
        )
      )
    );
  }
}

function transferLabel(fileId) { return `xfer:${fileId}`; }

export async function sendFile(file) {
  if (!session.conn?.open) return;

  const relayed = session.type === 'relay';
  if (relayed) {
    if (file.size > fileQuota.budget) {
      toast(`This connection is relayed through a TURN server, so you get ${fmtBytes(fileQuota.budget)} of transfers a day. "${file.name}" is ${fmtBytes(file.size)} on its own.`, 'err');
      return;
    }
    let claim;
    try {
      claim = await api.post('/files/reserve', { bytes: file.size });
    } catch {
      toast('Could not reach the server to check your transfer allowance', 'err');
      return;
    }
    applyQuota(claim);
    if (!claim.ok) {
      toast(`That would go over today's ${fmtBytes(fileQuota.budget)} relay allowance. ${fmtBytes(fileQuota.left)} left, "${file.name}" is ${fmtBytes(file.size)}. It resets tomorrow.`, 'err');
      return;
    }
    // the session can drop while the reserve is in flight
    if (!session.conn?.open) { refund(file.size); return; }
  }

  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  upsert(fileId, { name: file.name, size: file.size, done: 0, dir: 'out', status: 'offered', file, held: relayed ? file.size : 0 });
  send(session.conn, 'file-offer', { fileId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' });
}

// give the allowance back when a send never happened
function release(fileId) {
  const x = xfers.get(fileId);
  if (!x?.held) return;
  refund(x.held);
  x.held = 0;
}

on('file-offer', (p) => {
  if (!p?.fileId || !p.name) return;
  const { fileId, name, size } = p;
  upsert(fileId, { name, size, done: 0, dir: 'in', status: 'offered' });
  modal({
    title: 'Incoming file',
    body: `${session.friend?.display_name || 'Your friend'} wants to send "${name}" (${fmtBytes(size)}).`,
    actions: [
      { label: 'Decline', onClick: () => { send(session.conn, 'file-decline', { fileId }); xfers.delete(fileId); renderList(); } },
      { label: 'Accept', kind: 'primary', onClick: () => acceptFile(fileId, name, size) },
    ],
  });
});

function acceptFile(fileId, name, size) {
  upsert(fileId, { status: 'active' });
  const peer = getPeer();
  const onConn = (conn) => {
    if (conn.label !== transferLabel(fileId)) return;
    peer.off('connection', onConn);
    receiveInto(conn, fileId, name, size);
  };
  peer.on('connection', onConn);
  send(session.conn, 'file-accept', { fileId });
}

function receiveInto(conn, fileId, name, size) {
  const stream = streamSaver.createWriteStream(name, { size });
  const writer = stream.getWriter();
  let received = 0;

  const x = xfers.get(fileId) || {};
  x.abort = () => { try { writer.abort(); } catch {} try { conn.close(); } catch {} };
  xfers.set(fileId, x);

  conn.on('data', async (chunk) => {
    if (chunk?.done) {
      await writer.close().catch(() => {});
      upsert(fileId, { status: 'done', done: size });
      toast(`Received ${name}`);
      try { conn.close(); } catch {}
      return;
    }
    const buf = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer || chunk);
    received += buf.byteLength;
    await writer.write(buf).catch(() => {});
    upsert(fileId, { done: received, status: 'active' });
  });

  conn.on('close', () => {
    const cur = xfers.get(fileId);
    if (cur && cur.status !== 'done') {
      writer.abort().catch(() => {});
      upsert(fileId, { status: 'failed' });
      toast(`Transfer of ${name} failed`, 'err');
    }
  });
}

on('file-accept', async (p) => {
  const x = xfers.get(p?.fileId);
  if (!x?.file) return;
  upsert(p.fileId, { status: 'active' });
  const conn = await dialTransfer(p.fileId).catch(() => null);
  if (!conn) {
    release(p.fileId);
    upsert(p.fileId, { status: 'failed' });
    toast('Could not open transfer channel', 'err');
    return;
  }
  pump(conn, p.fileId, x.file).catch((e) => {
    console.error(e);
    release(p.fileId);
    upsert(p.fileId, { status: 'failed' });
  });
});

on('file-decline', (p) => {
  if (!p?.fileId) return;
  release(p.fileId);
  xfers.delete(p.fileId);
  renderList();
  toast('File declined');
});

function dialTransfer(fileId) {
  return new Promise((resolve, reject) => {
    const target = session.conn?.peer;
    if (!target) return reject(new Error('no session'));
    const conn = getPeer().connect(target, {
      reliable: true,
      label: transferLabel(fileId),
    });
    const t = setTimeout(() => reject(new Error('timeout')), 12000);
    conn.on('open', () => { clearTimeout(t); resolve(conn); });
    conn.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function pump(conn, fileId, file) {
  const dc = conn.dataChannel;
  let offset = 0;

  const x = xfers.get(fileId);
  let aborted = false;
  x.abort = () => { aborted = true; try { conn.close(); } catch {} };

  while (offset < file.size) {
    if (aborted || !conn.open) throw new Error('aborted');
    await drain(dc);
    const slice = file.slice(offset, offset + CHUNK);
    const buf = await slice.arrayBuffer();
    conn.send(buf);
    offset += buf.byteLength;
    upsert(fileId, { done: offset, status: 'active' });
  }
  conn.send({ done: true });
  upsert(fileId, { status: 'done', done: file.size });
  toast(`Sent ${file.name}`);
  setTimeout(() => { try { conn.close(); } catch {} }, 1500);
}

function drain(dc) {
  if (!dc || dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    dc.bufferedAmountLowThreshold = LOW_WATER;
    const go = () => { dc.removeEventListener('bufferedamountlow', go); resolve(); };
    dc.addEventListener('bufferedamountlow', go);
  });
}

let filesEl = null;

function paintQuota() {
  if (session.type !== 'relay') {
    quotaEl.style.display = 'none';
    return;
  }
  quotaEl.style.display = '';
  quotaEl.textContent = fileQuota.known
    ? (fileQuota.left <= 0
        ? "You have used today's file transfer allowance. It resets tomorrow."
        : `Relayed connection, ${fmtBytes(fileQuota.left)} of ${fmtBytes(fileQuota.budget)} left to send today`)
    : 'Relayed connection, transfers are limited per day';
}

export function filesPanel() {
  if (filesEl) return filesEl;
  listEl = h('div', {});

  const drop = h('div', { class: 'drop' },
    icon(ICONS.upload, 22, 'var(--files)'),
    h('div', { class: 'drop-main' }, 'Choose a file'),
    h('div', { class: 'drop-sub' }, 'or drag and drop it here'),
    h('button', { class: 'btn drop-btn' }, 'Browse files')
  );
  const picker = h('input', { type: 'file', multiple: true, style: { display: 'none' },
    onChange: (e) => { for (const f of e.target.files) sendFile(f); e.target.value = ''; } });

  drop.addEventListener('click', () => picker.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    for (const f of e.dataTransfer.files) sendFile(f);
  });

  renderList();

  if (session.type === 'relay' && !fileQuota.known) loadFileQuota();
  paintQuota();

  filesEl = h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' } },
    drop,
    picker,
    quotaEl,
    h('div', { style: { flex: '1', overflowY: 'auto' } }, listEl)
  );
  return filesEl;
}
