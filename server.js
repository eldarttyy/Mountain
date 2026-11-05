const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Pending requests hold seats, but only for this long. Guides reply slowly in
// the mountains; without expiry, abandoned requests would block a short season.
const HOLD_HOURS = Number(process.env.HOLD_HOURS || 48);
const ACTIVE = "('pending','confirmed')";

function expireStaleHolds() {
  db.prepare(`UPDATE bookings SET status='expired'
    WHERE status='pending' AND created_at < datetime('now', ?)`).run(`-${HOLD_HOURS} hours`);
}

const seatsLeftSql = `d.seats_total - COALESCE((SELECT SUM(b.party_size) FROM bookings b
  WHERE b.departure_id = d.id AND b.status IN ${ACTIVE}), 0)`;

const inSeason = (e, month) => e.season_start <= e.season_end
  ? month >= e.season_start && month <= e.season_end
  : month >= e.season_start || month <= e.season_end; // wraps year (e.g. ski: 12-3)

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : NaN);

// ---------- Public API ----------

app.get('/api/experiences', (req, res) => {
  expireStaleHolds();
  const { type, region, month } = req.query;
  const today = new Date().toISOString().slice(0, 10);
  let rows = db.prepare(`
    SELECT e.*, h.name AS host_name,
      (SELECT MIN(d.date) FROM departures d WHERE d.experience_id = e.id AND d.date >= ? AND ${seatsLeftSql} > 0) AS next_open_date
    FROM experiences e JOIN hosts h ON h.id = e.host_id ORDER BY e.id`).all(today);
  if (type) rows = rows.filter((r) => r.type === type);
  if (region) rows = rows.filter((r) => r.region === region);
  if (month) rows = rows.filter((r) => inSeason(r, Number(month)));
  const currentMonth = new Date().getMonth() + 1;
  res.json(rows.map((r) => ({ ...r, in_season_now: inSeason(r, currentMonth) })));
});

app.get('/api/regions', (_req, res) => {
  res.json(db.prepare('SELECT DISTINCT region FROM experiences ORDER BY region').all().map((r) => r.region));
});

app.get('/api/experiences/:id', (req, res) => {
  expireStaleHolds();
  const e = db.prepare(`SELECT e.*, h.name AS host_name, h.bio AS host_bio
    FROM experiences e JOIN hosts h ON h.id = e.host_id WHERE e.id = ?`).get(req.params.id);
  if (!e) return bad(res, 'Not found', 404);
  const today = new Date().toISOString().slice(0, 10);
  e.departures = db.prepare(`SELECT d.id, d.date, d.seats_total, ${seatsLeftSql} AS seats_left
    FROM departures d WHERE d.experience_id = ? AND d.date >= ? ORDER BY d.date`).all(e.id, today);
  e.waitlist_count = db.prepare('SELECT COUNT(*) c FROM waitlist WHERE experience_id = ?').get(e.id).c;
  res.json(e);
});

