---
name: verify-tracking
description: Walks the Level 1 integrity chain for a deployed tracking stack to confirm every hop works end-to-end. Use when the recipient says "is my tracking working", "check my tracking", "verify the chain", "test it", "why aren't my events firing", "Meta isn't showing conversions", or "something feels off". Runs six checkpoints covering cookie generation, D1 session capture, checkout URL rewriting, sales-platform webhook forwarding, D1 enrichment lookup, and ad-platform receipt. For each checkpoint, reports PASS / FAIL / SKIPPED with the specific evidence found or the likely cause.
---

# Skill: verify-tracking

You are walking a recipient through the 6-checkpoint Level 1 integrity chain for their deployed tracking stack. Each checkpoint verifies one hop in the chain from "user visits page" to "conversion shows up in Meta Events Manager." For each checkpoint, you run a specific check, report PASS / FAIL / SKIPPED, and if something breaks you pinpoint where.

This skill assumes the stack has been deployed via `deploy-stack` and that the recipient has at least one example page live (lead form or sales page). If neither is true, stop and tell them to run `deploy-stack` and `add-page` first.

## Prerequisites

Confirm with the recipient before starting:

1. **They have a deployed Pages URL.** Ask for it. Call it `SITE_URL` below (e.g. `https://acme-tracking.pages.dev`).
2. **They know the project name for wrangler.** Usually matches the subdomain. Call it `PROJECT_NAME`.
3. **The database name** (usually `${PROJECT_NAME}-db`). Call it `DB_NAME`.
4. **They have at least one example page deployed** — a lead form, sales page, or both. If the stack has never received real traffic, you can't verify anything. Ask them to visit their live page in a normal browser tab once before continuing.

If the recipient is running sales-page checkpoints (3 through 6), ask which sales platform they're using (`eduzz`, `hotmart`, or `kiwify`) and call it `PLATFORM`.

## Checkpoint 1 — Edge middleware generates `_rugido_sid` and writes to `sessions`

**What to check**: when a visitor hits any page, the middleware should set a `_rugido_sid` cookie and upsert a row in the `sessions` table with `fbp`, `external_id`, and any UTMs present in the URL.

**How to verify**:

```bash
wrangler d1 execute ${DB_NAME} --remote --command \
  "SELECT session_id, fbp, fbc, utm_source, utm_medium, created_at FROM sessions ORDER BY created_at DESC LIMIT 5"
```

**PASS** — you see at least one row with a non-empty `session_id` and a populated `fbp` starting with `fb.1.` or `fb.2.`.

**FAIL modes**:
- **Zero rows at all.** Middleware isn't running. Likely causes: D1 binding name is wrong (check `wrangler.toml` has `binding = "DB"`), or the page being visited is in a path the middleware skips (`/api/*`, `/webhook/*`, `/dash`, `/scripts/*`, or a static asset). Ask the recipient what URL they visited — if it was `/dash` or similar, tell them to visit the lead form or sales page example instead.
- **Rows exist but `fbp` is empty.** Middleware ran but the Host header logic didn't compute a valid sub_domain_index. This is almost never a bug; check if the recipient visited the site via a raw `*.pages.dev` URL (which works) vs a freshly-configured custom domain that hasn't propagated.
- **`utm_source` etc. are empty.** Not a bug — they're only populated when the URL has `?utm_source=...&...` query params. Ask the recipient to visit the page once with some UTMs (e.g. `${SITE_URL}/?utm_source=test&utm_medium=verify`) and re-run the check.

## Checkpoint 2 — `/tracker` endpoint receives client events and writes to `event_log`

**What to check**: when the visitor submits a lead form (or a sales page fires PageView), the client POSTs to `/tracker`, which logs non-PageView events to `event_log` and fires Meta CAPI + GA4 MP in parallel.

**How to verify**:

```bash
wrangler d1 execute ${DB_NAME} --remote --command \
  "SELECT event_name, event_id, raw_email, meta_response_ok, ga4_response_ok, timestamp FROM event_log ORDER BY timestamp DESC LIMIT 5"
```

**PASS** — at least one `Lead` or `InitiateCheckout` row exists, `meta_response_ok = 1` and `ga4_response_ok = 1`.

