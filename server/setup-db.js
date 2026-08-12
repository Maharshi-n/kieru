import 'dotenv/config';
import { q, migrate, sweepPresence } from './db.js';

if (!process.env.DB_HOST) {
  console.error('DB_HOST is not set. Fill in the DB_* values in .env first.');
  process.exit(1);
}

try {
  const [{ v }] = await q('SELECT VERSION() AS v');
  console.log('connected to', process.env.DB_HOST, '-', v);

  await migrate();
  console.log('tables created');

  for (const t of ['users', 'friendships', 'presence']) {
    const rows = await q(`SHOW COLUMNS FROM \`${t}\``);
    console.log(`  ${t}: ${rows.length} columns`);
  }

  const [{ c }] = await q(
    `SELECT COUNT(*) AS c FROM information_schema.tables
     WHERE table_schema = ? AND table_name IN ('users','friendships','presence')`,
    [process.env.DB_NAME]
  );
  if (Number(c) !== 3) throw new Error(`expected 3 tables, found ${c}`);

  await sweepPresence();
  console.log('done. all 3 tables present.');
  process.exit(0);
} catch (e) {
  console.error('setup failed:', e.code || '', e.message);
  if (e.code === 'ER_ACCESS_DENIED_ERROR') console.error('check DB_USER / DB_PASS');
  if (e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT') {
    console.error('check DB_HOST, and that your IP is allowed in hPanel > Remote MySQL');
  }
  process.exit(1);
}
