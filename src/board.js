import { h, icon, ICONS } from './ui.js';
import { send } from './peer.js';
import { session, on } from './session.js';

const COLORS = ['#ececee', '#6f9fd8', '#a78bdb', '#8fbf7f', '#d9a25f', '#d87f8b'];
const WIDTHS = [2, 4, 8];
const BATCH_MS = 45;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;

// world coordinates, not screen. the canvas is an infinite plane and pan/zoom
// only change how we look at it, so both sides stay in sync at any zoom.
let items = [];
let canvas = null, ctx = null;
let color = COLORS[0], width = WIDTHS[0];
let tool = 'pen';
let view = { x: 0, y: 0, zoom: 1 };

let drawing = null;
let pending = [];
let flushTimer = null;
let panning = null;
let textInput = null;

export function resetBoard() {
  items = [];
  drawing = null;
  pending = [];
  view = { x: 0, y: 0, zoom: 1 };
  boardEl = null;
  canvas = null;
  ctx = null;
}

const dpr = () => window.devicePixelRatio || 1;

function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left - view.x) / view.zoom,
    y: (e.clientY - r.top - view.y) / view.zoom,
  };
}

function fit() {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;   // detached or hidden, nothing to size to
  canvas.width = r.width * dpr();
  canvas.height = r.height * dpr();
  if (!ctx) ctx = canvas.getContext('2d');
  redraw();
}

function redraw() {
  if (!ctx || !canvas) return;
  const d = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(view.zoom * d, 0, 0, view.zoom * d, view.x * d, view.y * d);

  grid();
  for (const it of items) paint(it);
  if (drawing) paint(drawing);
}

