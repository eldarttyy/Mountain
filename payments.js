// Payment providers. Online payments are AUTHORIZED at booking and only
// CAPTURED when the guide confirms. A decline or an unanswered request just
// voids the authorization: no refund fees, and the guest is never charged
// for a trip that isn't happening.
//
// PAYMENT_PROVIDER=mock   (default) local fake checkout page, no keys needed
// PAYMENT_PROVIDER=stripe  STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET required
const crypto = require('node:crypto');

const mock = {
  name: 'mock',
  async createCheckout({ ref, baseUrl }) {
    return { url: `${baseUrl}/#/pay/${ref}`, sessionId: 'mock_' + ref };
  },
  async capture() {},
  async void() {},
  async refund() {},
  async expireCheckout() {},
};

function stripeProvider(secret) {
  const call = async (path, params = {}) => {
    const res = await fetch('https://api.stripe.com/v1' + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Stripe ${path}: ${data.error?.message || res.status}`);
    return data;
  };
  return {
    name: 'stripe',
    async createCheckout({ ref, title, unitCents, quantity, baseUrl, expiresMinutes }) {
      const s = await call('/checkout/sessions', {
        mode: 'payment',
        client_reference_id: ref,
        'metadata[ref]': ref,
        'line_items[0][quantity]': quantity,
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': unitCents,
        'line_items[0][price_data][product_data][name]': title,
        'payment_intent_data[capture_method]': 'manual',
        'payment_intent_data[metadata][ref]': ref,
        success_url: `${baseUrl}/#/booking/${ref}`,
        cancel_url: `${baseUrl}/#/booking/${ref}`,
        // Stripe requires >= 30 minutes.
        expires_at: Math.floor(Date.now() / 1000) + Math.max(30, expiresMinutes) * 60,
      });
      return { url: s.url, sessionId: s.id };
    },
    capture: (b) => call(`/payment_intents/${b.provider_payment_id}/capture`),
    void: (b) => call(`/payment_intents/${b.provider_payment_id}/cancel`),
    refund: (b) => call('/refunds', { payment_intent: b.provider_payment_id }),
    expireCheckout: (b) => call(`/checkout/sessions/${b.provider_ref}/expire`),
  };
}

// Stripe-Signature: t=timestamp,v1=hex(hmac_sha256(secret, `${t}.${rawBody}`))
function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  const sigs = String(header || '').split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

function getProvider() {
  const kind = process.env.PAYMENT_PROVIDER || 'mock';
  if (kind === 'mock') return mock;
  if (kind === 'stripe') {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
      throw new Error('PAYMENT_PROVIDER=stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
    }
    return stripeProvider(process.env.STRIPE_SECRET_KEY);
  }
  throw new Error('Unknown PAYMENT_PROVIDER: ' + kind);
}

module.exports = { getProvider, verifyStripeSignature };
