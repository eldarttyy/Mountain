# PeakBook — book mountain guides & yurt camps direct

MVP marketplace: travelers browse treks/yurt stays/horse trips, request a dated departure,
guide confirms from a dashboard. No online payment — guest pays guide directly; WhatsApp hand-off.

```
npm install
npm start          # http://localhost:3000  (demo host key: demo-aibek)
npm test
```

Requires Node >= 22.5 (uses built-in `node:sqlite`, no native deps).

## Design decisions
- **Request-to-book, not instant book.** Guides are often offline in the mountains.
- **Seat holds expire after 48h** (`HOLD_HOURS`), so silent guides don't block a short season.
- **Waitlist on every experience** to capture off-season demand for next season.
- **Host auth is a shared secret key** — MVP only; replace with phone/OTP before real hosts.