// dots stay put in world space so panning feels like moving over a surface
function grid() {
  const step = 40;
  const r = canvas.getBoundingClientRect();
  const x0 = Math.floor(-view.x / view.zoom / step) * step;
  const y0 = Math.floor(-view.y / view.zoom / step) * step;
  const x1 = x0 + r.width / view.zoom + step;
  const y1 = y0 + r.height / view.zoom + step;

  ctx.fillStyle = '#2b2b30';
  const dot = 1.1 / view.zoom;
  for (let x = x0; x < x1; x += step) {
    for (let y = y0; y < y1; y += step) {
      ctx.beginPath();
      ctx.arc(x, y, dot, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function paint(it) {
  ctx.strokeStyle = it.color;
  ctx.fillStyle = it.color;
  ctx.lineWidth = it.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (it.kind === 'text') {
    ctx.font = `${it.size || 16}px 'Instrument Sans', sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(it.text, it.x, it.y);
    return;
  }

  const p = it.points;
  if (!p || !p.length) return;

  if (it.kind === 'pen') {
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0], p[0][1], it.width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.stroke();
    return;
  }

  const [ax, ay] = p[0];
  const [bx, by] = p[p.length - 1];

  ctx.beginPath();
  if (it.kind === 'line') {
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  } else if (it.kind === 'rect') {
    ctx.rect(ax, ay, bx - ax, by - ay);
  } else if (it.kind === 'circle') {
    ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
  } else if (it.kind === 'triangle') {
    ctx.moveTo((ax + bx) / 2, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(ax, by);
    ctx.closePath();
  } else if (it.kind === 'arrow') {
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    const a = Math.atan2(by - ay, bx - ax);
    const head = Math.max(10, it.width * 4);
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - head * Math.cos(a - Math.PI / 6), by - head * Math.sin(a - Math.PI / 6));
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - head * Math.cos(a + Math.PI / 6), by - head * Math.sin(a + Math.PI / 6));
  }
  ctx.stroke();
}

function flush() {
  flushTimer = null;
  if (!drawing || !pending.length) return;
  send(session.conn, 'wb-stroke', {
    strokeId: drawing.id,
    kind: drawing.kind,
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
  let it = items.find((x) => x.id === p.strokeId);
  if (!it) {
    it = {
      id: p.strokeId,
      kind: p.kind || 'pen',
      mine: false,
      color: p.color || '#ececee',
      width: p.width || 2,
      points: [],
    };
    items.push(it);
  }
  // shapes send their final two points each time, pen appends
  if (it.kind === 'pen') it.points.push(...p.points);
  else it.points = p.points;
  redraw();
});

on('wb-text', (p) => {
  if (!p?.strokeId || typeof p.text !== 'string') return;
  if (items.some((x) => x.id === p.strokeId)) return;
  items.push({
    id: p.strokeId, kind: 'text', mine: false,
    color: p.color || '#ececee', text: p.text.slice(0, 200),
    x: p.x, y: p.y, size: p.size || 16,
  });
  redraw();
});

on('wb-clear', () => { items = []; redraw(); });

on('wb-undo', (p) => {
  if (!p?.strokeId) return;
  items = items.filter((x) => x.id !== p.strokeId);
  redraw();
});

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function commitText(world) {
  if (textInput) return;
  const r = canvas.getBoundingClientRect();
  textInput = h('input', {
    class: 'board-text',
    placeholder: 'Type, then Enter',
    style: {
      left: r.left + world.x * view.zoom + view.x + 'px',
      top: r.top + world.y * view.zoom + view.y + 'px',
      color,
      fontSize: Math.max(11, 16 * view.zoom) + 'px',
    },
  });

  // removing the input fires blur, which would re-enter done() and throw on the
  // null textInput before the send ever happened
  let finished = false;
  const done = (save) => {
    if (finished) return;
    finished = true;
    const el = textInput;
    const text = el.value.trim().slice(0, 200);
    textInput = null;
    el.remove();
    if (!save || !text) return;
    const it = { id: newId(), kind: 'text', mine: true, color, text, x: world.x, y: world.y, size: 16 };
    items.push(it);
    send(session.conn, 'wb-text', {
      strokeId: it.id, text, color, x: world.x, y: world.y, size: 16,
    });
    redraw();
  };

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  textInput.addEventListener('blur', () => done(true));
  document.body.append(textInput);
  setTimeout(() => textInput?.focus(), 0);
}

// built once. workspaceView() re-runs on every state change (voice, reconnect, ...)
// and rebuilding the canvas each time wiped whatever was drawn on it.
let boardEl = null;
let resizeBound = false;

export function boardPanel() {
  if (boardEl) {
    // canvas size is 0 while detached, so re-measure once it's back in the dom
    requestAnimationFrame(fit);
    return boardEl;
  }

  canvas = h('canvas');
  ctx = null;

  const wrap = h('div', { class: 'board-wrap' }, canvas);
  boardEl = wrap;
  const zoomLabel = h('span', { class: 'zoom-label mono' }, '100%');

  requestAnimationFrame(() => {
    ctx = canvas.getContext('2d');
    fit();
  });
  if (!resizeBound) {
    window.addEventListener('resize', () => fit());
    resizeBound = true;
  }

  function setZoom(next, cx, cy) {
    const z = Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM);
    const r = canvas.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    // keep the point under the cursor fixed while zooming
    view.x = px - (px - view.x) * (z / view.zoom);
    view.y = py - (py - view.y) * (z / view.zoom);
    view.zoom = z;
    zoomLabel.textContent = Math.round(z * 100) + '%';
    redraw();
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    setZoom(view.zoom * Math.exp(-e.deltaY * 0.0013), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    if (textInput) return;
    canvas.setPointerCapture(e.pointerId);

    // middle mouse, space-drag, or the hand tool pans
    if (e.button === 1 || tool === 'pan' || e.shiftKey) {
      panning = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
      canvas.style.cursor = 'grabbing';
      return;
    }

    const w = toWorld(e);
    if (tool === 'text') { commitText(w); return; }

    drawing = { id: newId(), kind: tool, mine: true, color, width, points: [[w.x, w.y]] };
    pending = [[w.x, w.y]];
    redraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (panning) {
      view.x = panning.ox + (e.clientX - panning.sx);
      view.y = panning.oy + (e.clientY - panning.sy);
      redraw();
      return;
    }
    if (!drawing) return;

    const w = toWorld(e);
    if (drawing.kind === 'pen') {
      drawing.points.push([w.x, w.y]);
      queue([w.x, w.y]);
    } else {
      // shapes are just two corners, keep replacing the second
      drawing.points[1] = [w.x, w.y];
    }
    redraw();
  });

  const finish = () => {
    if (panning) {
      panning = null;
      canvas.style.cursor = '';
      return;
    }
    if (!drawing) return;
    if (drawing.kind === 'pen') flush();
    else {
      send(session.conn, 'wb-stroke', {
        strokeId: drawing.id, kind: drawing.kind,
        color: drawing.color, width: drawing.width, points: drawing.points,
      });
    }
    items.push(drawing);
    drawing = null;
    pending = [];
    redraw();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  const TOOLS = [
    ['pen', ICONS.pen, 'Pen'],
    ['line', ICONS.line, 'Line'],
    ['arrow', ICONS.arrow, 'Arrow'],
    ['rect', ICONS.square, 'Rectangle'],
    ['circle', ICONS.circle, 'Circle'],
    ['triangle', ICONS.triangle, 'Triangle'],
    ['text', ICONS.text, 'Text'],
    ['pan', ICONS.hand, 'Pan (or hold shift)'],
  ];

  const toolBtns = TOOLS.map(([t, ic, title]) =>
    h('button', {
      class: 'btn-icon' + (tool === t ? ' on' : ''),
      title,
      'data-tool': t,
      onClick: () => {
        tool = t;
        wrap.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
        canvas.style.cursor = t === 'pan' ? 'grab' : 'crosshair';
      },
    }, icon(ic, 15))
  );

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
      'data-w': w,
      onClick: (e) => {
        width = w;
        wrap.querySelectorAll('[data-w]').forEach((b) => b.classList.remove('on'));
        e.currentTarget.classList.add('on');
      },
    }, h('span', { style: {
      width: w + 2 + 'px', height: w + 2 + 'px', borderRadius: '50%',
      background: 'currentColor', display: 'block',
    } }))
  );

  function undoMine() {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].mine) {
        const [it] = items.splice(i, 1);
        send(session.conn, 'wb-undo', { strokeId: it.id });
        redraw();
        return;
      }
    }
  }

  function clearAll() {
    items = [];
    redraw();
    send(session.conn, 'wb-clear', {});
  }

  wrap.append(
    h('div', { class: 'board-tools' },
      ...toolBtns,
      h('span', { class: 'tool-div' }),
      ...swatches,
      h('span', { class: 'tool-div' }),
      ...widthBtns,
      h('span', { class: 'tool-div' }),
      h('button', { class: 'btn-icon', title: 'Undo my last', onClick: undoMine }, icon(ICONS.undo, 15)),
      h('button', { class: 'btn-icon', title: 'Clear board', onClick: clearAll }, icon(ICONS.trash, 15))
    ),
    h('div', { class: 'zoom-pill' },
      h('button', { class: 'btn-icon', title: 'Zoom out', onClick: () => setZoom(view.zoom / 1.25) }, '−'),
      zoomLabel,
      h('button', { class: 'btn-icon', title: 'Zoom in', onClick: () => setZoom(view.zoom * 1.25) }, '+'),
      h('span', { class: 'tool-div' }),
      h('button', {
        class: 'btn-icon', title: 'Reset view', style: { width: 'auto', padding: '0 8px', fontSize: '11px' },
        onClick: () => { view = { x: 0, y: 0, zoom: 1 }; zoomLabel.textContent = '100%'; redraw(); },
      }, 'Reset')
    )
  );

  canvas.style.cursor = 'crosshair';
  return wrap;
}
