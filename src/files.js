import streamSaver from 'streamsaver';
import { h, clear, icon, ICONS, fmtBytes, toast, modal } from './ui.js';
import { send } from './peer.js';
import { session, on, dial } from './session.js';
import { getPeer } from './peer.js';

const CHUNK = 16 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const RELAY_CAP = 200 * 1024 * 1024;

const xfers = new Map();
let listEl = null;

export function resetFiles() {
  for (const x of xfers.values()) x.abort?.();
  xfers.clear();
  if (listEl) clear(listEl);
}

function upsert(id, patch) {
  const cur = xfers.get(id) || {};
  xfers.set(id, { ...cur, ...patch });
  renderList();
}

function renderList() {
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

// each transfer gets its own connection so chunks don't interleave with chat traffic
function transferLabel(fileId) { return `xfer:${fileId}`; }

export function sendFile(file) {
  if (!session.conn?.open) return;
  if (session.type === 'relay' && file.size > RELAY_CAP) {
    toast(`Relayed connection: files capped at ${fmtBytes(RELAY_CAP)}`, 'err');
    return;
  }
  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  upsert(fileId, { name: file.name, size: file.size, done: 0, dir: 'out', status: 'offered', file });
  send(session.conn, 'file-offer', { fileId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' });
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
  if (!conn) { upsert(p.fileId, { status: 'failed' }); toast('Could not open transfer channel', 'err'); return; }
  pump(conn, p.fileId, x.file).catch((e) => {
    console.error(e);
    upsert(p.fileId, { status: 'failed' });
  });
});

on('file-decline', (p) => {
  if (!p?.fileId) return;
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

// don't outrun the channel or the tab dies
function drain(dc) {
  if (!dc || dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    dc.bufferedAmountLowThreshold = LOW_WATER;
    const go = () => { dc.removeEventListener('bufferedamountlow', go); resolve(); };
    dc.addEventListener('bufferedamountlow', go);
  });
}

export function filesPanel() {
  listEl = h('div', {});

  const drop = h('div', { class: 'drop' }, 'Drop a file here, or click to pick');
  const picker = h('input', { type: 'file', style: { display: 'none' },
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

  return h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0' } },
    drop,
    picker,
    session.type === 'relay'
      ? h('div', { class: 'xfer-meta', style: { padding: '0 12px 8px' } },
          `Relayed connection — files capped at ${fmtBytes(RELAY_CAP)}`)
      : null,
    h('div', { style: { flex: '1', overflowY: 'auto' } }, listEl)
  );
}
