const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const app = require('../server');
const db = require('../db');

let base, server;
before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (p, { method = 'GET', body, key } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Host-Key': key } : {}) }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const firstDeparture = async (expId = 1) => (await call('/api/experiences/' + expId)).body.departures[0];

test('lists seeded experiences with next open date', async () => {
  const r = await call('/api/experiences');
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 4);
  assert.ok(r.body[0].next_open_date);
});

test('month filter respects season', async () => {
  const jan = await call('/api/experiences?month=1');
  assert.equal(jan.body.length, 0);
  const jul = await call('/api/experiences?month=7');
  assert.ok(jul.body.length >= 4);
});

test('booking holds seats and prevents overbooking', async () => {
  const dep = await firstDeparture();
  assert.equal(dep.seats_left, 8);
  const a = await call('/api/bookings', { method: 'POST', body: { departure_id: dep.id, name: 'A', contact: 'a@x', party_size: 6, payment_method: 'cash' } });
  assert.equal(a.status, 201);
  assert.match(a.body.whatsapp_url, /^https:\/\/wa\.me\/\d+\?text=/);
  const b = await call('/api/bookings', { method: 'POST', body: { departure_id: dep.id, name: 'B', contact: 'b@x', party_size: 3, payment_method: 'cash' } });
  assert.equal(b.status, 409);
  assert.equal((await firstDeparture()).seats_left, 2);
});

test('concurrent requests never exceed capacity', async () => {
  const dep = (await call('/api/experiences/2')).body.departures[0];
  const reqs = Array.from({ length: 10 }, (_, i) => call('/api/bookings', { method: 'POST', body: { departure_id: dep.id, name: 'C' + i, contact: 'c', party_size: 2, payment_method: 'cash' } }));
  const results = await Promise.all(reqs);
  assert.equal(results.filter((r) => r.status === 201).length, 4); // 8 seats / 2
  assert.equal((await call('/api/experiences/2')).body.departures[0].seats_left, 0);
});

test('stale pending holds expire and release seats', async () => {
  const dep = (await call('/api/experiences/3')).body.departures[0];
  const r = await call('/api/bookings', { method: 'POST', body: { departure_id: dep.id, name: 'Old', contact: 'o', party_size: 12, payment_method: 'cash' } });
  assert.equal(r.status, 201);
  assert.equal((await call('/api/experiences/3')).body.departures[0].seats_left, 0);
  db.prepare("UPDATE bookings SET created_at = datetime('now','-49 hours') WHERE ref = ?").run(r.body.ref);
  assert.equal((await call('/api/experiences/3')).body.departures[0].seats_left, 12);
  assert.equal((await call('/api/bookings/' + r.body.ref)).body.status, 'expired');
});

test('validation rejects bad input', async () => {
  const dep = await firstDeparture(4);
  for (const body of [{ departure_id: dep.id, name: '', contact: 'x', party_size: 1, payment_method: 'cash' }, { departure_id: dep.id, name: 'x', contact: 'x', party_size: 0, payment_method: 'cash' }, { departure_id: 99999, name: 'x', contact: 'x', party_size: 1, payment_method: 'cash' }]) {
    assert.ok([400, 404].includes((await call('/api/bookings', { method: 'POST', body })).status));
  }
});

test('host auth and ownership enforced', async () => {
  assert.equal((await call('/api/host/me')).status, 401);
  assert.equal((await call('/api/host/me', { key: 'nope' })).status, 401);
  const me = await call('/api/host/me', { key: 'demo-aibek' });
  assert.equal(me.status, 200);
  assert.ok(me.body.experiences.every((e) => e.host_id === me.body.host.id));
  // Aibek cannot add dates to another host's experience (id 3 = yurt camp).
  assert.equal((await call('/api/host/experiences/3/departures', { method: 'POST', key: 'demo-aibek', body: { date: '2099-07-01', seats_total: 5 } })).status, 404);
  // Cannot act on other host's booking.
  const other = db.prepare("SELECT b.id FROM bookings b JOIN departures d ON d.id=b.departure_id WHERE d.experience_id=3 LIMIT 1").get();
  assert.equal((await call(`/api/host/bookings/${other.id}/confirm`, { method: 'POST', key: 'demo-aibek' })).status, 404);
});

test('host confirm flow and state transitions', async () => {
  const pending = (await call('/api/host/me', { key: 'demo-aibek' })).body.bookings.find((b) => b.status === 'pending');
  assert.equal((await call(`/api/host/bookings/${pending.id}/confirm`, { method: 'POST', key: 'demo-aibek' })).status, 200);
  assert.equal((await call(`/api/host/bookings/${pending.id}/decline`, { method: 'POST', key: 'demo-aibek' })).status, 409);
  assert.equal((await call(`/api/host/bookings/${pending.id}/cancel`, { method: 'POST', key: 'demo-aibek' })).status, 200);
});

