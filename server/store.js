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
  email = email ? email.toLowerCase() : null;
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

// email only. names are not unique, and matching on one could add a stranger.
export async function findUserByEmail(email) {
  const e = email.toLowerCase();
  if (usingMemory) {
    return mem.users.find((u) => u.email?.toLowerCase() === e) ?? null;
  }
  const rows = await q(`SELECT * FROM users WHERE email=? LIMIT 1`, [e]);
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

export async function stats() {
  if (usingMemory) {
    const now = Date.now();
    return {
      users: mem.users.length,
      online: [...mem.presence.values()].filter((p) => now - p.at < ONLINE_SECONDS * 1000).length,
      friendships: mem.friendships.filter((f) => f.status === 'accepted').length,
      pending: mem.friendships.filter((f) => f.status === 'pending').length,
      new_today: 0,
      new_week: 0,
    };
  }
  const [[u], [p], [f]] = await Promise.all([
    q(`SELECT COUNT(*) AS total,
              SUM(created_at >= UTC_DATE()) AS today,
              SUM(created_at >= UTC_DATE() - INTERVAL 7 DAY) AS week
       FROM users`),
    q(`SELECT COUNT(*) AS online FROM presence WHERE last_heartbeat > (NOW() - INTERVAL ? SECOND)`, [ONLINE_SECONDS]),
    q(`SELECT SUM(status='accepted') AS accepted, SUM(status='pending') AS pending FROM friendships`),
  ]);
  return {
    users: Number(u.total) || 0,
    online: Number(p.online) || 0,
    friendships: Number(f.accepted) || 0,
    pending: Number(f.pending) || 0,
    new_today: Number(u.today) || 0,
    new_week: Number(u.week) || 0,
  };
}

// everyone, newest first, with whoever is currently up flagged. no paging:
// this is a two-person app, the table is small and it is mine to read.
export async function allUsers() {
  if (usingMemory) {
    const now = Date.now();
    return [...mem.users].reverse().map((u) => {
      const p = mem.presence.get(u.id);
      const online = !!p && now - p.at < ONLINE_SECONDS * 1000;
      return {
        display_name: u.display_name,
        email: u.email,
        created_at: null,
        online,
        seconds_ago: online ? Math.round((now - p.at) / 1000) : null,
      };
    });
  }
  const rows = await q(
    `SELECT u.display_name, u.email, u.created_at,
            (p.last_heartbeat > (NOW() - INTERVAL ? SECOND)) AS online,
            TIMESTAMPDIFF(SECOND, p.last_heartbeat, NOW()) AS seconds_ago
     FROM users u LEFT JOIN presence p ON p.user_id = u.id
     ORDER BY u.created_at DESC`,
    [ONLINE_SECONDS]
  );
  return rows.map((r) => ({
    ...r,
    online: !!Number(r.online),
    seconds_ago: Number(r.online) ? Number(r.seconds_ago) : null,
  }));
}

export const SHARE_BUDGET = 20;

const utcDay = () => new Date().toISOString().slice(0, 10);

export async function shareUsed(userId) {
  if (usingMemory) return memRow(userId, utcDay()).seconds;
  const rows = await q(`SELECT seconds_used FROM share_quota WHERE user_id=? AND day=?`, [userId, utcDay()]);
  return rows[0] ? Number(rows[0].seconds_used) : 0;
}

export async function addShareSeconds(userId, seconds) {
  const day = utcDay();
  if (usingMemory) {
    const row = memRow(userId, day);
    row.seconds = Math.min(row.seconds + seconds, SHARE_BUDGET);
    return row.seconds;
  }
  await q(
    `INSERT INTO share_quota (user_id, day, seconds_used) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE seconds_used = LEAST(seconds_used + VALUES(seconds_used), ?)`,
    [userId, day, seconds, SHARE_BUDGET]
  );
  return shareUsed(userId);
}

// one relayed file allowance per day, spend it on as many files as you like
export const FILE_BUDGET = 10 * 1024 * 1024;

function memRow(userId, day) {
  let row = mem.quota.get(userId);
  if (!row || row.day !== day) {
    row = { day, seconds: 0, bytes: 0 };
    mem.quota.set(userId, row);
  }
  return row;
}

export async function fileBytesUsed(userId) {
  if (usingMemory) return memRow(userId, utcDay()).bytes;
  const rows = await q(`SELECT file_bytes_used FROM share_quota WHERE user_id=? AND day=?`, [userId, utcDay()]);
  return rows[0] ? Number(rows[0].file_bytes_used) : 0;
}

// debits up front and says whether it fit. checking and then spending would let
// two files started at once both pass a check they can't both afford.
export async function reserveFileBytes(userId, bytes) {
  const day = utcDay();
  if (usingMemory) {
    const row = memRow(userId, day);
    if (row.bytes + bytes > FILE_BUDGET) return { ok: false, used: row.bytes };
    row.bytes += bytes;
    return { ok: true, used: row.bytes };
  }
  if (bytes > FILE_BUDGET) return { ok: false, used: await fileBytesUsed(userId) };

  // make sure the row exists, then let the WHERE do the deciding. an
  // ON DUPLICATE KEY IF() can't report whether it declined: affectedRows is 0
  // both when the budget refused it and when the value simply didn't move.
  await q(`INSERT IGNORE INTO share_quota (user_id, day) VALUES (?,?)`, [userId, day]);
  const r = await q(
    `UPDATE share_quota SET file_bytes_used = file_bytes_used + ?
     WHERE user_id=? AND day=? AND file_bytes_used + ? <= ?`,
    [bytes, userId, day, bytes, FILE_BUDGET]
  );
  const used = await fileBytesUsed(userId);
  return { ok: r.affectedRows > 0, used };
}

export async function refundFileBytes(userId, bytes) {
  const day = utcDay();
  if (usingMemory) {
    const row = memRow(userId, day);
    row.bytes = Math.max(0, row.bytes - bytes);
    return;
  }
  await q(
    `UPDATE share_quota SET file_bytes_used = GREATEST(0, CAST(file_bytes_used AS SIGNED) - ?)
     WHERE user_id=? AND day=?`,
    [bytes, userId, day]
  );
}
