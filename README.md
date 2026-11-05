# PeakBook — book mountain guides & yurt camps direct

Marketplace: travelers browse treks/yurt stays/horse trips, request a dated departure,
guide confirms from a dashboard. Like Booking.com, the guest chooses **pay now online** or
**pay the guide in cash**; each guide decides which methods they accept.

```
npm install
npm start          # http://localhost:3000  (demo host key: demo-aibek)
npm test
```

Requires Node >= 22.5 (uses built-in `node:sqlite`, no native deps).

## Payments
| | Online | Cash |
|---|---|---|
| At booking | Card **authorized** (not charged) | Nothing |
| Guide confirms | Card **captured** | Booking confirmed |
| Guide declines / no answer in 48h | Hold **voided** | Released |
| Unpaid checkout after 30 min | Seats released | — |
| Guest cancels before free-cancel date | Full refund | Free |
| Guest cancels after | No refund (guide keeps payment) | — |
| Guide cancels | Full refund | — |
| Platform commission (`COMMISSION_PCT`, 12%) | Deducted from payout | Owed by guide, shown in dashboard |

Providers (`PAYMENT_PROVIDER`):
- `mock` (default): fake checkout page, no money moves.
- `stripe`: set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BASE_URL`; point a Stripe webhook at
  `/api/payments/stripe/webhook` for `checkout.session.completed` and `checkout.session.expired`.
  Stripe does not onboard merchants registered in Kyrgyzstan; you need an entity in a supported
  country, or a local acquirer (add it as another provider in `payments.js`).

Not built yet: paying guides their payouts (tracked only), invoicing cash commission, no-show handling.

## Design decisions
- **Request-to-book, not instant book.** Guides are often offline in the mountains.
- **Seat holds expire after 48h** (`HOLD_HOURS`), so silent guides don't block a short season.
- **Waitlist on every experience** to capture off-season demand for next season.
- **Host auth is a shared secret key** — MVP only; replace with phone/OTP before real hosts.