test('cannot delete departure with active bookings', async () => {
  const dep = await firstDeparture(2);
  assert.equal((await call('/api/host/departures/' + dep.id, { method: 'DELETE', key: 'demo-aibek' })).status, 409);
});

test('host can create experience and add departure; waitlist dedupes', async () => {
  const r = await call('/api/host/experiences', { method: 'POST', key: 'demo-aibek', body: { title: 'Peak Lenin Acclim', type: 'climb', region: 'Alay', description: 'x', duration_days: 7, price_usd: 900, difficulty: 'hard', season_start: 7, season_end: 8 } });
  assert.equal(r.status, 201);
  assert.equal((await call(`/api/host/experiences/${r.body.id}/departures`, { method: 'POST', key: 'demo-aibek', body: { date: '2099-07-10', seats_total: 6 } })).status, 201);
  assert.equal((await call(`/api/host/experiences/${r.body.id}/departures`, { method: 'POST', key: 'demo-aibek', body: { date: '2099-07-10', seats_total: 6 } })).status, 409);
  await call(`/api/experiences/${r.body.id}/waitlist`, { method: 'POST', body: { contact: 'w@x' } });
  await call(`/api/experiences/${r.body.id}/waitlist`, { method: 'POST', body: { contact: 'w@x' } });
  assert.equal((await call('/api/experiences/' + r.body.id)).body.waitlist_count, 1);
});

// ---------- Payments ----------
const { verifyStripeSignature } = require('../payments');
const crypto = require('node:crypto');
const K = 'demo-aibek';
const addDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const book = (departure_id, extra = {}) => call('/api/bookings', { method: 'POST', body: { departure_id, name: 'P', contact: 'p@x.com', party_size: 2, payment_method: 'online', ...extra } });
const hostBooking = async (ref) => (await call('/api/host/me', { key: K })).body.bookings.find((b) => b.ref === ref);
const earnings = async () => (await call('/api/host/me', { key: K })).body.earnings;

