export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(kid));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function icon(paths, size = 16, color = 'currentColor') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', color);
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  logo: 'M4 8h8M8 4v8',
  chat: 'M2.5 12.5V4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5a1.5 1.5 0 0 1-1.5 1.5H5.5z',
  pen: ['M11.5 2.5l2 2-7 7-2.5.5.5-2.5z'],
  file: ['M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5z', 'M9 1.5V5.5H13'],
  phone: 'M5.5 2.5l1.5 3-1.3 1.3a8 8 0 0 0 3.5 3.5L10.5 9l3 1.5v2A1.5 1.5 0 0 1 12 14 10.5 10.5 0 0 1 2 4a1.5 1.5 0 0 1 1.5-1.5z',
  mic: ['M8 2a1.8 1.8 0 0 1 1.8 1.8v4a1.8 1.8 0 0 1-3.6 0v-4A1.8 1.8 0 0 1 8 2z', 'M4 7.5a4 4 0 0 0 8 0M8 11.5V14'],
  micOff: ['M8 2a1.8 1.8 0 0 1 1.8 1.8v4a1.8 1.8 0 0 1-3.6 0v-4A1.8 1.8 0 0 1 8 2z', 'M4 7.5a4 4 0 0 0 8 0M8 11.5V14', 'M2.5 2.5l11 11'],
  x: 'M4 4l8 8M12 4l-8 8',
  check: 'M3.5 8.5l3 3 6-7',
  trash: ['M3 4.5h10', 'M5.5 4.5V3a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v1.5', 'M4.5 4.5l.5 8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8'],
  undo: ['M3 8h7a3 3 0 0 1 0 6H7', 'M5.5 5.5L3 8l2.5 2.5'],
  leave: ['M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6', 'M10.5 11L13.5 8l-3-3', 'M13.5 8H6'],
  download: ['M8 2.5v7', 'M5 7l3 3 3-3', 'M3 13h10'],
  upload: ['M8 10.5v-8', 'M5 5.5l3-3 3 3', 'M3 13h10'],
  screen: ['M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z', 'M6 14h4'],
  line: 'M3 13L13 3',
  arrow: ['M3 13L13 3', 'M8.5 3H13v4.5'],
  square: 'M3 3h10v10H3z',
  circle: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  triangle: 'M8 3l5 10H3z',
  text: ['M3.5 3.5h9', 'M8 3.5v9', 'M6 12.5h4'],
  hand: ['M5 8V4.2a1.2 1.2 0 0 1 2.4 0V8', 'M7.4 7.6V3.4a1.2 1.2 0 0 1 2.4 0V8', 'M9.8 7.8V4.6a1.2 1.2 0 0 1 2.4 0V9.5a4 4 0 0 1-4 4H7.6a4 4 0 0 1-3.3-1.7L2.9 9.6a1.2 1.2 0 0 1 1.9-1.4L5 8.5'],
};

export function toast(msg, kind) {
  const el = h('div', { class: 'toast' + (kind === 'err' ? ' err' : '') }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5000 : 3000);
}

export function modal({ title, body, actions }) {
  const host = document.getElementById('modals');
  const scrim = h('div', { class: 'scrim' });
  const close = () => scrim.remove();
  const btns = actions.map((a) =>
    h('button', { class: a.kind === 'primary' ? 'btn' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost',
      onClick: () => { close(); a.onClick?.(); } }, a.label)
  );
  scrim.append(h('div', { class: 'modal' },
    h('h2', {}, title),
    typeof body === 'string' ? h('p', {}, body) : body,
    h('div', { class: 'modal-actions' }, ...btns)
  ));
  host.append(scrim);
  return close;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}
