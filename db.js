// SQLite storage using Node's built-in driver (Node >= 22.5). No native deps.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'peakbook.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  whatsapp TEXT NOT NULL,          -- digits only, intl format, e.g. 996555123456
  bio TEXT DEFAULT '',
  token TEXT NOT NULL UNIQUE       -- MVP host auth: secret dashboard key
);
CREATE TABLE IF NOT EXISTS experiences (
  id INTEGER PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('trek','yurt','horse','climb')),
  region TEXT NOT NULL,
  description TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  price_usd INTEGER NOT NULL,      -- per person
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy','moderate','hard')),
  season_start INTEGER NOT NULL,   -- month 1-12
  season_end INTEGER NOT NULL,     -- month 1-12
  includes TEXT DEFAULT '',
  accepts_online INTEGER NOT NULL DEFAULT 1,
  accepts_cash INTEGER NOT NULL DEFAULT 1,
  free_cancel_days INTEGER NOT NULL DEFAULT 7   -- free cancellation until N days before
);
CREATE TABLE IF NOT EXISTS departures (
  id INTEGER PRIMARY KEY,
  experience_id INTEGER NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  date TEXT NOT NULL,              -- YYYY-MM-DD
  seats_total INTEGER NOT NULL CHECK (seats_total > 0),
  UNIQUE (experience_id, date)
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  departure_id INTEGER NOT NULL REFERENCES departures(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  party_size INTEGER NOT NULL CHECK (party_size > 0),
  message TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','declined','expired','cancelled')),
  -- Like Booking.com: "pay now" (online) or "pay the guide" (cash on the day).
  payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('online','cash')),
  -- online: awaiting -> authorized -> captured | voided | refunded | failed
  -- cash:   none (guest pays guide; platform invoices guide its commission)
  payment_status TEXT NOT NULL DEFAULT 'none'
    CHECK (payment_status IN ('none','awaiting','authorized','captured','voided','refunded','failed')),
  amount_usd INTEGER NOT NULL DEFAULT 0,
  commission_usd INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  provider_ref TEXT,               -- checkout session id
  provider_payment_id TEXT,        -- payment intent id (set once authorized)
  checkout_url TEXT,               -- so a guest can resume an unfinished payment
  cancelled_by TEXT,               -- 'guest' | 'host'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY,
  experience_id INTEGER NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  contact TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (experience_id, contact)
);
`);

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM hosts').get().c > 0) return;
  const tok = () => crypto.randomBytes(9).toString('base64url');
  const addHost = db.prepare('INSERT INTO hosts (name, whatsapp, bio, token) VALUES (?,?,?,?)');
  const addExp = db.prepare(`INSERT INTO experiences
    (host_id,title,type,region,description,duration_days,price_usd,difficulty,season_start,season_end,includes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const addDep = db.prepare('INSERT INTO departures (experience_id, date, seats_total) VALUES (?,?,?)');

  const h1 = addHost.run('Aibek Toktogulov', '996555000111', 'Certified mountain guide, 12 seasons around Karakol.', 'demo-aibek').lastInsertRowid;
  const h2 = addHost.run('Song-Kul Family Yurts', '996555000222', 'Family-run yurt camp on the north shore of Song-Kul.', tok()).lastInsertRowid;
  const h3 = addHost.run('Nurlan Horse Treks', '996555000333', 'Horse treks with local herders. Kochkor based.', tok()).lastInsertRowid;

  const exps = [
    [h1, 'Ala-Kul Lake Pass Trek', 'trek', 'Karakol', 'Classic 3-day loop over the 3,860 m Ala-Kul pass to the turquoise lake, descending to Altyn-Arashan hot springs.', 3, 180, 'hard', 6, 9, 'Guide, tents, meals, park fees'],
    [h1, 'Jeti-Oguz Day Hike', 'trek', 'Karakol', 'Gentle day hike through the Seven Bulls red cliffs and Valley of Flowers.', 1, 35, 'easy', 5, 10, 'Guide, lunch, transfer'],
    [h2, 'Two Nights at Song-Kul Yurt Camp', 'yurt', 'Song-Kul', 'Sleep in a felt yurt at 3,000 m, eat with a herder family, watch the stars over the lake.', 2, 60, 'easy', 6, 9, 'Yurt bed, 3 meals/day, kumis tasting'],
    [h3, 'Kochkor to Song-Kul Horse Trek', 'horse', 'Song-Kul', 'Ride over the Kilemche jailoo to Song-Kul in 3 days, nights in shepherd yurts.', 3, 210, 'moderate', 6, 9, 'Horse, horseman-guide, yurt nights, meals'],
  ];
  // The yurt camp is cash-only, to demo per-host payment settings.
  const cashOnlyTitle = 'Two Nights at Song-Kul Yurt Camp';
  const nextYear = new Date().getFullYear() + 1;
  for (const e of exps) {
    const id = addExp.run(...e).lastInsertRowid;
    if (e[1] === cashOnlyTitle) db.prepare('UPDATE experiences SET accepts_online = 0 WHERE id = ?').run(id);
    // Weekly departures across the season next year.
    const [start, end] = [e[8], e[9]];
    for (let m = start; m <= end; m++) {
      for (const d of [3, 10, 17, 24]) {
        addDep.run(id, `${nextYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, e[2] === 'yurt' ? 12 : 8);
      }
    }
  }
  console.log('Seeded demo data. Demo host dashboard key: demo-aibek');
}
seed();

module.exports = db;
