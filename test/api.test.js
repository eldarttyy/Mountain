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
  const a = await call('/api/bookings', { method: 'POST', body: { departure_id: dep.id, name: 'A', contact: 'a@x', party_size: 6 } });
  assert.equal(a.status, 201);
  assert.match(a.body.whatsapp_url, /^https:\/\/wa\.me\/\d+\?text=/);
  const b = await call('/api/bookings', { method: 'POST', body: { departure_id: dep.id, name: 'B', contact: 'b@x', party_size: 3 } });
  assert.equal(b.status, 409);
  assert.equal((await firstDeparture()).seats_left, 2);
});

test('concurrent requests never exceed capacity', async () => {
  const dep = (await call('/api/experiences/2')).body.departures[0];
  const reqs = Array.from({ length: 10 }, (_, i) => call('/api/bookings', { method: 'POST', body: { departure_id: dep.id, name: 'C' + i, contact: 'c', party_size: 2 } }));
  const results = await Promise.all(reqs);
  assert.equal(results.filter((r) => r.status === 201).length, 4); // 8 seats / 2
  assert.equal((await call('/api/experiences/2')).body.departures[0].seats_left, 0);
});

test('stale pending holds expire and release seats', async () => {
  const dep = (await call('/api/experiences/3')).body.departures[0];
  const r = await call('/api/bookings', { method: 'POST', body: { departure_id: dep.id, name: 'Old', contact: 'o', party_size: 12 } });
  assert.equal(r.status, 201);
  assert.equal((await call('/api/experiences/3')).body.departures[0].seats_left, 0);
  db.prepare("UPDATE bookings SET created_at = datetime('now','-49 hours') WHERE ref = ?").run(r.body.ref);
  assert.equal((await call('/api/experiences/3')).body.departures[0].seats_left, 12);
  assert.equal((await call('/api/bookings/' + r.body.ref)).body.status, 'expired');
});

test('validation rejects bad input', async () => {
  const dep = await firstDeparture(4);
  for (const body of [{ departure_id: dep.id, name: '', contact: 'x', party_size: 1 }, { departure_id: dep.id, name: 'x', contact: 'x', party_size: 0 }, { departure_id: 99999, name: 'x', contact: 'x', party_size: 1 }]) {
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