**FAIL modes**:
- **Zero rows.** Either no Lead event was ever fired (the recipient hasn't submitted the form), or the endpoint is returning 500. Ask them to submit the lead form once in a browser with devtools Network tab open. They should see a POST to `/tracker` with 200 response. If 500, the response body will tell you what's wrong.
- **Rows exist but `meta_response_ok = 0`.** The `meta_response_body` column has the error. Most common: invalid `META_ACCESS_TOKEN` (Meta returns a 190 error code), invalid `META_PIXEL_ID`, or the token doesn't have `ads_management` permission. Show the recipient the error body.
- **Rows exist but `ga4_response_ok = 0`.** Usually the `GA4_API_SECRET` is wrong or was created for a different measurement ID. Have them re-create the secret in GA4 Admin → Data Streams → Measurement Protocol API secrets and paste the new value into Cloudflare dashboard → Pages project → Settings → Environment variables (edit `GA4_API_SECRET`), then retry the latest deployment.
- **Only `PageView` rows show up here.** That's a bug in this skill's premise — PageView is never logged to `event_log`. If you see them, something's wrong with `tracker.js`. Stop and investigate.

## Checkpoint 3 — Sales page generates `trk` and writes `checkout_sessions`

**Skip this checkpoint if the recipient only has a lead form and no sales page.** Report `SKIPPED — no sales flow configured`.

**What to check**: when the sales page loads, it generates a UUID, stores it as `trk`, and POSTs to `/checkout-session`. A row should land in `checkout_sessions` with the `trk` and the enriched `fbp`, `fbc`, `ga_client_id`, and UTMs from the current session.

**How to verify**:

```bash
wrangler d1 execute ${DB_NAME} --remote --command \
  "SELECT trk, session_id, fbp, fbc, ga_client_id, utm_source, utm_campaign, created_at FROM checkout_sessions ORDER BY created_at DESC LIMIT 5"
```

**PASS** — at least one row with a UUID-shaped `trk` and a non-empty `session_id`.

**FAIL modes**:
- **Zero rows.** The recipient hasn't visited a sales page yet, or the sales page isn't calling `/checkout-session` on load. Ask them to visit their sales page URL once. If still no row, read their sales page HTML and confirm it has the `persistCheckoutSession()` IIFE from `examples/sales-page/index.html`.
- **Row exists but `session_id` is empty.** The `_rugido_sid` cookie didn't reach the `/checkout-session` fetch. Usually means the sales page was loaded in a new tab with no prior visit, or cookies are being blocked (Safari ITP third-party, or the recipient's dev browser has cookies disabled). Ask them to visit the sales page in a fresh normal Chrome window.
- **`fbp` / `fbc` are empty but `session_id` is present.** The session row exists but has no `fbp`/`fbc` — go back to Checkpoint 1 and check why middleware isn't setting them.

## Checkpoint 4 — Sales platform forwards `trk` back in the webhook payload

**Skip if no sales page.** Report `SKIPPED`.

**What to check**: when a buyer completes a purchase on `${PLATFORM}`, the platform POSTs a webhook to `/webhook/${PLATFORM}`. That payload should contain the `trk` value in the platform's custom-field slot (`tracker.code1` for Eduzz, `xcod` for Hotmart, `sck` for Kiwify).

**How to verify**: this is the hardest checkpoint because it requires a real test purchase. Walk the recipient through it:

1. Open `${SITE_URL}/<their sales page>` in a fresh browser window.
2. Click the checkout button and copy the destination URL — it should contain `?trk=<uuid>` (for Eduzz), `?xcod=<uuid>` (Hotmart), or `?sck=<uuid>` (Kiwify).
3. If the URL doesn't contain the parameter, stop here — FAIL. Check the sales page HTML and confirm `CHECKOUT_PLATFORM` is set correctly at the top of the file.
4. Complete a test purchase on the sales platform. Most platforms have a sandbox / test-card option; if not, a real R$1 refundable purchase works.
5. After the purchase completes, check if the webhook arrived:

```bash
wrangler d1 execute ${DB_NAME} --remote --command \
  "SELECT trk, transaction_id, value, meta_response_ok, created_at FROM purchase_log ORDER BY created_at DESC LIMIT 3"
```

**PASS** — a row exists with the `trk` matching the one appended to the checkout URL.

**FAIL modes**:
- **No row at all.** The webhook never reached the endpoint. Confirm the recipient configured their webhook URL in the sales platform dashboard to point at `${SITE_URL}/webhook/${PLATFORM}`. Also confirm the webhook secret is set (`${PLATFORM.toUpperCase()}_WEBHOOK_SECRET`) — a missing secret causes the endpoint to return 401, which some platforms silently drop.
- **Row exists but `trk` is empty.** The webhook fired but the sales platform didn't forward the custom-field. Each platform has its own gotcha: Eduzz requires the field to be `tracker.code1` specifically, Hotmart uses `xcod` at top-level or inside `offer.xcod`, Kiwify uses `sck`. Check `docs/platforms/${PLATFORM}.md` for the exact spot in the payload.
- **Row exists, `trk` is populated, but `meta_response_ok = 0`.** That's Checkpoint 6's concern, not this one. Continue to 5.