app.post('/api/bookings', (req, res) => {
  const departureId = int(req.body.departure_id);
  const party = int(req.body.party_size);
  const name = str(req.body.name, 100);
  const contact = str(req.body.contact, 100);
  const message = str(req.body.message, 1000);
  if (!departureId || !name || !contact) return bad(res, 'Name, contact and date are required');
  if (!(party >= 1 && party <= 20)) return bad(res, 'Party size must be 1–20');

  expireStaleHolds();
  // node:sqlite is synchronous and single-process, so this check+insert is atomic.
  // BEGIN IMMEDIATE keeps it safe if a second process ever shares the DB file.
  db.exec('BEGIN IMMEDIATE');
  try {
    const dep = db.prepare(`SELECT d.*, ${seatsLeftSql} AS seats_left, e.title, h.whatsapp, h.name AS host_name
      FROM departures d JOIN experiences e ON e.id = d.experience_id JOIN hosts h ON h.id = e.host_id
      WHERE d.id = ?`).get(departureId);
    if (!dep) { db.exec('ROLLBACK'); return bad(res, 'Departure not found', 404); }
    if (dep.date < new Date().toISOString().slice(0, 10)) { db.exec('ROLLBACK'); return bad(res, 'That date has passed'); }
    if (dep.seats_left < party) { db.exec('ROLLBACK'); return bad(res, `Only ${dep.seats_left} seat(s) left on that date`, 409); }
    const ref = 'PB-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    db.prepare(`INSERT INTO bookings (ref, departure_id, name, contact, party_size, message)
      VALUES (?,?,?,?,?,?)`).run(ref, departureId, name, contact, party, message);
    db.exec('COMMIT');
    const text = `Hi ${dep.host_name}, I just requested "${dep.title}" on ${dep.date} for ${party} (ref ${ref}). — ${name}`;
    res.status(201).json({
      ref, status: 'pending', hold_hours: HOLD_HOURS,
      whatsapp_url: `https://wa.me/${dep.whatsapp}?text=${encodeURIComponent(text)}`,
    });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

app.get('/api/bookings/:ref', (req, res) => {
  expireStaleHolds();
  const b = db.prepare(`SELECT b.ref, b.status, b.party_size, b.name, d.date, e.title, e.id AS experience_id
    FROM bookings b JOIN departures d ON d.id = b.departure_id JOIN experiences e ON e.id = d.experience_id
    WHERE b.ref = ?`).get(str(req.params.ref, 20).toUpperCase());
  if (!b) return bad(res, 'Booking not found', 404);
  res.json(b);
});

// Off-season demand capture: the season is short, so collect intent all year.
app.post('/api/experiences/:id/waitlist', (req, res) => {
  const contact = str(req.body.contact, 100);
  if (!contact) return bad(res, 'Contact required');
  const e = db.prepare('SELECT id FROM experiences WHERE id = ?').get(req.params.id);
  if (!e) return bad(res, 'Not found', 404);
  db.prepare('INSERT OR IGNORE INTO waitlist (experience_id, contact) VALUES (?,?)').run(e.id, contact);
  res.status(201).json({ ok: true });
});

// ---------- Host API (auth: X-Host-Key header) ----------

function hostAuth(req, res, next) {
  const host = db.prepare('SELECT id, name, whatsapp, bio FROM hosts WHERE token = ?').get(req.get('X-Host-Key') || '');
  if (!host) return bad(res, 'Invalid host key', 401);
  req.owner = host;
  next();
}

const ownsExperience = (hostId, expId) =>
  db.prepare('SELECT 1 FROM experiences WHERE id = ? AND host_id = ?').get(expId, hostId);

app.get('/api/host/me', hostAuth, (req, res) => {
  expireStaleHolds();
  const experiences = db.prepare('SELECT * FROM experiences WHERE host_id = ? ORDER BY id').all(req.owner.id);
  for (const e of experiences) {
    e.departures = db.prepare(`SELECT d.id, d.date, d.seats_total, ${seatsLeftSql} AS seats_left
      FROM departures d WHERE d.experience_id = ? ORDER BY d.date`).all(e.id);
    e.waitlist = db.prepare('SELECT contact, created_at FROM waitlist WHERE experience_id = ? ORDER BY id DESC').all(e.id);
  }
  const bookings = db.prepare(`SELECT b.*, d.date, e.title FROM bookings b
    JOIN departures d ON d.id = b.departure_id JOIN experiences e ON e.id = d.experience_id
    WHERE e.host_id = ? ORDER BY (b.status = 'pending') DESC, d.date`).all(req.owner.id);
  res.json({ host: req.owner, experiences, bookings, hold_hours: HOLD_HOURS });
});

app.post('/api/host/bookings/:id/:action', hostAuth, (req, res) => {
  const next = { confirm: 'confirmed', decline: 'declined', cancel: 'cancelled' }[req.params.action];
  if (!next) return bad(res, 'Unknown action');
  expireStaleHolds();
  const b = db.prepare(`SELECT b.id, b.status FROM bookings b JOIN departures d ON d.id = b.departure_id
    JOIN experiences e ON e.id = d.experience_id WHERE b.id = ? AND e.host_id = ?`).get(req.params.id, req.owner.id);
  if (!b) return bad(res, 'Booking not found', 404);
  const allowed = { confirmed: ['pending'], declined: ['pending'], cancelled: ['confirmed'] }[next];
  if (!allowed.includes(b.status)) return bad(res, `Cannot ${req.params.action} a ${b.status} booking`, 409);
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(next, b.id);
  res.json({ ok: true, status: next });
});

app.post('/api/host/experiences', hostAuth, (req, res) => {
  const b = req.body;
  const f = {
    title: str(b.title, 120), type: str(b.type, 10), region: str(b.region, 60), description: str(b.description, 3000),
    duration_days: int(b.duration_days), price_usd: int(b.price_usd), difficulty: str(b.difficulty, 10),
    season_start: int(b.season_start), season_end: int(b.season_end), includes: str(b.includes, 500),
  };
  if (!f.title || !f.region || !f.description) return bad(res, 'Title, region and description are required');
  if (!['trek', 'yurt', 'horse', 'climb'].includes(f.type)) return bad(res, 'Invalid type');
  if (!['easy', 'moderate', 'hard'].includes(f.difficulty)) return bad(res, 'Invalid difficulty');
  if (!(f.duration_days >= 1 && f.duration_days <= 60)) return bad(res, 'Duration must be 1–60 days');
  if (!(f.price_usd >= 0)) return bad(res, 'Invalid price');
  if (![f.season_start, f.season_end].every((m) => m >= 1 && m <= 12)) return bad(res, 'Season months must be 1–12');
  const r = db.prepare(`INSERT INTO experiences (host_id,title,type,region,description,duration_days,price_usd,difficulty,season_start,season_end,includes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.owner.id, f.title, f.type, f.region, f.description, f.duration_days,
    f.price_usd, f.difficulty, f.season_start, f.season_end, f.includes);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.post('/api/host/experiences/:id/departures', hostAuth, (req, res) => {
  if (!ownsExperience(req.owner.id, req.params.id)) return bad(res, 'Experience not found', 404);
  const date = str(req.body.date, 10);
  const seats = int(req.body.seats_total);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) return bad(res, 'Invalid date');
  if (date < new Date().toISOString().slice(0, 10)) return bad(res, 'Date is in the past');
  if (!(seats >= 1 && seats <= 100)) return bad(res, 'Seats must be 1–100');
  try {
    db.prepare('INSERT INTO departures (experience_id, date, seats_total) VALUES (?,?,?)').run(req.params.id, date, seats);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(res, 'A departure already exists on that date', 409);
    throw e;
  }
  res.status(201).json({ ok: true });
});

app.delete('/api/host/departures/:id', hostAuth, (req, res) => {
  const d = db.prepare(`SELECT d.id, (SELECT COUNT(*) FROM bookings b WHERE b.departure_id = d.id AND b.status IN ${ACTIVE}) AS active
    FROM departures d JOIN experiences e ON e.id = d.experience_id WHERE d.id = ? AND e.host_id = ?`).get(req.params.id, req.owner.id);
  if (!d) return bad(res, 'Departure not found', 404);
  if (d.active > 0) return bad(res, 'Departure has active bookings — decline or cancel them first', 409);
  db.prepare('DELETE FROM departures WHERE id = ?').run(d.id);
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) app.listen(PORT, () => console.log(`PeakBook on http://localhost:${PORT}`));
module.exports = app;
