const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const db = require('./db');
const { getProvider, verifyStripeSignature } = require('./payments');

const pay = getProvider();
const app = express();

// Pending requests hold seats, but only for this long. Guides reply slowly in
// the mountains; without expiry, abandoned requests would block a short season.
const HOLD_HOURS = Number(process.env.HOLD_HOURS || 48);
// An online booking whose guest never finishes checkout releases seats after this.
const PAY_WINDOW_MIN = Number(process.env.PAY_WINDOW_MIN || 30);
// Platform commission, taken from online payments or invoiced to the guide for cash.
const COMMISSION_PCT = Number(process.env.COMMISSION_PCT || 12);
const ACTIVE = "('pending','confirmed')";

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v) => (v !== '' && v !== null && Number.isInteger(Number(v)) ? Number(v) : NaN);
const today = () => new Date().toISOString().slice(0, 10);
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); // async errors -> handler
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
const background = (label, p) => Promise.resolve(p).catch((e) => console.error(`[payments] ${label} failed:`, e.message));

const freeCancelUntil = (date, days) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

const seatsLeftSql = `d.seats_total - COALESCE((SELECT SUM(b.party_size) FROM bookings b
  WHERE b.departure_id = d.id AND b.status IN ${ACTIVE}), 0)`;

const inSeason = (e, month) => e.season_start <= e.season_end
  ? month >= e.season_start && month <= e.season_end
  : month >= e.season_start || month <= e.season_end; // wraps year (e.g. ski: 12-3)

// Releases seats from (a) online bookings never paid within PAY_WINDOW_MIN and
// (b) any request the guide left unanswered for HOLD_HOURS. Held card
// authorizations are voided in the background.
function expireStaleHolds() {
  const stale = db.prepare(`SELECT * FROM bookings WHERE status = 'pending' AND (
      (payment_status = 'awaiting' AND created_at < datetime('now', ?)) OR created_at < datetime('now', ?))`)
    .all(`-${PAY_WINDOW_MIN} minutes`, `-${HOLD_HOURS} hours`);
  for (const b of stale) {
    const ps = b.payment_method === 'online' ? 'voided' : 'none';
    db.prepare("UPDATE bookings SET status = 'expired', payment_status = ? WHERE id = ? AND status = 'pending'").run(ps, b.id);
    if (b.payment_status === 'authorized') background('void ' + b.ref, pay.void(b));
    if (b.payment_status === 'awaiting') background('expire checkout ' + b.ref, pay.expireCheckout(b));
  }
}

// ---------- Stripe webhook (needs the raw body, so it goes before express.json) ----------

app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }), ah(async (req, res) => {
  if (pay.name !== 'stripe') return bad(res, 'Stripe not enabled', 404);
  const raw = req.body.toString('utf8');
  if (!verifyStripeSignature(raw, req.get('Stripe-Signature'), process.env.STRIPE_WEBHOOK_SECRET)) return bad(res, 'Bad signature', 400);
  const event = JSON.parse(raw);
  const s = event.data?.object || {};
  const b = s.client_reference_id && db.prepare('SELECT * FROM bookings WHERE ref = ?').get(s.client_reference_id);
  if (b && event.type === 'checkout.session.completed') {
    const r = db.prepare(`UPDATE bookings SET payment_status = 'authorized', provider_payment_id = ?
      WHERE id = ? AND status = 'pending' AND payment_status = 'awaiting'`).run(s.payment_intent, b.id);
    // Paid after the booking already expired/cancelled: release the money at once.
    if (r.changes === 0) {
      await pay.void({ provider_payment_id: s.payment_intent });
      db.prepare("UPDATE bookings SET payment_status = 'voided', provider_payment_id = ? WHERE id = ?").run(s.payment_intent, b.id);
    }
  }
  if (b && event.type === 'checkout.session.expired') {
    db.prepare(`UPDATE bookings SET status = 'expired', payment_status = 'voided'
      WHERE id = ? AND status = 'pending' AND payment_status = 'awaiting'`).run(b.id);
  }
  res.json({ received: true });
}));

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Public API ----------