## Checkpoint 5 — Webhook finds the `checkout_sessions` row and enriches the conversion

**Skip if Checkpoint 4 failed.** Report `SKIPPED` with a note pointing back at 4.

**What to check**: when the webhook arrives with a `trk`, `_core.js` looks up the matching `checkout_sessions` row and enriches the Meta/GA4/Google Ads fire with its `fbp`/`fbc`/`ga_client_id`. The `purchase_log` row should have those values populated.

**How to verify**:

```bash
wrangler d1 execute ${DB_NAME} --remote --command \
  "SELECT trk, fbp, fbc, utm_source, utm_campaign, value FROM purchase_log ORDER BY created_at DESC LIMIT 1"
```

**PASS** — the top row has non-empty `fbp` and (for paid traffic) non-empty `fbc` or `utm_source`.

**FAIL modes**:
- **`trk` is populated but `fbp` / `fbc` are empty.** The webhook arrived with a `trk` that doesn't match any `checkout_sessions` row. The most common cause: the recipient opened the sales page in one browser session, then checked out in a completely different browser, so the `trk` was generated twice and only one of them persisted. Ask them to repeat the test in a single browser window.
- **`trk` matches but UTMs are empty.** Not a bug — they just didn't visit the sales page with UTMs in the URL. Ask them to repeat with `?utm_source=verify&utm_campaign=test` on the sales page URL.

## Checkpoint 6 — Meta / GA4 / Google Ads received the conversion

**Skip if Checkpoint 5 failed.** Report `SKIPPED`.

**What to check**: the `purchase_log` row's `meta_response_ok`, `ga4_response_ok`, and (if Google Ads is configured) `google_ads_response_ok` columns should all be `1`. And the event should be visible in the respective ad platform's test/debug tool.

**How to verify**:

```bash
wrangler d1 execute ${DB_NAME} --remote --command \
  "SELECT meta_response_ok, meta_response_body, ga4_response_ok, google_ads_response_ok, google_ads_response_body FROM purchase_log ORDER BY created_at DESC LIMIT 1"
```

**PASS** — all three response_ok columns are 1 (or Google Ads is deliberately not configured, in which case `google_ads_response_body` will say "skipped: missing google ads env" or "no click id").

Then have the recipient confirm visually:

- **Meta** — Events Manager → their Pixel → Test Events tab (if they set `META_TEST_EVENT_CODE`) or Overview tab. They should see a `Purchase` with matching `event_id`.
- **GA4** — Admin → DebugView (requires `debug_mode=true` param, optional for Measurement Protocol), or Reports → Realtime.
- **Google Ads** — Tools & Settings → Conversions → their conversion action → Diagnostics. Conversions take 3-4 hours to appear.

**FAIL modes**:
- **`meta_response_ok = 0`.** `meta_response_body` has the error. Parse it. Common: expired access token, wrong pixel ID, user_data missing required field for the event type.
- **`ga4_response_ok = 0`.** Usually wrong API secret. Re-generate in GA4 Admin.
- **`google_ads_response_ok = 0` but `google_ads_response_body` says "no click id".** That means the purchase's session didn't have a `gclid`. Only paid Google traffic has a `gclid` — organic clicks won't trigger Google Ads conversions. Tell the recipient this is expected for organic traffic.
- **`google_ads_response_ok = 0` with a real error body.** The error message is usually clear. Common: `DEVELOPER_TOKEN_NOT_APPROVED`, wrong `GOOGLE_ADS_CUSTOMER_ID` format, or the conversion action ID in `config/products.js` doesn't match a real action in their Google Ads account.

## Reporting back

After running all 6 checkpoints, give the recipient a scorecard:

```
Checkpoint 1 — Middleware → sessions          [PASS / FAIL: <reason>]
Checkpoint 2 — /tracker → event_log           [PASS / FAIL: <reason>]
Checkpoint 3 — Sales page → checkout_sessions [PASS / FAIL / SKIPPED]
Checkpoint 4 — Sales platform → webhook       [PASS / FAIL / SKIPPED]
Checkpoint 5 — Webhook enrichment             [PASS / FAIL / SKIPPED]
Checkpoint 6 — Ad platform receipt            [PASS / FAIL / SKIPPED]
```

If everything is PASS or SKIPPED-with-reason, tell the recipient: **"Your tracking is healthy. You can start running paid traffic."**

If anything is FAIL, stop and walk through that specific checkpoint's fix with them before moving on. Don't overwhelm them with all failures at once — fix the earliest failing checkpoint first and re-run from there.
