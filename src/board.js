import { h, icon, ICONS } from './ui.js';
import { send } from './peer.js';
import { session, on } from './session.js';

const COLORS = ['#ececee', '#6f9fd8', '#a78bdb', '#8fbf7f', '#d9a25f', '#d87f8b'];
const WIDTHS = [2, 4, 8];
const BATCH_MS = 45;

let strokes = [];      // {id, mine, color, width, points:[[x,y]]}
let canvas = null, ctx = null;
let color = COLORS[0], width = WIDTHS[0];
let drawing = null;    // stroke in progress (local)
let pending = [];      // points buffered for the next send
let flushTimer = null;

export function resetBoard() {
  strokes = [];
  drawing = null;
  pending = [];
  redraw();
}

function norm(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}

function redraw() {
  if (!ctx) return;
  const { width: w, height: hgt } = canvas;
  ctx.clearRect(0, 0, w, hgt);
  for (const s of strokes) drawStroke(s);
  if (drawing) drawStroke(drawing);
}

function drawStroke(s) {
  if (s.points.length < 2) {
    if (s.points.length === 1) {
      const [x, y] = s.points[0];
      ctx.beginPath();
      ctx.fillStyle = s.color;
      ctx.arc(x * canvas.width, y * canvas.height, (s.width * dpr()) / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  ctx.beginPath();
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width * dpr();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.moveTo(s.points[0][0] * canvas.width, s.points[0][1] * canvas.height);
  for (let i = 1; i < s.points.length; i++) {
    ctx.lineTo(s.points[i][0] * canvas.width, s.points[i][1] * canvas.height);
  }
  ctx.stroke();
}

const dpr = () => window.devicePixelRatio || 1;

function fit() {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width * dpr();
  canvas.height = r.height * dpr();
  redraw();
}

function flush() {
  flushTimer = null;
  if (!drawing || !pending.length) return;
  send(session.conn, 'wb-stroke', {
    strokeId: drawing.id,
    color: drawing.color,
    width: drawing.width,
    points: pending,
  });
  pending = [];
}

function queue(pt) {
  pending.push(pt);
  if (!flushTimer) flushTimer = setTimeout(flush, BATCH_MS);
}

on('wb-stroke', (p) => {
  if (!p?.strokeId || !Array.isArray(p.points)) return;
  let s = strokes.find((x) => x.id === p.strokeId);
  if (!s) {
    s = { id: p.strokeId, mine: false, color: p.color || '#ececee', width: p.width || 2, points: [] };
    strokes.push(s);
  }
  s.points.push(...p.points);
  redraw();
});

on('wb-clear', () => { strokes = []; redraw(); });

on('wb-undo', (p) => {
  if (!p?.strokeId) return;
  strokes = strokes.filter((s) => s.id !== p.strokeId);
  redraw();
});

export function boardPanel() {
  canvas = h('canvas');
  ctx = null;

  const wrap = h('div', { class: 'board-wrap' }, canvas);

  requestAnimationFrame(() => {
    ctx = canvas.getContext('2d');
    fit();
  });
  window.addEventListener('resize', fit);

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const pt = norm(e);
    drawing = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, mine: true, color, width, points: [pt] };
    pending = [pt];
    redraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const pt = norm(e);
    drawing.points.push(pt);
    queue(pt);
    redraw();
  });

  const finish = () => {
    if (!drawing) return;
    flush();
    strokes.push(drawing);
    drawing = null;
    redraw();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  const swatches = COLORS.map((c) =>
    h('button', {
      class: 'swatch' + (c === color ? ' on' : ''),
      style: { background: c },
      title: c,
      onClick: (e) => {
        color = c;
        wrap.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
        e.currentTarget.classList.add('on');
      },
    })
  );

  const widthBtns = WIDTHS.map((w) =>
    h('button', {
      class: 'btn-icon' + (w === width ? ' on' : ''),
      title: `${w}px`,
      onClick: (e) => {
        width = w;
        wrap.querySelectorAll('[data-w]').forEach((b) => b.classList.remove('on'));
        e.currentTarget.classList.add('on');
      },
      'data-w': w,
    }, h('span', { style: {
      width: w + 2 + 'px', height: w + 2 + 'px', borderRadius: '50%', background: 'currentColor', display: 'block',
    } }))
  );

  function undoMine() {
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (strokes[i].mine) {
        const [s] = strokes.splice(i, 1);
        send(session.conn, 'wb-undo', { strokeId: s.id });
        redraw();
        return;
      }
    }
  }

  function clearAll() {
    strokes = [];
    redraw();
    send(session.conn, 'wb-clear', {});
  }

  wrap.append(
    h('div', { class: 'board-tools' },
      ...swatches,
      h('span', { class: 'tool-div' }),
      ...widthBtns,
      h('span', { class: 'tool-div' }),
      h('button', { class: 'btn-icon', title: 'Undo my last stroke', onClick: undoMine }, icon(ICONS.undo)),
      h('button', { class: 'btn-icon', title: 'Clear board', onClick: clearAll }, icon(ICONS.trash))
    )
  );

  return wrap;
}
