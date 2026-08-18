# Data flow — identifier chain hop by hop

This is the debugging bible. When attribution is broken, the fault is
always at one specific hop. Walk this doc top-to-bottom with real values
from the recipient's D1 and you'll find it.

## The chain in one sentence

> Cookie → `sessions` row → `trk` → `checkout_sessions` row → webhook →
> `purchase_log` row → Meta/GA4/Google Ads.

Every hop either carries an identifier forward or joins an existing one to
another table. If a hop drops an identifier, every downstream hop is
missing that piece of attribution forever.

---

## Hop 1 — Browser visit → middleware

**Trigger**: any HTML page request (not `/tracker`, not `/api/*`, not
`/webhook/*`, not static assets).

**Inputs Claude can see in D1** afterwards:
```sql
SELECT * FROM sessions WHERE session_id = 'b9e1…';
```

**What happens** (see `functions/_middleware.js`):

1. Read cookies. Extract `_rugido_sid`, `_rugido_eid`, `_fbp`, `_fbc` if
   present.
2. If `_rugido_sid` missing → `crypto.randomUUID()`. Same for `_rugido_eid`.
3. Read raw query string (not decoded) for `fbclid`, `gclid`, `msclkid`.
4. Read `utm_*` from `searchParams`.
5. Compute `SUB_DOMAIN_INDEX` from the Host header (1 for `.com`, 2 for
   `.com.br` / `.co.uk`).
6. If `fbclid` present and different from existing `_fbc`:
   `_fbc = fb.${SUB_DOMAIN_INDEX}.${Date.now()}.${fbclid}`.
7. If `_fbp` missing: generate `fb.${SUB_DOMAIN_INDEX}.${Date.now()}.{10-digit random}`.
8. Serve the page, then set 400-day cookies on the response.
9. In `waitUntil`: UPSERT the `sessions` row.

**Example `sessions` row after hop 1**:
```
session_id:   b9e1f6d2-47a3-4e1a-b1f2-7d3c9a2e8f41
external_id:  4c2d8a91-6f5b-4a2e-9c1d-3e7b8f4a2c6d
fbclid:       IwAR1abc…xyz
gclid:        (empty)
fbc:          fb.2.1729600000000.IwAR1abc…xyz
fbp:          fb.2.1729600000000.7642198301
utm_source:   facebook
utm_medium:   paid
utm_campaign: black-friday-2026
utm_content:  ad-variant-a
utm_term:     (empty)
landing_url:  https://mysite.com.br/lp?fbclid=IwAR1abc…xyz&utm_source=facebook…
created_at:   1729600000
updated_at:   1729600000
```

**Failure modes**:

- **No `sessions` row at all** → middleware didn't run. Check the path —
  `/api/*`, `/webhook/*`, `/dash` and static assets are deliberately
  excluded. If your lead/sales page is under one of those prefixes,
  rename it.
- **`utm_source` empty but URL has `utm_source=…`** → the visitor landed
  without the UTM and a later visit without it overwrote the row. UTMs use
  a CASE-WHEN-empty guard in the UPSERT, so a UTM-less visit shouldn't
  blank an existing one. If it does, check the SQL in
  `functions/_middleware.js` around lines 105-119.
- **`fbc` missing but `fbclid` is set** → extremely rare. Means the
  browser stripped the URL parameter before the request reached
  Cloudflare. Check Cloudflare Rocket Loader / AMP rewrites.

---

## Hop 2 — Lead form submit → `/tracker` → `event_log`

**Trigger**: `fetch('/tracker', {...})` from the lead form's submit
handler.

**Request body** (from `examples/lead-form-page/index.html`):
```json
{
  "event_name": "Lead",
  "event_id": "e8f1…",
  "event_time": 1729600120,
  "event_source_url": "https://mysite.com.br/lp",
  "user_data": {
    "em": "alice@example.com",
    "fn": "Alice",
    "ln": "Silva",
    "ph": "+55 11 98765-4321"
  }
}
```

**What happens** (`functions/tracker.js`):

1. Parse the body, read cookies, SELECT the `sessions` row by
   `_rugido_sid`.
2. Resolve `fbp` / `fbc` / `external_id` with fallback:
   - `fbp`: body → cookie → sessions row.
   - `fbc`: sessions row → cookie → body.
3. Normalize PII: lowercase+trim for email, strip non-digits +
   leading-zero for phone, lowercase+strip punctuation for names.
4. SHA-256 hash each normalized value.
5. Bot-check the User-Agent.
6. Fire Meta CAPI + GA4 MP in parallel (`Promise.allSettled`).
7. Insert into `event_log` (skipping PageView).

