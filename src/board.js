import { h, icon, ICONS } from './ui.js';
import { send } from './peer.js';
import { session, on } from './session.js';

const COLORS = ['#ececee', '#6f9fd8', '#a78bdb', '#8fbf7f', '#d9a25f', '#d87f8b'];
const WIDTHS = [2, 4, 8];
const MIN_TEXT = 8;
const MAX_TEXT = 400;
const HANDLE = 7;        // corner box, screen px
const BATCH_MS = 45;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;

// world coordinates, not screen. the canvas is an infinite plane and pan/zoom
// only change how we look at it, so both sides stay in sync at any zoom.
let items = [];
let canvas = null, ctx = null;
let color = COLORS[0], width = WIDTHS[0];
let textSize = 20;
let tool = 'pen';
let dragging = null;
let resizing = null;
let selected = null;
let ctrlHeld = false;
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
  selected = null;
  dragging = null;
  resizing = null;
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

  const w = Math.round(r.width * dpr());
  const h = Math.round(r.height * dpr());
  // setting width/height clears the canvas, so only touch it when it really changed
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  if (!ctx) ctx = canvas.getContext('2d');
  redraw();
}

function redraw() {
  if (!ctx || !canvas) return;
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;
  // derive the scale from the backing store rather than reading dpr() again, or
  // the transform and the actual canvas size can disagree and clicks land off-target
  const d = canvas.width / r.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(view.zoom * d, 0, 0, view.zoom * d, view.x * d, view.y * d);

  grid();
  for (const it of items) paint(it);
  if (drawing) paint(drawing);
}

