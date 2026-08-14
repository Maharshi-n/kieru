import mysql from 'mysql2/promise';

let pool;

export function db() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 3,
      queueLimit: 0,
      enableKeepAlive: false,
      charset: 'utf8mb4_general_ci',
      connectTimeout: 10000,
      timezone: 'Z',
    });
  }
  return pool;
}

export async function q(sql, params = []) {
  const [rows] = await db().execute(sql, params);
  return rows;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    google_sub VARCHAR(64) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    email VARCHAR(190),
    avatar_url VARCHAR(1000),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_sub (google_sub),
    KEY idx_email (email),
    KEY idx_name (display_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS friendships (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    requester_id BIGINT UNSIGNED NOT NULL,
    addressee_id BIGINT UNSIGNED NOT NULL,
    status ENUM('pending','accepted') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_pair (requester_id, addressee_id),
    KEY idx_addressee (addressee_id, status),
    KEY idx_requester (requester_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS presence (
    user_id BIGINT UNSIGNED PRIMARY KEY,
    peer_id VARCHAR(64) NOT NULL,
    last_heartbeat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_beat (last_heartbeat)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  // day is a plain YYYY-MM-DD in utc, so the daily reset is a key change
  // rather than something that has to be swept
  `CREATE TABLE IF NOT EXISTS share_quota (
    user_id BIGINT UNSIGNED NOT NULL,
    day CHAR(10) NOT NULL,
    seconds_used INT UNSIGNED NOT NULL DEFAULT 0,
    file_bytes_used BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
];

// file_bytes_used landed after share_quota shipped. mysql has no portable
// ADD COLUMN IF NOT EXISTS, so look first.
async function addMissingColumns() {
  const rows = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'share_quota' AND column_name = 'file_bytes_used'`
  );
  if (!rows.length) {
    await q(`ALTER TABLE share_quota ADD COLUMN file_bytes_used BIGINT UNSIGNED NOT NULL DEFAULT 0`);
  }
}

export async function migrate() {
  for (const sql of SCHEMA) await q(sql);
  await addMissingColumns();
}

export async function sweepPresence() {
  await q(`DELETE FROM presence WHERE last_heartbeat < (NOW() - INTERVAL 1 DAY)`);
  await q(`DELETE FROM share_quota WHERE day < DATE_FORMAT(UTC_DATE() - INTERVAL 3 DAY, '%Y-%m-%d')`);
}