**Example `event_log` row after hop 2**:
```
session_id:       b9e1f6d2-47a3-4e1a-b1f2-7d3c9a2e8f41
event_name:       Lead
event_id:         e8f1c2a3-9b4d-4e5f-6a7b-8c9d0e1f2a3b
timestamp:        1729600120
browser:          Chrome
browser_version:  134.0.0.0
os:               iOS
is_mobile:        1
pixel_was_blocked: 0
fbp_source:       pixel_js
fbc_source:       middleware_http
fbclid_source:    server_middleware
has_email:        1
has_phone:        1
has_name:         1
sent_to_meta:     1
meta_response_ok: 1
raw_email:        alice@example.com
```

**Meta CAPI payload Claude can paste into Meta's Test Events tab**:
```json
{
  "data": [{
    "event_name": "Lead",
    "event_time": 1729600120,
    "event_id": "e8f1c2a3-9b4d-4e5f-6a7b-8c9d0e1f2a3b",
    "event_source_url": "https://mysite.com.br/lp",
    "action_source": "website",
    "user_data": {
      "client_ip_address": "177.37.xx.xx",
      "client_user_agent": "Mozilla/5.0 (iPhone…)",
      "em": ["b0c2…"],
      "fn": ["3ef5…"],
      "ln": ["7d1a…"],
      "ph": ["c8b9…"],
      "external_id": ["4f2e…"],
      "fbp": "fb.2.1729600000000.7642198301",
      "fbc": "fb.2.1729600000000.IwAR1abc…xyz"
    }
  }]
}
```

**Failure modes**:

- **`event_log` row exists but `meta_response_ok = 0`** → Meta rejected
  the event. Check `meta_response_body`. Common causes: wrong pixel ID,
  expired access token, malformed PII hash, `action_source` wrong for
  your setup.
- **`fbp_source = none` and `fbc_source = none`** → neither the pixel nor
  the middleware captured any Meta identifier. Usually means the visitor
  never landed with an `fbclid` and was also blocking the pixel. Normal
  for organic traffic.
- **`pixel_was_blocked = 1`** → the client payload had no `fbp`/`fbc` but
  `/tracker` still ran, so the event reached Meta via CAPI. This is the
  "recovered by server-side" case — a win, not a bug.

---

## Hop 3 — Sales page visit → `/checkout-session` → `checkout_sessions`

**Trigger**: page load on any page that imports the sales-page pattern.

**Request body** (from `examples/sales-page/index.html`):
```json
{
  "trk": "f2d1a9c0-3e8b-4a2e-9c1d-3e7b8f4a2c6d",
  "utm_source": "facebook",
  "utm_medium": "paid",
  "utm_campaign": "black-friday-2026",
  "utm_content": "ad-variant-a",
  "utm_term": "",
  "event_source_url": "https://mysite.com.br/offer"
}
```

**What happens** (`functions/checkout-session.js`):

1. Read cookies, read body, SELECT sessions by `_rugido_sid`.
2. Build the enriched row: `fbp` from cookie → sessions → body;
   `gclid` from sessions → body; `ga_client_id` parsed from `_ga` cookie.
3. `INSERT OR REPLACE INTO checkout_sessions` (keyed by `trk`).

**Example `checkout_sessions` row after hop 3**:
```
trk:              f2d1a9c0-3e8b-4a2e-9c1d-3e7b8f4a2c6d
session_id:       b9e1f6d2-47a3-4e1a-b1f2-7d3c9a2e8f41
fbp:              fb.2.1729600000000.7642198301
fbc:              fb.2.1729600000000.IwAR1abc…xyz
gclid:            (empty)
ga_client_id:     1729600000.7642198301
utm_source:       facebook
utm_medium:       paid
utm_campaign:     black-friday-2026
event_source_url: https://mysite.com.br/offer
created_at:       1729600500
```

**Failure modes**:

- **Row exists but `fbp` and `fbc` both empty** → the visitor arrived
  without an ad click and without the Meta pixel having set `_fbp`. Normal
  for organic, but means Meta CAPI will only match by IP+UA+PII.
- **Row missing entirely** → the page's `persistCheckoutSession()` call
  never ran. Check the browser console; look for CORS errors or a typo in
  the `/checkout-session` path.

---

## Hop 4 — Checkout button click → platform checkout

**Trigger**: user clicks the CTA on the sales page.

**What happens** (in `index.html`):

1. Fire `InitiateCheckout` via `sendBeacon('/tracker', …)` — fires Meta
   CAPI + GA4 even if the page unloads immediately.
2. Look up the URL parameter name for this platform:
   `{eduzz: 'trk', hotmart: 'xcod', kiwify: 'sck'}`.
3. Append `?<paramName>=<trk>` to the checkout URL.
4. `setTimeout` 80ms to flush the beacon queue.
5. `window.location.href = destination`.

**Example destination URL**:
```
https://sun.eduzz.com/1234567?trk=f2d1a9c0-3e8b-4a2e-9c1d-3e7b8f4a2c6d
```

**Failure modes**:

- **`trk` missing from destination URL** → check the platform dropdown in
  `index.html` (`CHECKOUT_PLATFORM`). If the recipient's checkout URL
  already contains `?trk=…` as a static value, the page's dynamic `trk` is
  being overwritten. The recipient needs to remove the static one from
  their platform dashboard.

