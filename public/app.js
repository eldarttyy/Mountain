const $app = document.getElementById('app');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TYPES = { trek: 'Trek', yurt: 'Yurt stay', horse: 'Horse trek', climb: 'Climb' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const season = (e) => `${MONTHS[e.season_start - 1]}–${MONTHS[e.season_end - 1]}`;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const msg = (text, kind = 'ok') => `<div class="msg ${kind}">${esc(text)}</div>`;

// ---------- Explore ----------
async function explore(params) {
  const [regions, list] = await Promise.all([api('/api/regions'), api('/api/experiences?' + params)]);
  const q = Object.fromEntries(params);
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === (cur || '') ? 'selected' : ''}>${esc(label)}</option>`;
  $app.innerHTML = `
    <h1>Mountain experiences, booked direct with local guides</h1>
    <p class="muted">Treks, yurt camps and horse trips. Request a date, the guide confirms within ${48} hours.</p>
    <div class="filters">
      <select id="f-type">${opt('', 'All types', q.type)}${Object.entries(TYPES).map(([k, v]) => opt(k, v, q.type)).join('')}</select>
      <select id="f-region">${opt('', 'All regions', q.region)}${regions.map((r) => opt(r, r, q.region)).join('')}</select>
      <select id="f-month">${opt('', 'Any month', q.month)}${MONTHS.map((m, i) => opt(String(i + 1), m, q.month)).join('')}</select>
    </div>
    ${list.length ? '' : '<p class="muted">Nothing matches — nothing runs in that month, or try another region.</p>'}
    <div class="grid">${list.map(card).join('')}</div>`;
  for (const id of ['type', 'region', 'month']) {
    document.getElementById('f-' + id).onchange = () => {
      const p = new URLSearchParams();
      for (const k of ['type', 'region', 'month']) { const v = document.getElementById('f-' + k).value; if (v) p.set(k, v); }
      location.hash = '#/?' + p;
    };
  }
}

function card(e) {
  const next = e.next_open_date ? `Next open: ${fmtDate(e.next_open_date)}` : 'No open dates — join waitlist';
  return `<div class="card">
    <a class="title" href="#/x/${e.id}">${esc(e.title)}</a>
    <div class="tags"><span class="tag">${TYPES[e.type]}</span><span class="tag">${esc(e.region)}</span>
      <span class="tag">${e.duration_days} day${e.duration_days > 1 ? 's' : ''}</span><span class="tag">${e.difficulty}</span>
      <span class="tag ${e.in_season_now ? '' : 'off'}">${e.in_season_now ? 'In season' : 'Season ' + season(e)}</span></div>
    <div class="row" style="justify-content:space-between"><span class="price">$${e.price_usd} <span class="muted small">/ person</span></span>
      <span class="small muted">${next}</span></div>
    <div class="small muted">with ${esc(e.host_name)}</div></div>`;
}

// ---------- Experience detail + booking ----------
async function detail(id) {
  const e = await api('/api/experiences/' + id);
  const open = e.departures.filter((d) => d.seats_left > 0);
  let sel = null;
  $app.innerHTML = `
    <a href="#/">← All experiences</a>
    <h1>${esc(e.title)}</h1>
    <div class="tags"><span class="tag">${TYPES[e.type]}</span><span class="tag">${esc(e.region)}</span>
      <span class="tag">${e.duration_days} days</span><span class="tag">${e.difficulty}</span><span class="tag">Season ${season(e)}</span></div>
    <p>${esc(e.description)}</p>
    ${e.includes ? `<p class="small"><b>Includes:</b> ${esc(e.includes)}</p>` : ''}
    <p class="small muted">Hosted by <b>${esc(e.host_name)}</b> — ${esc(e.host_bio)}</p>
    <p class="price">$${e.price_usd} per person · ${[e.accepts_online && "pay online", e.accepts_cash && "cash to guide"].filter(Boolean).join(" or ")}</p>

    <h2>Choose a date</h2>
    ${open.length ? `<div class="dates">${e.departures.map((d) => `<button class="date" data-id="${d.id}" ${d.seats_left ? '' : 'disabled'}>
      ${fmtDate(d.date)}<small>${d.seats_left ? d.seats_left + ' seats left' : 'Full'}</small></button>`).join('')}</div>`
      : '<p class="muted">No open dates right now.</p>'}

    <div id="book" style="display:none">
      <h2>Request to book</h2>
      <form class="form" id="bf">
        <label>Your name <input name="name" required maxlength="100"></label>
        <label>WhatsApp or email <input name="contact" required maxlength="100"></label>
        <label>People <input name="party_size" type="number" min="1" value="2" required></label>
        <label>Message to guide (optional) <textarea name="message" maxlength="1000" placeholder="Experience level, dietary needs, pickup..."></textarea></label>
        <fieldset class="pay">
          <legend>How do you want to pay? <span class="price" id="total"></span></legend>
          ${e.accepts_online ? `<label class="opt"><input type="radio" name="payment_method" value="online" checked>
            <span><b>Pay now online</b><br><span class="small muted">Card is only charged when the guide confirms.
            Free cancellation until <span class="fcu"></span>.</span></span></label>` : ''}
          ${e.accepts_cash ? `<label class="opt"><input type="radio" name="payment_method" value="cash" ${e.accepts_online ? '' : 'checked'}>
            <span><b>Pay the guide in cash</b><br><span class="small muted">No prepayment. Pay on the day of the trip.</span></span></label>` : ''}
        </fieldset>
        <button id="submit">Send request</button>
      </form>
    </div>
    <div id="out"></div>

    <h2>Not this season?</h2>
    <p class="small muted">Get notified when next season's dates open. ${e.waitlist_count ? e.waitlist_count + ' people waiting.' : ''}</p>
    <form class="row" id="wl"><input name="contact" placeholder="WhatsApp or email" required maxlength="100"><button class="ghost">Notify me</button></form>
    <div id="wlout"></div>`;

  $app.querySelectorAll('.date').forEach((b) => b.onclick = () => {
    $app.querySelectorAll('.date').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel');
    sel = e.departures.find((d) => d.id === Number(b.dataset.id));
    const ps = document.querySelector('[name=party_size]');
    ps.max = sel.seats_left;
    if (Number(ps.value) > sel.seats_left) ps.value = sel.seats_left;
    $app.querySelectorAll('.fcu').forEach((s) => s.textContent = fmtDate(sel.free_cancel_until));
    document.getElementById('book').style.display = '';
    updateTotal();
  });

  const updateTotal = () => {
    const f = document.getElementById('bf'); if (!f) return;
    const n = Number(f.party_size.value) || 0;
    document.getElementById('total').textContent = `· Total $${n * e.price_usd}`;
    const online = f.querySelector('[name=payment_method]:checked')?.value === 'online';
    document.getElementById('submit').textContent = online ? `Continue to payment · $${n * e.price_usd}` : 'Send request';
  };
  document.getElementById('bf')?.addEventListener('input', updateTotal);

  const bf = document.getElementById('bf');
  if (bf) bf.onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(bf));
    const out = document.getElementById('out');
    try {
      const r = await api('/api/bookings', { method: 'POST', body: { ...f, departure_id: sel.id, party_size: Number(f.party_size) } });
      try { localStorage.setItem('pb_last_ref', r.ref); } catch {}
      if (r.checkout_url) { location.href = r.checkout_url; return; }
      document.getElementById('book').style.display = 'none';
      out.innerHTML = `<div class="msg ok"><b>Request sent — ref ${esc(r.ref)}</b><br>
        ${esc(e.host_name)} has ${r.hold_hours} hours to confirm. Save your reference.<br><br>
        <a href="${esc(r.whatsapp_url)}" target="_blank" rel="noopener"><button type="button">Message guide on WhatsApp</button></a>
        <a href="#/booking/${esc(r.ref)}"><button type="button" class="ghost">Track status</button></a></div>`;
    } catch (err) { out.innerHTML = msg(err.message, 'err'); }
  };

  const wl = document.getElementById('wl');
  wl.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api(`/api/experiences/${e.id}/waitlist`, { method: 'POST', body: Object.fromEntries(new FormData(wl)) });
      document.getElementById('wlout').innerHTML = msg("You're on the list.");
      wl.reset();
    } catch (err) { document.getElementById('wlout').innerHTML = msg(err.message, 'err'); }
  };
}

// ---------- Booking lookup ----------
async function bookingLookup(ref) {
  let last = ''; try { last = localStorage.getItem('pb_last_ref') || ''; } catch {}
  ref = ref || last;
  $app.innerHTML = `<h1>My booking</h1>
    <form class="row" id="lf"><input name="ref" placeholder="PB-XXXXXX" value="${esc(ref)}" required><button>Look up</button></form><div id="lo"></div>`;
  const lf = document.getElementById('lf');
  const show = async (r) => {
    try {
      const b = await api('/api/bookings/' + encodeURIComponent(r));
      const live = ['pending', 'confirmed'].includes(b.status);
      document.getElementById('lo').innerHTML = `<div class="card" style="margin-top:12px">
        <a class="title" href="#/x/${b.experience_id}">${esc(b.title)}</a>
        <p>${fmtDate(b.date)} · ${b.party_size} people · ${esc(b.name)}</p>
        <p>Status: <span class="status ${b.status}">${b.status}</span></p>
        <p>Total $${b.amount_usd} · ${PAY_LABEL[b.payment_method]} · <span class="small muted">${payText(b)}</span></p>
        ${b.checkout_url ? `<p><a href="${esc(b.checkout_url)}"><button type="button">Complete payment</button></a>
          <span class="small muted">Unpaid requests are released after a short time.</span></p>` : ''}
        ${b.status === 'expired' ? '<p class="small muted">This request expired (unpaid or not answered in time). Any card hold was released — please pick another date.</p>' : ''}
        ${live ? `<p class="small muted">Free cancellation until ${fmtDate(b.free_cancel_until)}${b.payment_method === 'online' ? ' — full refund' : ''}. After that, online payments are not refunded.</p>
          <form class="row" id="cf"><input name="contact" required placeholder="Contact you booked with"><button class="danger">Cancel booking</button></form>` : ''}
        <div id="co"></div></div>`;
      const cf = document.getElementById('cf');
      if (cf) cf.onsubmit = async (ev) => {
        ev.preventDefault();
        const late = b.status === 'confirmed' && b.payment_method === 'online' && new Date().toISOString().slice(0, 10) > b.free_cancel_until;
        if (!confirm(late ? 'You are past the free-cancellation date. You will NOT be refunded. Cancel anyway?' : 'Cancel this booking?')) return;
        try {
          const r2 = await api(`/api/bookings/${encodeURIComponent(b.ref)}/cancel`, { method: 'POST', body: Object.fromEntries(new FormData(cf)) });
          await show(b.ref);
          document.getElementById('co').innerHTML = msg(r2.message);
        } catch (err) { document.getElementById('co').innerHTML = msg(err.message, 'err'); }
      };
    } catch (err) { document.getElementById('lo').innerHTML = msg(err.message, 'err'); }
  };
  lf.onsubmit = (ev) => { ev.preventDefault(); location.hash = '#/booking/' + new FormData(lf).get('ref').trim(); };
  if (ref) show(ref);
}

// ---------- Payment helpers + mock checkout ----------
const PAY_LABEL = { online: 'Paid online', cash: 'Cash to guide' };
function payText(b) {
  if (b.payment_method === 'cash') return b.status === 'confirmed' ? 'pay the guide on the day' : 'no prepayment';
  return {
    awaiting: 'payment not completed', authorized: 'card held, charged when the guide confirms', captured: 'charged',
    voided: 'card hold released — not charged', refunded: 'refunded', failed: 'payment failed', none: '',
  }[b.payment_status];
}

// Stand-in for Stripe Checkout when the server runs with PAYMENT_PROVIDER=mock.
async function mockPay(ref) {
  const b = await api('/api/bookings/' + encodeURIComponent(ref));
  $app.innerHTML = `<div class="card" style="max-width:420px;margin:24px auto">
    <p class="small muted">TEST CHECKOUT — no real money moves</p>
    <h1>$${b.amount_usd}</h1>
    <p>${esc(b.title)}<br>${fmtDate(b.date)} · ${b.party_size} people</p>
    <p class="small muted">Your card is authorized now and only charged when the guide confirms.</p>
    ${b.checkout_url ? `<div class="row"><button id="ok">Pay $${b.amount_usd}</button><button class="ghost" id="fail">Simulate declined card</button></div>`
      : msg('This booking is not awaiting payment.', 'err')}
    <div id="po"></div></div>`;
  const go = async (outcome) => {
    try { await api('/api/payments/mock/' + encodeURIComponent(ref), { method: 'POST', body: { outcome } }); location.hash = '#/booking/' + ref; }
    catch (err) { document.getElementById('po').innerHTML = msg(err.message, 'err'); }
  };
  document.getElementById('ok')?.addEventListener('click', () => go('success'));
  document.getElementById('fail')?.addEventListener('click', () => go('fail'));
}

// ---------- Host dashboard ----------
const hostKey = () => { try { return localStorage.getItem('pb_host') || ''; } catch { return ''; } };
const hapi = (p, o = {}) => api(p, { ...o, headers: { 'X-Host-Key': hostKey() } });

async function host() {
  if (!hostKey()) return hostLogin();
  let d;
  try { d = await hapi('/api/host/me'); } catch (err) { return hostLogin(err.message); }
  const pending = d.bookings.filter((b) => b.status === 'pending');
  const ageH = (b) => Math.floor((Date.now() - Date.parse(b.created_at.replace(' ', 'T') + 'Z')) / 36e5);
  $app.innerHTML = `
    <div class="row" style="justify-content:space-between"><h1>Hi, ${esc(d.host.name)}</h1><button class="ghost" id="logout">Log out</button></div>
    <div class="grid" style="margin-top:12px">
      <div class="card"><div class="small muted">Payout due to you (online bookings)</div><div class="price">$${d.earnings.payout_due_usd}</div>
        <div class="small muted">After ${d.earnings.commission_pct}% commission</div></div>
      <div class="card"><div class="small muted">Commission you owe (cash bookings)</div><div class="price">$${d.earnings.commission_due_usd}</div>
        <div class="small muted">${d.earnings.commission_pct}% of confirmed cash trips</div></div>
    </div>
    <h2>Requests waiting (${pending.length})</h2>
    <p class="small muted">Requests expire after ${d.hold_hours}h without an answer: seats are released and card holds voided.</p>
    <div class="scroll"><table><tr><th>Ref</th><th>Trip</th><th>Date</th><th>Guest</th><th>People</th><th>Payment</th><th>Status</th><th></th></tr>
    ${d.bookings.map((b) => {
      const unpaid = b.payment_method === 'online' && b.payment_status === 'awaiting';
      return `<tr><td>${esc(b.ref)}</td><td>${esc(b.title)}</td><td>${fmtDate(b.date)}</td>
      <td>${esc(b.name)}<br><span class="small muted">${esc(b.contact)}</span>${b.message ? `<br><span class="small">“${esc(b.message)}”</span>` : ''}</td>
      <td>${b.party_size}</td><td>$${b.amount_usd}<br><span class="small muted">${PAY_LABEL[b.payment_method]}<br>${payText(b)}</span></td>
      <td><span class="status ${b.status}">${b.status}</span>${b.status === 'pending' ? `<br><span class="small muted">${d.hold_hours - ageH(b)}h left</span>` : ''}</td>
      <td class="row">${b.status === 'pending' ? `<button data-act="confirm" data-id="${b.id}" ${unpaid ? 'disabled title="Waiting for guest payment"' : ''}>Confirm</button><button class="danger" data-act="decline" data-id="${b.id}">Decline</button>` : ''}
        ${b.status === 'confirmed' ? `<button class="danger" data-act="cancel" data-id="${b.id}">Cancel</button>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="8" class="muted">No bookings yet.</td></tr>'}
    </table></div>
    <div id="hmsg"></div>

    <h2>Your experiences</h2>
    ${d.experiences.map((e) => `<div class="card" style="margin-bottom:12px">
      <a class="title" href="#/x/${e.id}">${esc(e.title)}</a> <span class="small muted">· $${e.price_usd} · season ${season(e)}</span>
      <form class="row small" data-pay="${e.id}" style="margin:8px 0">
        <label><input type="checkbox" name="accepts_online" ${e.accepts_online ? 'checked' : ''}> Online payment</label>
        <label><input type="checkbox" name="accepts_cash" ${e.accepts_cash ? 'checked' : ''}> Cash</label>
        <label>Free cancel until <input type="number" name="free_cancel_days" min="0" max="90" value="${e.free_cancel_days}" style="width:64px"> days before</label>
        <button class="ghost">Save</button></form>
      ${e.waitlist.length ? `<p class="small"><b>${e.waitlist.length} on waitlist:</b> ${e.waitlist.map((w) => esc(w.contact)).join(', ')}</p>` : ''}
      <div class="dates" style="margin:8px 0">${e.departures.map((dp) => `<span class="date">${fmtDate(dp.date)}
        <small>${dp.seats_left}/${dp.seats_total} free · <a href="#" data-del="${dp.id}">remove</a></small></span>`).join('') || '<span class="muted small">No dates yet.</span>'}</div>
      <form class="row" data-dep="${e.id}"><input type="date" name="date" required><input type="number" name="seats_total" min="1" value="8" style="width:90px" required><button class="ghost">Add date</button></form>
    </div>`).join('')}

    <h2>Add an experience</h2>
    <form class="form" id="nx">
      <label>Title <input name="title" required></label>
      <div class="row"><label>Type <select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label>Difficulty <select name="difficulty"><option>easy</option><option>moderate</option><option>hard</option></select></label></div>
      <label>Region <input name="region" required placeholder="e.g. Karakol"></label>
      <label>Description <textarea name="description" required></textarea></label>
      <div class="row"><label>Days <input name="duration_days" type="number" min="1" value="1" style="width:80px"></label>
        <label>Price USD / person <input name="price_usd" type="number" min="0" value="50" style="width:110px"></label></div>
      <div class="row"><label>Season from <select name="season_start">${MONTHS.map((m, i) => `<option value="${i + 1}" ${i === 5 ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label>to <select name="season_end">${MONTHS.map((m, i) => `<option value="${i + 1}" ${i === 8 ? 'selected' : ''}>${m}</option>`).join('')}</select></label></div>
      <label>Includes <input name="includes" placeholder="Guide, meals, tents..."></label>
      <div class="row"><label class="row"><input type="checkbox" name="accepts_online" checked> Accept online payment</label>
        <label class="row"><input type="checkbox" name="accepts_cash" checked> Accept cash</label></div>
      <label>Free cancellation until <input name="free_cancel_days" type="number" min="0" max="90" value="7" style="width:80px"> days before the trip</label>
      <button>Create</button>
    </form>`;

  const fail = (err) => { document.getElementById('hmsg').innerHTML = msg(err.message, 'err'); window.scrollTo(0, 0); };
  document.getElementById('logout').onclick = () => { try { localStorage.removeItem('pb_host'); } catch {} host(); };
  $app.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
    try { await hapi(`/api/host/bookings/${b.dataset.id}/${b.dataset.act}`, { method: 'POST' }); host(); } catch (err) { fail(err); }
  });
  $app.querySelectorAll('[data-del]').forEach((a) => a.onclick = async (ev) => {
    ev.preventDefault();
    try { await hapi('/api/host/departures/' + a.dataset.del, { method: 'DELETE' }); host(); } catch (err) { fail(err); }
  });
  $app.querySelectorAll('[data-dep]').forEach((f) => f.onsubmit = async (ev) => {
    ev.preventDefault();
    try { await hapi(`/api/host/experiences/${f.dataset.dep}/departures`, { method: 'POST', body: Object.fromEntries(new FormData(f)) }); host(); } catch (err) { fail(err); }
  });
  $app.querySelectorAll('[data-pay]').forEach((f) => f.onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { accepts_online: f.accepts_online.checked, accepts_cash: f.accepts_cash.checked, free_cancel_days: f.free_cancel_days.value };
    try { await hapi('/api/host/experiences/' + f.dataset.pay, { method: 'PATCH', body }); host(); } catch (err) { fail(err); }
  });
  const nx = document.getElementById('nx');
  nx.onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { ...Object.fromEntries(new FormData(nx)), accepts_online: nx.accepts_online.checked, accepts_cash: nx.accepts_cash.checked };
    try { await hapi('/api/host/experiences', { method: 'POST', body }); host(); } catch (err) { fail(err); }
  };
}

function hostLogin(error) {
  $app.innerHTML = `<h1>Guide & camp dashboard</h1>
    <p class="muted">Enter your host key. (Demo: <code>demo-aibek</code>)</p>
    ${error ? msg(error, 'err') : ''}
    <form class="row" id="hl"><input name="key" required placeholder="Host key"><button>Open dashboard</button></form>`;
  const hl = document.getElementById('hl');
  hl.onsubmit = (ev) => { ev.preventDefault(); try { localStorage.setItem('pb_host', new FormData(hl).get('key').trim()); } catch {} host(); };
}

// ---------- Router ----------
async function route() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const parts = path.split('/').filter(Boolean);
  try {
    if (parts[0] === 'x') await detail(parts[1]);
    else if (parts[0] === 'booking') await bookingLookup(parts[1]);
    else if (parts[0] === 'pay') await mockPay(parts[1]);
    else if (parts[0] === 'host') await host();
    else await explore(new URLSearchParams(qs));
  } catch (err) { $app.innerHTML = msg(err.message, 'err'); }
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);
route();