app.get('/api/config', (_req, res) => res.json({ hold_hours: HOLD_HOURS, pay_window_min: PAY_WINDOW_MIN, provider: pay.name }));

app.get('/api/experiences', (req, res) => {
  expireStaleHolds();
  const { type, region, month } = req.query;
  let rows = db.prepare(`
    SELECT e.*, h.name AS host_name,
      (SELECT MIN(d.date) FROM departures d WHERE d.experience_id = e.id AND d.date >= ? AND ${seatsLeftSql} > 0) AS next_open_date
    FROM experiences e JOIN hosts h ON h.id = e.host_id ORDER BY e.id`).all(today());
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
  e.departures = db.prepare(`SELECT d.id, d.date, d.seats_total, ${seatsLeftSql} AS seats_left
    FROM departures d WHERE d.experience_id = ? AND d.date >= ? ORDER BY d.date`).all(e.id, today());
  for (const d of e.departures) d.free_cancel_until = freeCancelUntil(d.date, e.free_cancel_days);
  e.waitlist_count = db.prepare('SELECT COUNT(*) c FROM waitlist WHERE experience_id = ?').get(e.id).c;
  res.json(e);
});

app.post('/api/bookings', ah(async (req, res) => {
  const departureId = int(req.body.departure_id);
  const party = int(req.body.party_size);
  const name = str(req.body.name, 100);
  const contact = str(req.body.contact, 100);
  const message = str(req.body.message, 1000);
  const method = str(req.body.payment_method, 10);
  if (!departureId || !name || !contact) return bad(res, 'Name, contact and date are required');
  if (!(party >= 1 && party <= 20)) return bad(res, 'Party size must be 1–20');
  if (!['online', 'cash'].includes(method)) return bad(res, 'Choose pay online or pay the guide in cash');

  expireStaleHolds();
  let dep, ref;
  // node:sqlite is synchronous and single-process, so this check+insert is atomic.
  // BEGIN IMMEDIATE keeps it safe if a second process ever shares the DB file.
  db.exec('BEGIN IMMEDIATE');
  try {
    dep = db.prepare(`SELECT d.*, ${seatsLeftSql} AS seats_left, e.title, e.price_usd, e.accepts_online, e.accepts_cash,
        h.whatsapp, h.name AS host_name
      FROM departures d JOIN experiences e ON e.id = d.experience_id JOIN hosts h ON h.id = e.host_id
      WHERE d.id = ?`).get(departureId);
    const fail = (msg, code) => { db.exec('ROLLBACK'); bad(res, msg, code); };
    if (!dep) return fail('Departure not found', 404);
    if (dep.date < today()) return fail('That date has passed');
    if (method === 'online' && !dep.accepts_online) return fail('This guide only accepts cash');
    if (method === 'cash' && !dep.accepts_cash) return fail('This guide only accepts online payment');
    if (dep.seats_left < party) return fail(`Only ${dep.seats_left} seat(s) left on that date`, 409);
    ref = 'PB-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const amount = dep.price_usd * party;
    db.prepare(`INSERT INTO bookings (ref, departure_id, name, contact, party_size, message,
        payment_method, payment_status, amount_usd, commission_usd, provider)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(ref, departureId, name, contact, party, message,
      method, method === 'online' ? 'awaiting' : 'none', amount, Math.round((amount * COMMISSION_PCT) / 100),
      method === 'online' ? pay.name : null);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const out = {
    ref, status: 'pending', payment_method: method, amount_usd: dep.price_usd * party, hold_hours: HOLD_HOURS,
    whatsapp_url: `https://wa.me/${dep.whatsapp}?text=${encodeURIComponent(
      `Hi ${dep.host_name}, I just requested "${dep.title}" on ${dep.date} for ${party} (ref ${ref}). — ${name}`)}`,
  };
  if (method === 'online') {
    try {
      const c = await pay.createCheckout({ ref, title: `${dep.title} — ${dep.date}`, unitCents: dep.price_usd * 100,
        quantity: party, baseUrl: baseUrl(req), expiresMinutes: PAY_WINDOW_MIN });
      db.prepare('UPDATE bookings SET provider_ref = ?, checkout_url = ? WHERE ref = ?').run(c.sessionId, c.url, ref);
      out.checkout_url = c.url;
    } catch (err) {
      console.error('[payments] checkout failed:', err.message);
      db.prepare("UPDATE bookings SET status = 'expired', payment_status = 'failed' WHERE ref = ?").run(ref);
      return bad(res, 'Online payment is unavailable right now — try again or choose cash', 502);
    }
  }
  res.status(201).json(out);
}));

const bookingByRef = (ref) => db.prepare(`SELECT b.*, d.date, e.title, e.id AS experience_id, e.free_cancel_days
  FROM bookings b JOIN departures d ON d.id = b.departure_id JOIN experiences e ON e.id = d.experience_id
  WHERE b.ref = ?`).get(str(ref, 20).toUpperCase());

app.get('/api/bookings/:ref', (req, res) => {
  expireStaleHolds();
  const b = bookingByRef(req.params.ref);
  if (!b) return bad(res, 'Booking not found', 404);
  res.json({
    ref: b.ref, status: b.status, party_size: b.party_size, name: b.name, date: b.date, title: b.title,
    experience_id: b.experience_id, payment_method: b.payment_method, payment_status: b.payment_status,
    amount_usd: b.amount_usd, free_cancel_until: freeCancelUntil(b.date, b.free_cancel_days),
    checkout_url: b.status === 'pending' && b.payment_status === 'awaiting' ? b.checkout_url : null,
  });
});

// Guest cancellation. Proves ownership with the contact they booked with.
app.post('/api/bookings/:ref/cancel', ah(async (req, res) => {
  expireStaleHolds();
  const b = bookingByRef(req.params.ref);
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  if (!b || norm(b.contact) !== norm(req.body.contact)) return bad(res, 'Booking not found for that contact', 404);
  if (!['pending', 'confirmed'].includes(b.status)) return bad(res, `Booking is already ${b.status}`, 409);

  let paymentStatus = b.payment_status, refunded = false;
  if (b.status === 'pending') {
    if (b.payment_status === 'authorized') { await pay.void(b); paymentStatus = 'voided'; }
    if (b.payment_status === 'awaiting') { background('expire checkout ' + b.ref, pay.expireCheckout(b)); paymentStatus = 'voided'; }
  } else if (b.payment_method === 'online' && b.payment_status === 'captured' && today() <= freeCancelUntil(b.date, b.free_cancel_days)) {
    await pay.refund(b); paymentStatus = 'refunded'; refunded = true;
  }
  db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = 'guest', payment_status = ? WHERE id = ?").run(paymentStatus, b.id);
  const late = b.status === 'confirmed' && b.payment_method === 'online' && !refunded;
  res.json({ ok: true, status: 'cancelled', refunded, message: late
    ? 'Cancelled after the free-cancellation deadline — no refund.'
    : b.payment_method === 'online' && b.payment_status !== 'awaiting' ? 'Cancelled. You have not been charged / your payment is refunded.' : 'Cancelled.' });
}));

// Off-season demand capture: the season is short, so collect intent all year.
app.post('/api/experiences/:id/waitlist', (req, res) => {
  const contact = str(req.body.contact, 100);
  if (!contact) return bad(res, 'Contact required');
  const e = db.prepare('SELECT id FROM experiences WHERE id = ?').get(req.params.id);
  if (!e) return bad(res, 'Not found', 404);
  db.prepare('INSERT OR IGNORE INTO waitlist (experience_id, contact) VALUES (?,?)').run(e.id, contact);
  res.status(201).json({ ok: true });
});

// Fake checkout used when PAYMENT_PROVIDER=mock (local dev / demos).
app.post('/api/payments/mock/:ref', (req, res) => {
  if (pay.name !== 'mock') return bad(res, 'Mock payments disabled', 404);
  expireStaleHolds();
  const b = bookingByRef(req.params.ref);
  if (!b || b.status !== 'pending' || b.payment_status !== 'awaiting') return bad(res, 'This booking is not awaiting payment', 409);
  if (req.body.outcome === 'fail') return bad(res, 'Card declined (simulated). Try again.', 402);
  db.prepare("UPDATE bookings SET payment_status = 'authorized', provider_payment_id = ? WHERE id = ?").run('mock_pi_' + b.ref, b.id);
  res.json({ ok: true });
});

// ---------- Host API (auth: X-Host-Key header) ----------

function hostAuth(req, res, next) {
  const host = db.prepare('SELECT id, name, whatsapp, bio FROM hosts WHERE token = ?').get(req.get('X-Host-Key') || '');
  if (!host) return bad(res, 'Invalid host key', 401);
  req.owner = host; // (req.host is a read-only Express getter)
  next();
}

const ownsExperience = (hostId, expId) =>
  db.prepare('SELECT * FROM experiences WHERE id = ? AND host_id = ?').get(expId, hostId);

app.get('/api/host/me', hostAuth, (req, res) => {
  expireStaleHolds();
  const experiences = db.prepare('SELECT * FROM experiences WHERE host_id = ? ORDER BY id').all(req.owner.id);
  for (const e of experiences) {
    e.departures = db.prepare(`SELECT d.id, d.date, d.seats_total, ${seatsLeftSql} AS seats_left
      FROM departures d WHERE d.experience_id = ? ORDER BY d.date`).all(e.id);
    e.waitlist = db.prepare('SELECT contact, created_at FROM waitlist WHERE experience_id = ? ORDER BY id DESC').all(e.id);
  }
  const bookings = db.prepare(`SELECT b.id, b.ref, b.name, b.contact, b.party_size, b.message, b.status, b.payment_method,
      b.payment_status, b.amount_usd, b.commission_usd, b.created_at, d.date, e.title FROM bookings b
    JOIN departures d ON d.id = b.departure_id JOIN experiences e ON e.id = d.experience_id
    WHERE e.host_id = ? ORDER BY (b.status = 'pending') DESC, d.date`).all(req.owner.id);
  // Booking.com-style balance: online money flows platform -> guide (minus commission);
  // cash money flows guest -> guide, and the guide owes the platform its commission.
  const earnings = { payout_due_usd: 0, commission_due_usd: 0, commission_pct: COMMISSION_PCT };
  for (const b of bookings) {
    if (b.payment_method === 'online' && b.payment_status === 'captured') earnings.payout_due_usd += b.amount_usd - b.commission_usd;
    if (b.payment_method === 'cash' && b.status === 'confirmed') earnings.commission_due_usd += b.commission_usd;
  }
  res.json({ host: req.owner, experiences, bookings, earnings, hold_hours: HOLD_HOURS });
});

app.post('/api/host/bookings/:id/:action', hostAuth, ah(async (req, res) => {
  const action = req.params.action;
  if (!['confirm', 'decline', 'cancel'].includes(action)) return bad(res, 'Unknown action');
  expireStaleHolds();
  const b = db.prepare(`SELECT b.* FROM bookings b JOIN departures d ON d.id = b.departure_id
    JOIN experiences e ON e.id = d.experience_id WHERE b.id = ? AND e.host_id = ?`).get(req.params.id, req.owner.id);
  if (!b) return bad(res, 'Booking not found', 404);
  const from = action === 'cancel' ? 'confirmed' : 'pending';
  if (b.status !== from) return bad(res, `Cannot ${action} a ${b.status} booking`, 409);

  let status, ps = b.payment_status;
  const online = b.payment_method === 'online';
  if (action === 'confirm') {
    if (online && b.payment_status !== 'authorized') return bad(res, "Guest hasn't completed online payment yet", 409);
    if (online) { await pay.capture(b); ps = 'captured'; }
    status = 'confirmed';
  } else if (action === 'decline') {
    if (b.payment_status === 'authorized') await pay.void(b);
    if (b.payment_status === 'awaiting') background('expire checkout ' + b.ref, pay.expireCheckout(b));
    if (online) ps = 'voided';
    status = 'declined';
  } else {
    // Guide cancels a confirmed trip: guest always gets a full refund.
    if (online && b.payment_status === 'captured') { await pay.refund(b); ps = 'refunded'; }
    status = 'cancelled';
  }
  db.prepare(`UPDATE bookings SET status = ?, payment_status = ?, cancelled_by = CASE WHEN ? = 'cancelled' THEN 'host' ELSE cancelled_by END
    WHERE id = ?`).run(status, ps, status, b.id);
  res.json({ ok: true, status, payment_status: ps });
}));

function paymentSettings(body, current = {}) {
  const flag = (v, d) => (v === undefined ? d : v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0);
  const s = {
    accepts_online: flag(body.accepts_online, current.accepts_online ?? 1),
    accepts_cash: flag(body.accepts_cash, current.accepts_cash ?? 1),
    free_cancel_days: body.free_cancel_days === undefined ? current.free_cancel_days ?? 7 : int(body.free_cancel_days),
  };
  if (!s.accepts_online && !s.accepts_cash) return { error: 'Accept at least one payment method' };
  if (!(s.free_cancel_days >= 0 && s.free_cancel_days <= 90)) return { error: 'Free cancellation must be 0–90 days' };
  return s;
}

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
  if (!(f.price_usd >= 1)) return bad(res, 'Price must be at least $1');
  if (![f.season_start, f.season_end].every((m) => m >= 1 && m <= 12)) return bad(res, 'Season months must be 1–12');
  const p = paymentSettings(b); // missing fields default to: both methods accepted, 7-day free cancel
  if (p.error) return bad(res, p.error);
  const r = db.prepare(`INSERT INTO experiences (host_id,title,type,region,description,duration_days,price_usd,difficulty,
      season_start,season_end,includes,accepts_online,accepts_cash,free_cancel_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.owner.id, f.title, f.type, f.region, f.description, f.duration_days, f.price_usd, f.difficulty,
      f.season_start, f.season_end, f.includes, p.accepts_online, p.accepts_cash, p.free_cancel_days);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.patch('/api/host/experiences/:id', hostAuth, (req, res) => {
  const e = ownsExperience(req.owner.id, req.params.id);
  if (!e) return bad(res, 'Experience not found', 404);
  const p = paymentSettings(req.body, e);
  if (p.error) return bad(res, p.error);
  db.prepare('UPDATE experiences SET accepts_online = ?, accepts_cash = ?, free_cancel_days = ? WHERE id = ?')
    .run(p.accepts_online, p.accepts_cash, p.free_cancel_days, e.id);
  res.json({ ok: true, ...p });
});

app.post('/api/host/experiences/:id/departures', hostAuth, (req, res) => {
  if (!ownsExperience(req.owner.id, req.params.id)) return bad(res, 'Experience not found', 404);
  const date = str(req.body.date, 10);
  const seats = int(req.body.seats_total);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) return bad(res, 'Invalid date');
  if (date < today()) return bad(res, 'Date is in the past');
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
  res.status(err.message?.startsWith('Stripe') ? 502 : 500).json({ error: err.message?.startsWith('Stripe') ? 'Payment provider error — please retry' : 'Server error' });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) app.listen(PORT, () => console.log(`PeakBook on http://localhost:${PORT} (payments: ${pay.name})`));
module.exports = app;