test('online: authorize at checkout, capture only on guide confirm, payout net of commission', async () => {
  const dep = (await call('/api/experiences/1')).body.departures[1];
  const before = await earnings();
  const r = await book(dep.id);
  assert.equal(r.status, 201);
  assert.equal(r.body.amount_usd, 360);
  assert.match(r.body.checkout_url, /#\/pay\/PB-/);
  const hb = await hostBooking(r.body.ref);
  assert.equal(hb.payment_status, 'awaiting');
  assert.equal((await call(`/api/host/bookings/${hb.id}/confirm`, { method: 'POST', key: K })).status, 409, 'cannot confirm unpaid');
  assert.equal((await call('/api/payments/mock/' + r.body.ref, { method: 'POST', body: { outcome: 'fail' } })).status, 402);
  assert.equal((await call('/api/payments/mock/' + r.body.ref, { method: 'POST', body: { outcome: 'success' } })).status, 200);
  assert.equal((await call('/api/bookings/' + r.body.ref)).body.payment_status, 'authorized');
  assert.equal((await call('/api/payments/mock/' + r.body.ref, { method: 'POST', body: {} })).status, 409, 'no double pay');
  const c = await call(`/api/host/bookings/${hb.id}/confirm`, { method: 'POST', key: K });
  assert.equal(c.body.payment_status, 'captured');
  assert.equal((await earnings()).payout_due_usd - before.payout_due_usd, 360 - Math.round(360 * 0.12));
});

test('cash-only experience rejects online payment; missing method rejected', async () => {
  const dep = (await call('/api/experiences/3')).body.departures[1];
  assert.equal((await book(dep.id)).status, 400);
  assert.equal((await book(dep.id, { payment_method: undefined })).status, 400);
  assert.equal((await book(dep.id, { payment_method: 'cash' })).status, 201);
});

test('unpaid online booking releases seats after the payment window', async () => {
  const dep = (await call('/api/experiences/4')).body.departures[2];
  const r = await book(dep.id, { party_size: 8 });
  assert.equal((await call('/api/experiences/4')).body.departures[2].seats_left, 0);
  db.prepare("UPDATE bookings SET created_at = datetime('now','-31 minutes') WHERE ref = ?").run(r.body.ref);
  assert.equal((await call('/api/experiences/4')).body.departures[2].seats_left, 8);
  const b = (await call('/api/bookings/' + r.body.ref)).body;
  assert.equal(b.status, 'expired');
  assert.equal(b.checkout_url, null);
  assert.equal((await call('/api/payments/mock/' + r.body.ref, { method: 'POST', body: {} })).status, 409, 'cannot pay an expired booking');
});

test('guide decline voids the card hold', async () => {
  const dep = (await call('/api/experiences/1')).body.departures[2];
  const r = await book(dep.id);
  await call('/api/payments/mock/' + r.body.ref, { method: 'POST', body: {} });
  const hb = await hostBooking(r.body.ref);
  const d = await call(`/api/host/bookings/${hb.id}/decline`, { method: 'POST', key: K });
  assert.equal(d.body.payment_status, 'voided');
});

test('guest cancel: refund before deadline, no refund after, contact must match', async () => {
  const pay = async (depId) => {
    const r = await book(depId);
    await call('/api/payments/mock/' + r.body.ref, { method: 'POST', body: {} });
    await call(`/api/host/bookings/${(await hostBooking(r.body.ref)).id}/confirm`, { method: 'POST', key: K });
    return r.body.ref;
  };
  const early = await pay((await call('/api/experiences/1')).body.departures[3].id);
  assert.equal((await call(`/api/bookings/${early}/cancel`, { method: 'POST', body: { contact: 'someone@else' } })).status, 404);
  const ce = await call(`/api/bookings/${early}/cancel`, { method: 'POST', body: { contact: ' P@X.com ' } });
  assert.equal(ce.body.refunded, true);
  assert.equal((await call('/api/bookings/' + early)).body.payment_status, 'refunded');
  assert.equal((await call(`/api/bookings/${early}/cancel`, { method: 'POST', body: { contact: 'p@x.com' } })).status, 409);

  // A trip in 2 days with a 7-day free-cancel window: late cancellation.
  const date = addDays(2);
  await call('/api/host/experiences/1/departures', { method: 'POST', key: K, body: { date, seats_total: 8 } });
  const soonDep = (await call('/api/experiences/1')).body.departures.find((d) => d.date === date);
  const late = await pay(soonDep.id);
  const before = await earnings();
  const cl = await call(`/api/bookings/${late}/cancel`, { method: 'POST', body: { contact: 'p@x.com' } });
  assert.equal(cl.body.refunded, false);
  assert.equal((await call('/api/bookings/' + late)).body.payment_status, 'captured');
  assert.equal((await earnings()).payout_due_usd, before.payout_due_usd, 'guide still paid for late cancellation');
});

test('guide cancelling a confirmed online trip always refunds', async () => {
  const r = await book((await call('/api/experiences/1')).body.departures[4].id);
  await call('/api/payments/mock/' + r.body.ref, { method: 'POST', body: {} });
  const id = (await hostBooking(r.body.ref)).id;
  await call(`/api/host/bookings/${id}/confirm`, { method: 'POST', key: K });
  assert.equal((await call(`/api/host/bookings/${id}/cancel`, { method: 'POST', key: K })).body.payment_status, 'refunded');
});

test('cash bookings accrue commission owed by guide when confirmed', async () => {
  const before = await earnings();
  const r = await book((await call('/api/experiences/2')).body.departures[5].id, { payment_method: 'cash', party_size: 4 });
  await call(`/api/host/bookings/${(await hostBooking(r.body.ref)).id}/confirm`, { method: 'POST', key: K });
  assert.equal((await earnings()).commission_due_usd - before.commission_due_usd, Math.round(140 * 0.12));
});

test('payment settings: guide can switch to cash-only; cannot disable both', async () => {
  assert.equal((await call('/api/host/experiences/2', { method: 'PATCH', key: K, body: { accepts_online: false, accepts_cash: false } })).status, 400);
  assert.equal((await call('/api/host/experiences/2', { method: 'PATCH', key: K, body: { accepts_online: false, free_cancel_days: 3 } })).status, 200);
  const e = (await call('/api/experiences/2')).body;
  assert.equal(e.accepts_online, 0);
  assert.equal(e.accepts_cash, 1);
  assert.equal((await book(e.departures[6].id)).status, 400);
});

test('stripe webhook signature verification', () => {
  const secret = 'whsec_test', body = '{"a":1}', t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret), true);
  assert.equal(verifyStripeSignature(body + ' ', `t=${t},v1=${sig}`, secret), false);
  assert.equal(verifyStripeSignature(body, `t=${t - 1000},v1=${sig}`, secret), false);
  assert.equal(verifyStripeSignature(body, '', secret), false);
});