---

## Hop 5 — Platform webhook → adapter → `_core.js`

**Trigger**: platform POSTs its webhook to `/webhook/<platform>/<slug>`
after the buyer completes payment.

**What happens** (e.g. `functions/webhook/eduzz/[slug].js`):

1. Compare `context.params.slug` to `env.EDUZZ_WEBHOOK_SLUG` via
   `guardSlug()`. Mismatch → 404; env missing → 500; no DB touch in
   either case.
2. Read the raw body.
3. Unwrap if needed (Eduzz nests under `data`, Kiwify under `order`).
4. Filter to paid sales (status = 'paid' for Eduzz; equivalents elsewhere).
5. Build the normalized purchase object.
6. Call `processPurchase({ parsed, env, context })`.

**Normalized purchase object (shared shape)**:
```json
{
  "platform": "eduzz",
  "trk": "f2d1a9c0-3e8b-4a2e-9c1d-3e7b8f4a2c6d",
  "email": "alice@example.com",
  "name": "Alice Silva",
  "phone": "+55 11 98765-4321",
  "value": 97.00,
  "currency": "BRL",
  "transactionId": "eduzz-sale-1234567",
  "productId": "1234567",
  "productName": "My Product",
  "items": [{"productId": "1234567", "name": "My Product", "price": {"value": 97, "currency": "BRL"}}],
  "platformUtm": {"utm_source": "…", "utm_medium": "…"}
}
```

**In `_core.js`**:

1. SELECT `checkout_sessions` by `trk`.
2. Call `handleTracking` (Meta/GA4/Google Ads) only if the lookup
   succeeded — no lookup = no server-side conversion fire (the sale still
   logs, but attribution is missing).
3. Call `handleEncharge` if `config/products.js` has a tag for this
   product.
4. Call `handleManyChat` if there's a `manychatTagId`.
5. Insert `purchase_log` in `waitUntil`. Insert `purchase_items` as a
   batch; roll back `purchase_log` if items fail.

**Failure modes**:

- **404 in platform webhook logs** → URL slug mismatch. The platform is
  hitting the adapter but the slug doesn't match `<PLATFORM>_WEBHOOK_SLUG`.
  Either the recipient pasted the wrong URL into the platform dashboard,
  or the env var is set to a different value. Compare the URL shown in
  the platform's webhook logs to the env-var value in the Cloudflare
  dashboard → Pages project → Settings → Environment variables.
- **500 with "webhook not configured" in response body** → the slug env
  var isn't set on this deploy. Re-run the slug-generation step of
  `deploy-stack`, or set it manually in the Cloudflare dashboard →
  Pages project → Settings → Environment variables → Add variable, with
  name `<PLATFORM>_WEBHOOK_SLUG` and the UUID as value, then retry the
  latest deployment so the binding takes effect.
- **`checkoutData` empty in `_core.js`** → `trk` lookup failed. Either the
  buyer's session never wrote `checkout_sessions` (Hop 3 broke) or the
  platform sent back the wrong value in the custom field (Hop 4 broke).
  Query D1: `SELECT * FROM checkout_sessions WHERE trk = '<value from webhook payload>'`.
- **`purchase_log` row exists but `meta_response_ok = 0`** → Meta
  rejected the Purchase event. Same triage as Hop 2, plus check that
  `value` and `currency` are populated.

---

## Hop 6 — `purchase_log` → dashboard

The dashboard reads from `purchase_log`, `purchase_items`, and `ad_spend`
via the `/api/*` endpoints. No additional transforms — what you see is
what got persisted at Hop 5.

If the dashboard row looks wrong but the D1 row is right, the bug is in
the dashboard `api/*.js` query. If the D1 row itself is wrong, the bug is
upstream — walk back through the hops until you find the bad row.

## Quick queries for triage

```bash
# Recent sessions
wrangler d1 execute <db> --remote --command \
  "SELECT session_id, utm_source, utm_campaign, created_at FROM sessions ORDER BY created_at DESC LIMIT 10"

# Last 10 checkout_sessions (did trk persist?)
wrangler d1 execute <db> --remote --command \
  "SELECT trk, fbp, utm_source, created_at FROM checkout_sessions ORDER BY created_at DESC LIMIT 10"

# Most recent purchase with tracking status
wrangler d1 execute <db> --remote --command \
  "SELECT transaction_id, trk, meta_response_ok, ga4_response_ok, google_ads_response_ok, created_at FROM purchase_log ORDER BY created_at DESC LIMIT 5"

# Did a specific trk make it all the way through?
wrangler d1 execute <db> --remote --command \
  "SELECT 'checkout' AS stage, trk, utm_source FROM checkout_sessions WHERE trk='XYZ' UNION ALL SELECT 'purchase', trk, utm_source FROM purchase_log WHERE trk='XYZ'"
```
