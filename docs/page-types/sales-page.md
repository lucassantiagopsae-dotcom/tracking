# Sales page recipe

A sales page demonstrates an offer and sends the buyer to a sales-platform
checkout with a `trk` identifier appended. The `trk` is the critical
thread that lets the webhook handler (hours later, on the platform's
schedule) reach back and attribute the sale to the original visit.

Starter lives at `examples/sales-page/index.html`.

## What the page must do

Every sales page has six responsibilities beyond the lead-form list:

1. **Let the middleware run** (same rule — avoid `/api/*`, `/webhook/*`,
   `/dash`).
2. **Load GA4 + Meta Pixel** (same as the lead recipe).
3. **Generate a `trk` UUID** on page load and persist it in
   `sessionStorage` so refreshes within the tab reuse it:
   ```js
   let trk = sessionStorage.getItem('rugido_trk');
   if (!trk) {
     trk = crypto.randomUUID();
     sessionStorage.setItem('rugido_trk', trk);
   }
   ```
4. **POST the trk + UTMs to `/checkout-session`** on page load so the
   webhook has something to look up later:
   ```js
   fetch('/checkout-session', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ trk, utm_source, utm_medium, ..., event_source_url: location.href }),
   });
   ```
5. **Fire `InitiateCheckout`** when the CTA is clicked, using
   `navigator.sendBeacon('/tracker', ...)` so the fire survives the
   navigation away from the page.
6. **Append `trk` to the checkout URL in the platform's custom-field
   parameter name**:

| Platform | URL parameter | Payload field the webhook reads |
|---|---|---|
| Eduzz | `trk` | `body.tracker.code1` |
| Hotmart | `xcod` | `body.buyer.source` (see platform doc) |
| Kiwify | `sck` | `body.TrackingParameters.sck` (see platform doc) |

The starter handles this with a lookup table:
```js
const TRK_FIELD_BY_PLATFORM = {
  eduzz:   'trk',
  hotmart: 'xcod',
  kiwify:  'sck',
};
```

## The full CTA click handler, annotated

```js
btn.addEventListener('click', () => {
  // Fire InitiateCheckout (beacon survives the upcoming navigation)
  const eventId = crypto.randomUUID();
  navigator.sendBeacon('/tracker', new Blob([JSON.stringify({
    event_name: 'InitiateCheckout',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event_source_url: location.href,
    user_data: {},
  })], { type: 'application/json' }));

  // Also fire on the pixel with the same event_id for dedup
  try { fbq('track', 'InitiateCheckout', {}, { eventID: eventId }); } catch (_) {}

  // Append trk to the checkout URL under the platform's param name
  const paramName = TRK_FIELD_BY_PLATFORM[CHECKOUT_PLATFORM] || 'trk';
  const separator = CHECKOUT_URL.includes('?') ? '&' : '?';
  const destination = `${CHECKOUT_URL}${separator}${paramName}=${encodeURIComponent(trk)}`;

  // 80ms setTimeout so the beacon queue has time to flush on Android Chrome
  setTimeout(() => { window.location.href = destination; }, 80);
});
```

## Configuring the platform's webhook

The page side is only half the job. Each recipient must also, in their
sales-platform dashboard:

1. **Set the webhook URL** to the full path `deploy-stack` printed,
   including the per-platform UUID slug. Shape:
   `https://<project>.pages.dev/webhook/<platform>/<slug>`.
   Example: `https://mysite.pages.dev/webhook/eduzz/a1b2c3d4-5678-…`.
2. **Enable the events that indicate a completed paid sale**:
   - Eduzz → `sale.paid` (or equivalent; see [platforms/eduzz.md](../platforms/eduzz.md)).
   - Hotmart → `PURCHASE_APPROVED`.
   - Kiwify → `order_approved`.
3. **Fire a test webhook** from the platform dashboard if possible, then
   run `verify-tracking` skill checkpoint 5 to confirm the adapter got it.

The slug in the URL is the only thing gating the endpoint — a request
to `/webhook/<platform>/<wrong-slug>` returns 404. Treat the URL like a
password: save it in a password manager, don't share it publicly.

## Why the page writes `checkout_sessions` at page load, not at CTA click

Two reasons:

1. If the buyer bounces off the checkout and comes back, the D1 row is
   already there. The webhook arrives later — it doesn't care when the row
   was written, only that it exists.
2. `navigator.sendBeacon` is reliable for the InitiateCheckout fire, but
   not for the `/checkout-session` POST, which needs to return 200 and
   contain a DB write. Running it at page load, with a real `fetch`, gives
   it proper time to complete.

Consequence: bounced visitors still create a `checkout_sessions` row, so
the table is noisier than `purchase_log`. The `idx_checkout_sessions_created`
index handles that fine; if volume ever becomes a concern, a retention
sweep for rows where no matching `purchase_log.trk` exists after N days
is safe to run.

## Multiple products on one sales page

One `trk` per page visit, not per product. The `trk` doesn't encode the
product — that lives in the webhook payload. If the page offers an upsell
and the buyer picks one of two checkout URLs:

```js
document.getElementById('checkout-basic').addEventListener('click', () => goTo(CHECKOUT_URL_BASIC));
document.getElementById('checkout-premium').addEventListener('click', () => goTo(CHECKOUT_URL_PREMIUM));

function goTo(url) {
  // same InitiateCheckout fire + trk append pattern as the starter
}
```

Each CTA sends the same `trk` to a different checkout URL. The webhook
then delivers the product-specific payload and `_core.js` persists the
right `product_id`.

## What Claude should check after adding a sales page

1. Visit the page in a browser with a UTM-tagged URL.
2. Network tab: confirm `/checkout-session` returned 200 with
   `{"ok": true}`.
3. Query D1:
   ```
   wrangler d1 execute <db> --remote --command "SELECT trk, utm_source, fbp, created_at FROM checkout_sessions ORDER BY created_at DESC LIMIT 1"
   ```
   The row should have `utm_source` matching the URL and `fbp` populated.
4. Click the price-card CTA (the one with `id="checkout-btn"` — the hero
   and final-CTA buttons in the starter are scroll-to-`#preco` anchors
   and don't fire checkout). Watch DevTools briefly for the `/tracker`
   beacon, then confirm the destination URL contains `?<paramName>=<trk>`
   with the same UUID you saw in step 3.
5. Complete a test purchase on the platform.
6. Query `purchase_log`:
   ```
   wrangler d1 execute <db> --remote --command "SELECT trk, transaction_id, meta_response_ok, utm_source FROM purchase_log ORDER BY created_at DESC LIMIT 1"
   ```
   The `trk` should match step 3, UTMs should flow through, and
   `meta_response_ok = 1`.

If `meta_response_ok = 0` but the row exists, check `meta_response_body`
for the rejection reason. If the row doesn't exist at all, the webhook
never landed — check the platform dashboard's webhook delivery log and
[docs/platforms/](../platforms/) for the specific adapter.
