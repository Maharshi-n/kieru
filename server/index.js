import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import * as store from './store.js';

const app = express();
app.set('trust proxy', 1);   // hostinger fronts the app with a proxy; needed for real client ips

const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: ORIGINS.length ? ORIGINS : true,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['content-type', 'authorization'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '16kb' }));

const PORT = process.env.PORT || 3001;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const PROD = process.env.NODE_ENV === 'production';

// a known fallback secret would let anyone mint a token for any account
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (PROD) {
    console.error('JWT_SECRET is required in production. Refusing to start.');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET unset — generated a random one. Logins reset on restart.');
}

const ALLOW_DEV_LOGIN = PROD
  ? process.env.ALLOW_DEV_LOGIN === '1'
  : process.env.ALLOW_DEV_LOGIN !== '0';
if (PROD && ALLOW_DEV_LOGIN) {
  console.warn('[warn] ALLOW_DEV_LOGIN=1 in production — anyone can log in as anyone.');
}

const google = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const hits = new Map();

function limit(name, max, windowMs, onlyFailures = false) {
  return (req, res, next) => {
    const who = req.uid || req.ip || 'unknown';
    const key = `${name}:${who}`;
    const now = Date.now();
    const rec = hits.get(key);

    if (rec && now <= rec.reset && rec.n >= max) {
      res.set('retry-after', Math.ceil((rec.reset - now) / 1000));
      return res.status(429).json({ error: 'too many attempts, try again in a minute' });
    }

    const count = () => {
      const cur = hits.get(key);
      if (!cur || Date.now() > cur.reset) hits.set(key, { n: 1, reset: Date.now() + windowMs });
      else cur.n += 1;
    };

    // only count 401/403. a 400 is a typo, and typos on a shared ip would lock everyone out
    if (!onlyFailures) count();
    else res.on('finish', () => { if (res.statusCode === 401 || res.statusCode === 403) count(); });

    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60000).unref();

function sign(user) {
  return jwt.sign({ uid: user.id, name: user.display_name }, JWT_SECRET, { expiresIn: '24h' });
}

function publicUser(u) {
  return { id: u.id, display_name: u.display_name, email: u.email ?? null, avatar_url: u.avatar_url ?? null };
}

const badTokens = limit('badtoken', 40, 10 * 60 * 1000, true);

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.uid = jwt.verify(token, JWT_SECRET).uid;
    return next();
  } catch {
    return badTokens(req, res, () => res.status(401).json({ error: 'invalid token' }));
  }
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(`[500] ${req.method} ${req.path}:`, e.code || '', e.sqlMessage || e.message);
  if (e.code === 'ER_NO_SUCH_TABLE') {
    return res.status(500).json({ error: 'database not set up — run node server/setup-db.js' });
  }
  res.status(500).json({ error: 'server error' });
});

app.get('/health', (_req, res) => res.json({ ok: true, store: store.usingMemory ? 'memory' : 'mysql' }));

app.get('/config', (_req, res) =>
  res.json({ googleClientId: GOOGLE_CLIENT_ID ?? null, devLogin: ALLOW_DEV_LOGIN })
);

app.post('/auth/google', limit('auth', 30, 10 * 60 * 1000, true), wrap(async (req, res) => {
  const { credential } = req.body || {};
  if (!google) return res.status(503).json({ error: 'Google sign-in not configured' });
  if (typeof credential !== 'string' || !credential) return res.status(400).json({ error: 'credential required' });
  let payload;
  try {
    const ticket = await google.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: 'invalid google token' });
  }
  const user = await store.upsertUser({
    sub: payload.sub,
    name: (payload.name || payload.email || 'User').slice(0, 100),
    email: payload.email?.slice(0, 190) ?? null,
    avatar: payload.picture?.slice(0, 1000) ?? null,
  });
  res.json({ token: sign(user), user: publicUser(user) });
}));

