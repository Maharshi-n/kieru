import 'dotenv/config';
import crypto from 'node:crypto';
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

// dev login bypasses google entirely, so it must never be on by default in prod
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
  console.error(e);
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
    name: payload.name || payload.email || 'User',
    email: payload.email,
    avatar: payload.picture,
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
  const handle = String(req.body?.handle || '').trim();
  if (handle.length < 2 || handle.length > 255) return res.status(400).json({ error: 'handle required' });
  const target = await store.findUserByEmailOrName(handle);
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

// sendBeacon can't set headers, so accept the token in the body too.
app.delete('/presence', wrap(async (req, res) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.body?.token;
  try {
    const { uid } = jwt.verify(String(token || ''), JWT_SECRET);
    await store.clearPresence(uid);
  } catch {
    /* best-effort on tab close — never surface an error */
  }
  res.json({ ok: true });
}));

app.post('/presence/clear', express.text({ type: 'text/*' }), wrap(async (req, res) => {
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : body.token;
  try {
    const { uid } = jwt.verify(String(token || ''), JWT_SECRET);
    await store.clearPresence(uid);
  } catch {
    /* best-effort */
  }
  res.json({ ok: true });
}));

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

store.init().then(
  () => app.listen(PORT, () => console.log(`API on :${PORT} (${store.usingMemory ? 'memory store' : 'mysql'})`)),
  (e) => {
    console.error('DB init failed:', e.message);
    process.exit(1);
  }
);
