import { q, migrate } from './db.js';

export const usingMemory = !process.env.DB_HOST;

const mem = { users: [], friendships: [], presence: new Map(), quota: new Map(), seq: 1 };

export async function init() {
  if (usingMemory) return;
  if (process.env.MIGRATE_ON_BOOT === '1') await migrate();
  else await q('SELECT 1');   // fail fast on bad credentials rather than at first request
}

const ONLINE_SECONDS = 25;

export async function upsertUser({ sub, name, email, avatar }) {
  if (usingMemory) {
    let u = mem.users.find((x) => x.google_sub === sub);
    if (!u) {
      u = { id: mem.seq++, google_sub: sub, display_name: name, email, avatar_url: avatar };
      mem.users.push(u);
    } else {
      u.display_name = name;
      u.email = email;
      u.avatar_url = avatar;
    }
    return u;
  }
  await q(
    `INSERT INTO users (google_sub, display_name, email, avatar_url) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), email=VALUES(email), avatar_url=VALUES(avatar_url)`,
    [sub, name, email ?? null, avatar ?? null]
  );
  const rows = await q(`SELECT * FROM users WHERE google_sub=?`, [sub]);
  return rows[0];
}

export async function getUser(id) {
  if (usingMemory) return mem.users.find((u) => u.id === id) ?? null;
  const rows = await q(`SELECT * FROM users WHERE id=?`, [id]);
  return rows[0] ?? null;
}

export async function findUserByEmailOrName(handle) {
  if (usingMemory) {
    const h = handle.toLowerCase();
    return mem.users.find((u) => u.email?.toLowerCase() === h || u.display_name.toLowerCase() === h) ?? null;
  }
  const rows = await q(`SELECT * FROM users WHERE email=? OR display_name=? LIMIT 1`, [handle, handle]);
  return rows[0] ?? null;
}

export async function createFriendRequest(requesterId, addresseeId) {
  if (usingMemory) {
    const existing = mem.friendships.find(
      (f) =>
        (f.requester_id === requesterId && f.addressee_id === addresseeId) ||
        (f.requester_id === addresseeId && f.addressee_id === requesterId)
    );
    if (existing) return existing;
    const f = { id: mem.seq++, requester_id: requesterId, addressee_id: addresseeId, status: 'pending' };
    mem.friendships.push(f);
    return f;
  }
  const dupe = await q(
    `SELECT * FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?) LIMIT 1`,
    [requesterId, addresseeId, addresseeId, requesterId]
  );
  if (dupe[0]) return dupe[0];
  await q(`INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?,?,'pending')`, [
    requesterId,
    addresseeId,
  ]);
  const rows = await q(`SELECT * FROM friendships WHERE requester_id=? AND addressee_id=?`, [
    requesterId,
    addresseeId,
  ]);
  return rows[0];
}

export async function respondToRequest(friendshipId, userId, accept) {
  if (usingMemory) {
    const i = mem.friendships.findIndex((f) => f.id === friendshipId && f.addressee_id === userId);
    if (i === -1) return false;
    if (accept) mem.friendships[i].status = 'accepted';
    else mem.friendships.splice(i, 1);
    return true;
  }
  // the addressee_id check is the auth — only the recipient can respond
  if (accept) {
    const r = await q(`UPDATE friendships SET status='accepted' WHERE id=? AND addressee_id=? AND status='pending'`, [
      friendshipId,
      userId,
    ]);
    return r.affectedRows > 0;
  }
  const r = await q(`DELETE FROM friendships WHERE id=? AND addressee_id=? AND status='pending'`, [
    friendshipId,
    userId,
  ]);
  return r.affectedRows > 0;
}

export async function listPending(userId) {
  if (usingMemory) {
    return mem.friendships
      .filter((f) => f.addressee_id === userId && f.status === 'pending')
      .map((f) => {
        const u = mem.users.find((x) => x.id === f.requester_id);
        return { friendship_id: f.id, user_id: u.id, display_name: u.display_name, avatar_url: u.avatar_url };
      });
  }
  return q(
    `SELECT f.id AS friendship_id, u.id AS user_id, u.display_name, u.avatar_url
     FROM friendships f JOIN users u ON u.id = f.requester_id
     WHERE f.addressee_id=? AND f.status='pending'`,
    [userId]
  );
}

export async function listFriends(userId) {
  if (usingMemory) {
    const now = Date.now();
    return mem.friendships
      .filter((f) => f.status === 'accepted' && (f.requester_id === userId || f.addressee_id === userId))
      .map((f) => {
        const otherId = f.requester_id === userId ? f.addressee_id : f.requester_id;
        const u = mem.users.find((x) => x.id === otherId);
        const p = mem.presence.get(otherId);
        const online = !!p && now - p.at < ONLINE_SECONDS * 1000;
        return {
          user_id: u.id,
          display_name: u.display_name,
          avatar_url: u.avatar_url,
          online,
          peer_id: online ? p.peer_id : null,
        };
      });
  }
  return q(
    `SELECT u.id AS user_id, u.display_name, u.avatar_url,
            (p.last_heartbeat IS NOT NULL AND p.last_heartbeat > (NOW() - INTERVAL ? SECOND)) AS online,
            CASE WHEN p.last_heartbeat > (NOW() - INTERVAL ? SECOND) THEN p.peer_id ELSE NULL END AS peer_id
     FROM friendships f
     JOIN users u ON u.id = IF(f.requester_id=?, f.addressee_id, f.requester_id)
     LEFT JOIN presence p ON p.user_id = u.id
     WHERE f.status='accepted' AND (f.requester_id=? OR f.addressee_id=?)`,
    [ONLINE_SECONDS, ONLINE_SECONDS, userId, userId, userId]
  ).then((rows) => rows.map((r) => ({ ...r, online: !!Number(r.online) })));
}

export async function heartbeat(userId, peerId) {
  if (usingMemory) {
    mem.presence.set(userId, { peer_id: peerId, at: Date.now() });
    return;
  }
  await q(
    `INSERT INTO presence (user_id, peer_id, last_heartbeat) VALUES (?,?,NOW())
     ON DUPLICATE KEY UPDATE peer_id=VALUES(peer_id), last_heartbeat=NOW()`,
    [userId, peerId]
  );
}

export async function clearPresence(userId) {
  if (usingMemory) {
    mem.presence.delete(userId);
    return;
  }
  await q(`DELETE FROM presence WHERE user_id=?`, [userId]);
}

export const SHARE_BUDGET = 20;

const utcDay = () => new Date().toISOString().slice(0, 10);

export async function shareUsed(userId) {
  if (usingMemory) {
    const row = mem.quota.get(userId);
    return row?.day === utcDay() ? row.seconds : 0;
  }
  const rows = await q(`SELECT seconds_used FROM share_quota WHERE user_id=? AND day=?`, [userId, utcDay()]);
  return rows[0] ? Number(rows[0].seconds_used) : 0;
}

// returns what the total is after adding, so the caller never has to read back
export async function addShareSeconds(userId, seconds) {
  const day = utcDay();
  if (usingMemory) {
    const row = mem.quota.get(userId);
    const base = row?.day === day ? row.seconds : 0;
    const total = Math.min(base + seconds, SHARE_BUDGET);
    mem.quota.set(userId, { day, seconds: total });
    return total;
  }
  await q(
    `INSERT INTO share_quota (user_id, day, seconds_used) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE seconds_used = LEAST(seconds_used + VALUES(seconds_used), ?)`,
    [userId, day, seconds, SHARE_BUDGET]
  );
  return shareUsed(userId);
}