app.post('/auth/dev', limit('auth', 30, 10 * 60 * 1000, true), wrap(async (req, res) => {
  if (!ALLOW_DEV_LOGIN) return res.status(403).json({ error: 'dev login disabled' });
  const name = String(req.body?.name || '').trim();
  if (!/^[\w .'-]{2,40}$/.test(name)) return res.status(400).json({ error: 'name must be 2-40 plain characters' });
  const user = await store.upsertUser({
    sub: `dev:${name.toLowerCase()}`,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@dev.local`,
    avatar: null,
  });
  res.json({ token: sign(user), user: publicUser(user) });
}));

app.get('/me', auth, wrap(async (req, res) => {
  const u = await store.getUser(req.uid);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json(publicUser(u));
}));

app.get('/friends', auth, wrap(async (req, res) => {
  res.json(await store.listFriends(req.uid));
}));

app.get('/friends/pending', auth, wrap(async (req, res) => {
  res.json(await store.listPending(req.uid));
}));

app.post('/friends/request', auth, limit('friend-req', 20, 60 * 60 * 1000), wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (email.length > 190 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'email required' });
  const target = await store.findUserByEmail(email);
  if (target && target.id !== req.uid) await store.createFriendRequest(req.uid, target.id);
  // same answer either way, or this becomes a way to check if an email has an account
  res.json({ ok: true });
}));

app.post('/friends/respond', auth, limit('friend-resp', 60, 60 * 60 * 1000), wrap(async (req, res) => {
  const id = Number(req.body?.friendship_id);
  const accept = !!req.body?.accept;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'friendship_id required' });
  const ok = await store.respondToRequest(id, req.uid, accept);
  if (!ok) return res.status(404).json({ error: 'no such pending request' });
  res.json({ ok: true });
}));

app.post('/heartbeat', auth, limit('beat', 120, 60 * 1000), wrap(async (req, res) => {
  const peerId = String(req.body?.peer_id || '');
  if (!/^[\w-]{6,64}$/.test(peerId)) return res.status(400).json({ error: 'bad peer_id' });
  await store.heartbeat(req.uid, peerId);
  res.json({ ok: true });
}));

app.get('/share/quota', auth, limit('quota', 60, 60 * 1000), wrap(async (req, res) => {
  const used = await store.shareUsed(req.uid);
  res.json({ used, budget: store.SHARE_BUDGET });
}));

app.post('/share/tick', auth, limit('tick', 120, 60 * 1000), wrap(async (req, res) => {
  const secs = Number(req.body?.seconds);
  if (!Number.isFinite(secs) || secs < 1 || secs > 30) return res.status(400).json({ error: 'bad seconds' });
  const used = await store.addShareSeconds(req.uid, Math.round(secs));
  res.json({ used, budget: store.SHARE_BUDGET, exhausted: used >= store.SHARE_BUDGET });
}));

app.get('/files/quota', auth, limit('fquota', 60, 60 * 1000), wrap(async (req, res) => {
  const used = await store.fileBytesUsed(req.uid);
  res.json({ used, budget: store.FILE_BUDGET });
}));

// claimed before the offer goes out, so the sender can't start more than the
// day's allowance at once. the peer never gets asked if there is no room.
app.post('/files/reserve', auth, limit('freserve', 60, 60 * 1000), wrap(async (req, res) => {
  const bytes = Number(req.body?.bytes);
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > store.FILE_BUDGET) {
    return res.status(400).json({ error: 'bad bytes' });
  }
  const { ok, used } = await store.reserveFileBytes(req.uid, bytes);
  res.json({ ok, used, budget: store.FILE_BUDGET });
}));

app.post('/files/refund', auth, limit('frefund', 60, 60 * 1000), wrap(async (req, res) => {
  const bytes = Number(req.body?.bytes);
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > store.FILE_BUDGET) {
    return res.status(400).json({ error: 'bad bytes' });
  }
  await store.refundFileBytes(req.uid, bytes);
  res.json({ ok: true });
}));

app.delete('/presence', wrap(async (req, res) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.body?.token;
  try {
    const { uid } = jwt.verify(String(token || ''), JWT_SECRET);
    await store.clearPresence(uid);
  } catch {}
  res.json({ ok: true });
}));

app.post('/presence/clear', express.text({ type: 'text/*' }), wrap(async (req, res) => {
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : body.token;
  try {
    const { uid } = jwt.verify(String(token || ''), JWT_SECRET);
    await store.clearPresence(uid);
  } catch {}
  res.json({ ok: true });
}));

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

// server rendered, not a view in the spa. a page in the bundle would ship its
// own gate to every visitor and the password would be sitting in the js.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function adminOk(req) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  const [, pass = ''] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  const given = Buffer.from(pass);
  const want = Buffer.from(ADMIN_PASSWORD);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

app.get('/admin', limit('admin', 20, 10 * 60 * 1000, true), wrap(async (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).type('text').send('admin disabled: set ADMIN_PASSWORD');
  if (!adminOk(req)) {
    res.set('www-authenticate', 'Basic realm="kieru admin", charset="UTF-8"');
    return res.status(401).type('text').send('unauthorized');
  }
  const [s, users] = await Promise.all([store.stats(), store.allUsers()]);
  res.set('cache-control', 'no-store').type('html').send(adminPage(s, users));
}));

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const joined = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');

function adminPage(s, users) {
  const card = (label, value) => `<div class="c"><div class="l">${label}</div><div class="v">${value}</div></div>`;

  const row = (u) => `<tr>
    <td>${u.online ? '<b class="on">online</b>' : '<span class="off">offline</span>'}</td>
    <td>${esc(u.display_name)}</td>
    <td class="m">${esc(u.email) || '-'}</td>
    <td class="m r">${u.online ? `${u.seconds_ago}s ago` : joined(u.created_at)}</td>
  </tr>`;

  const rows = users.length
    ? users.map(row).join('')
    : '<tr><td colspan="4" class="empty">nobody has signed up yet</td></tr>';

  return `<!doctype html><meta charset="utf-8"><title>kieru admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
:root{--bg:#111113;--card:#1a1a1d;--bd:#26262a;--tx:#ececee;--sec:#9a9aa1;--mut:#77777e;--ok:#6faf7f}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px;background:var(--bg);color:var(--tx);
  font:15px/1.5 "Instrument Sans",system-ui,sans-serif}
main{max-width:860px;margin:0 auto}
h1{font-size:19px;font-weight:600;margin:0}
.sub{color:var(--mut);font-size:13px;margin:4px 0 24px}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px;margin-bottom:28px}
.c{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px}
.l{color:var(--sec);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.v{font:600 26px/1.2 "IBM Plex Mono",ui-monospace,monospace;margin-top:6px}
h2{font-size:13px;font-weight:600;color:var(--sec);text-transform:uppercase;
  letter-spacing:.04em;margin:0 0 10px}
table{width:100%;border-collapse:collapse;background:var(--card);
  border:1px solid var(--bd);border-radius:12px;overflow:hidden}
td{padding:11px 14px;border-top:1px solid var(--bd)}
tr:first-child td{border-top:0}
.m{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:13px;color:var(--sec)}
.r{text-align:right;white-space:nowrap}
.on{color:var(--ok);font-weight:500}
.off{color:var(--mut)}
.empty{color:var(--mut);text-align:center}
footer{color:var(--mut);font-size:12px;margin-top:22px}
</style>
<main>
<h1>kieru admin</h1>
<div class="sub">${store.usingMemory ? 'memory store (dev)' : 'mysql'} &middot; reloads every 15s</div>
<div class="g">
${card('Online now', `<span class="on">${s.online}</span>`)}
${card('Registered', s.users)}
${card('New today', s.new_today)}
${card('New this week', s.new_week)}
${card('Friendships', s.friendships)}
${card('Pending', s.pending)}
</div>
<h2>Everyone (${users.length})</h2>
<table>${rows}</table>
<footer>${new Date().toISOString()}</footer>
</main>
<script>setTimeout(()=>location.reload(),15000)</script>`;
}

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  console.warn('[warn] no dist/ folder — run npm run build');
}

store.init().then(
  () => app.listen(PORT, () => console.log(`API on :${PORT} (${store.usingMemory ? 'memory store' : 'mysql'})`)),
  (e) => {
    console.error('DB init failed:', e.message);
    process.exit(1);
  }
);