// dotted box with four corner handles. drawn in world units scaled by zoom so it
// stays a constant thickness on screen.
function drawSelection(it) {
  const z = view.zoom;
  const pad = 4 / z;
  const x = it.x - pad, y = it.y - pad;
  const w = it.w + pad * 2, hh = it.h + pad * 2;

  ctx.save();
  ctx.strokeStyle = '#8b8b93';
  ctx.lineWidth = 1 / z;
  ctx.setLineDash([4 / z, 3 / z]);
  ctx.strokeRect(x, y, w, hh);

  ctx.setLineDash([]);
  ctx.fillStyle = '#131316';
  ctx.strokeStyle = '#ececee';
  const s = HANDLE / z;
  for (const [cx, cy] of corners(it)) {
    ctx.beginPath();
    ctx.rect(cx - s / 2, cy - s / 2, s, s);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function corners(it) {
  const pad = 4 / view.zoom;
  const x = it.x - pad, y = it.y - pad;
  const w = it.w + pad * 2, hh = it.h + pad * 2;
  return [[x, y], [x + w, y], [x, y + hh], [x + w, y + hh]];
}

// single source of truth for the cursor, so releasing the mouse never forgets
// that ctrl is still held
function idleCursor() {
  if (ctrlHeld) return 'grab';        // ctrl pans the board
  return tool === 'pan' ? 'grab' : 'crosshair';
}

// the corner opposite the one being dragged stays put while resizing
function anchorFor(it, corner) {
  const cs = corners(it);
  const opposite = [3, 2, 1, 0][corner];
  return { x: cs[opposite][0], y: cs[opposite][1], corner };
}

// measure without waiting for a paint, so text is clickable the moment it exists
function measure(it) {
  if (!ctx) return;
  const size = it.size || 16;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `${size}px 'Instrument Sans', sans-serif`;
  it.w = ctx.measureText(it.text).width;
  it.h = size * 1.25;
  ctx.restore();
}

// which corner is under the cursor, if any
function handleAt(world) {
  if (!selected || selected.w == null) return -1;
  const r = (HANDLE + 3) / view.zoom;
  const cs = corners(selected);
  for (let i = 0; i < cs.length; i++) {
    if (Math.abs(world.x - cs[i][0]) <= r && Math.abs(world.y - cs[i][1]) <= r) return i;
  }
  return -1;
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
    const size = it.size || 16;
    ctx.font = `${size}px 'Instrument Sans', sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(it.text, it.x, it.y);
    // remember the box so pointer hits can find this text later
    it.w = ctx.measureText(it.text).width;
    it.h = size * 1.25;
    if (it === selected) drawSelection(it);
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
  const incoming = {
    id: p.strokeId, kind: 'text', mine: false,
    color: p.color || '#ececee', text: p.text.slice(0, 200),
    x: p.x, y: p.y, size: p.size || 16,
  };
  measure(incoming);
  items.push(incoming);
  redraw();
});

on('wb-clear', () => { items = []; selected = null; redraw(); });

on('wb-undo', (p) => {
  if (!p?.strokeId) return;
  if (selected?.id === p.strokeId) selected = null;
  items = items.filter((x) => x.id !== p.strokeId);
  redraw();
});

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// topmost text under the cursor. w/h are filled in by paint().
function textAt(w) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'text' || it.w == null) continue;
    if (w.x >= it.x - 3 && w.x <= it.x + it.w + 3 && w.y >= it.y - 2 && w.y <= it.y + it.h + 2) return it;
  }
  return null;
}

on('wb-move', (p) => {
  if (!p?.strokeId) return;
  const it = items.find((x) => x.id === p.strokeId);
  if (!it) return;
  it.x = p.x;
  it.y = p.y;
  if (p.size) { it.size = p.size; measure(it); }
  redraw();
});

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
      fontSize: Math.max(11, textSize * view.zoom) + 'px',
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
    const it = { id: newId(), kind: 'text', mine: true, color, text, x: world.x, y: world.y, size: textSize };
    measure(it);
    items.push(it);
    selected = it;
    send(session.conn, 'wb-text', {
      strokeId: it.id, text, color, x: world.x, y: world.y, size: textSize,
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
  // the window resize event misses the chat divider being dragged, which changes
  // the canvas size without the window changing. observe the element itself.
  if (!resizeBound) {
    window.addEventListener('resize', () => fit());
    new ResizeObserver(() => fit()).observe(canvas);

    // hold ctrl to move text with any tool selected
    const setCtrl = (e) => {
      const now = e.ctrlKey || e.metaKey;
      if (now === ctrlHeld) return;
      ctrlHeld = now;
      if (canvas && !dragging && !resizing && !panning) canvas.style.cursor = idleCursor();
    };
    window.addEventListener('keydown', setCtrl);
    window.addEventListener('keyup', setCtrl);
    // alt-tabbing away leaves ctrl stuck otherwise
    window.addEventListener('blur', () => { ctrlHeld = false; });

    window.addEventListener('keydown', (e) => {
      if (textInput) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        const it = selected;
        items = items.filter((x) => x !== it);
        selected = null;
        send(session.conn, 'wb-undo', { strokeId: it.id });
        redraw();
      }
      if (e.key === 'Escape' && selected) { selected = null; redraw(); }
    });

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

    // ctrl, middle mouse, shift, or the hand tool all pan the board
    if (e.button === 1 || tool === 'pan' || e.shiftKey || e.ctrlKey || e.metaKey) {
      panning = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
      canvas.style.cursor = 'grabbing';
      return;
    }

    const w = toWorld(e);

    // corner of the selected text starts a resize
    const corner = handleAt(w);
    if (corner !== -1) {
      resizing = { item: selected, startSize: selected.size || 16, anchor: anchorFor(selected, corner), start: w };
      return;
    }

    // pressing anywhere inside text selects it and starts moving it
    const hit = textAt(w);
    if (hit) {
      selected = hit;
      dragging = { item: hit, dx: w.x - hit.x, dy: w.y - hit.y, moved: false };
      canvas.style.cursor = 'grabbing';
      redraw();
      return;
    }

    if (selected) { selected = null; redraw(); }

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
    if (resizing) {
      const w = toWorld(e);
      const it = resizing.item;
      const a = resizing.anchor;
      // scale by how far the cursor is from the anchor vs where it started
      const was = Math.hypot(resizing.start.x - a.x, resizing.start.y - a.y);
      const now = Math.hypot(w.x - a.x, w.y - a.y);
      if (was > 0.01) {
        it.size = Math.min(Math.max(resizing.startSize * (now / was), MIN_TEXT), MAX_TEXT);
        measure(it);
        // keep the anchor corner pinned as the box grows
        if (a.corner === 0) { it.x = a.x - it.w; it.y = a.y - it.h; }
        else if (a.corner === 1) { it.y = a.y - it.h; }
        else if (a.corner === 2) { it.x = a.x - it.w; }
      }
      resizing.moved = true;
      redraw();
      return;
    }
    if (dragging) {
      const w = toWorld(e);
      dragging.item.x = w.x - dragging.dx;
      dragging.item.y = w.y - dragging.dy;
      dragging.moved = true;
      redraw();
      return;
    }
    if (!drawing) {
      if (!panning) {
        const w = toWorld(e);
        const corner = handleAt(w);
        canvas.style.cursor = corner !== -1
          ? (corner === 0 || corner === 3 ? 'nwse-resize' : 'nesw-resize')
          : (!ctrlHeld && textAt(w)) ? 'move'
          : idleCursor();
      }
      return;
    }

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
      canvas.style.cursor = idleCursor();
      return;
    }
    if (resizing) {
      const it = resizing.item;
      if (resizing.moved) {
        send(session.conn, 'wb-move', { strokeId: it.id, x: it.x, y: it.y, size: it.size });
      }
      resizing = null;
      redraw();
      return;
    }
    if (dragging) {
      const it = dragging.item;
      if (dragging.moved) {
        send(session.conn, 'wb-move', { strokeId: it.id, x: it.x, y: it.y, size: it.size });
      }
      dragging = null;
      canvas.style.cursor = idleCursor();
      redraw();
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
    ),
    h('div', { class: 'board-hint' }, 'Drag text to move it · pull its corners to resize · Ctrl+drag to pan the board')
  );

  canvas.style.cursor = 'crosshair';
  return wrap;
}
