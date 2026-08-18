# D1 schema reference

Seven tables, no foreign keys except `purchase_items → purchase_log`.
Every `id` is an auto-increment integer except `sessions.session_id`
(UUID) and `checkout_sessions.trk` (UUID). Every timestamp is Unix seconds
(integer), except `ad_spend.date` which is `'YYYY-MM-DD'` because Meta's
API returns dates that way.

Applied in order via `wrangler d1 migrations apply`. Migration 0005 was
skipped in prod history and is intentionally absent here.

## `sessions`

One row per visitor. Keyed by `session_id` (the `_rugido_sid` cookie).
Written by `functions/_middleware.js` via UPSERT on every HTML page load.
Read by `functions/tracker.js` and `functions/checkout-session.js` to
enrich outgoing events with server-captured attribution.

| Column | Type | Purpose |
|---|---|---|
| `session_id` | TEXT PK | UUID, matches `_rugido_sid` cookie |
| `external_id` | TEXT | UUID, matches `_rugido_eid` cookie — used as Meta Advanced Matching `external_id` |
| `fbclid` | TEXT | Raw value from URL, undecoded |
| `gclid` | TEXT | Google Ads click id |
| `msclkid` | TEXT | Microsoft Ads click id |
| `fbc` | TEXT | Meta spec: `fb.{subdomainIndex}.{ts}.{fbclid}` |
| `fbp` | TEXT | Meta spec: `fb.{subdomainIndex}.{ts}.{10-digit random}` |
| `ip_address` | TEXT | From `cf-connecting-ip` |
| `user_agent` | TEXT | From `user-agent` header |
| `referrer` | TEXT | From `referer` header |
| `landing_url` | TEXT | Full URL of the first page the visitor landed on |
| `utm_source` | TEXT | UTM parameter (added in migration 0011) |
| `utm_medium` | TEXT | |
| `utm_campaign` | TEXT | |
| `utm_content` | TEXT | |
| `utm_term` | TEXT | |
| `created_at` | INTEGER | Unix seconds, first visit |
| `updated_at` | INTEGER | Unix seconds, last visit |

**Index**: `idx_sessions_created` on `created_at`.

**UPSERT behavior**: `fbclid` / `gclid` / `msclkid` / `fbc` / `utm_*` use
CASE-WHEN-empty — a return visit without the parameter keeps the original
value; a return visit WITH a different parameter overwrites.

## `event_log`

One row per non-PageView event. Written by `functions/tracker.js` in
`waitUntil`. Read by `functions/api/events.js` (tracking health) and
`functions/api/leads.js` (lead list with UTMs via JOIN on `sessions`).

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Auto |
| `session_id` | TEXT | JOIN key back to `sessions` |
| `event_name` | TEXT | `Lead`, `InitiateCheckout`, `CompleteRegistration`, etc. — NEVER `PageView` |
| `event_id` | TEXT | UUID, dedup key with Meta browser pixel |
| `timestamp` | INTEGER | Unix seconds |
| `browser` / `browser_version` / `os` / `is_mobile` | TEXT / INTEGER | Parsed from UA |
| `pixel_was_blocked` | INTEGER | 1 if client sent no `fbp` and no `fbc` |
| `fbp_source` | TEXT | `pixel_js` / `middleware_http` / `tracker_http` / `none` |
| `fbc_source` | TEXT | Same domain |
| `fbclid_source` | TEXT | `server_middleware` / `client_url` / `none` |
| `ga_cookie_present` | INTEGER | 1 if `_ga` cookie existed |
| `ga_client_id_fallback` | INTEGER | 1 if we synthesized the client_id instead of parsing it |
| `itp_cookie_extended` | INTEGER | 1 if we recovered `fbp` from the middleware HTTP cookie (i.e. ITP truncated the JS cookie) |
| `is_bot` / `bot_reason` | INTEGER / TEXT | From `detectBot()` |
| `consent_status` | TEXT | Recipient-defined; defaults to `unknown` |
| `sent_to_meta` / `meta_response_ok` | INTEGER | Fire + ack |
| `sent_to_ga4` / `ga4_response_ok` | INTEGER | Same |
| `has_email` / `has_phone` / `has_name` | INTEGER | Coverage flags for dashboard |
| `meta_response_body` | TEXT | Raw Meta response, for debugging (added 0010) |
| `raw_email` | TEXT | Unhashed, for dashboard display of lead list (added 0010) |

**Indexes**: `idx_event_log_timestamp`, `idx_event_log_event_name`,
`idx_event_log_browser`.

## `checkout_sessions`

One row per sales-page visit (technically per `trk`). Written by
`functions/checkout-session.js` with `INSERT OR REPLACE`. Read by
`functions/webhook/_core.js` when a webhook arrives — this is the
enrichment join that makes purchase-time attribution work.

| Column | Type | Purpose |
|---|---|---|
| `trk` | TEXT PK | UUID from the sales page |
| `session_id` | TEXT | Join key back to `sessions` |
| `ip_address` / `user_agent` | TEXT | Captured at checkout intent time |
| `external_id` | TEXT | From cookie / sessions row |
| `fbp` / `fbc` | TEXT | Resolved with fallback chain |
| `gclid` / `gbraid` / `wbraid` | TEXT | Google Ads click ids |
| `ga_client_id` | TEXT | Parsed from `_ga` cookie (added 0009); fallback to synthetic |
| `utm_source` / `utm_medium` / `utm_campaign` / `utm_content` / `utm_term` | TEXT | UTMs at checkout-intent time |
| `event_source_url` | TEXT | Full URL of the sales page |
| `created_at` | INTEGER | Unix seconds |

**Index**: `idx_checkout_sessions_created` on `created_at`.

## `purchase_log`

One row per successful webhook-processed purchase. Written by
`functions/webhook/_core.js` in `waitUntil`. Read by the dashboard
(`api/revenue.js`, `api/products.js`, `api/attribution.js`,
`api/utm-breakdown.js`, `api/purchases.js`).

The table is wide on purpose — it persists the full request/response for
every fan-out, so the dashboard can show which specific Meta error
rejected a specific sale without needing to re-run anything.

| Column group | Columns | Purpose |
|---|---|---|
| **Identity** | `id`, `trk`, `event_id`, `event_time`, `transaction_id` | `transaction_id` has a unique index (0012) to dedupe webhook retries |
| **PII (raw)** | `raw_email`, `raw_name`, `raw_phone` | For display in dashboard only; never leaves the recipient's infrastructure |
| **PII (hashed)** | `hashed_em`, `hashed_fn`, `hashed_ln`, `hashed_ph`, `hashed_external_id` | Exactly what went to Meta |
| **Navigation** | `client_ip_address`, `client_user_agent`, `fbp`, `fbc` | Copied from `checkout_sessions` at enrichment time |
| **Purchase data** | `value`, `currency`, `product_id`, `product_name` | `value` is REAL |
| **Event metadata** | `event_source_url`, `action_source` (default `website`) | |
| **Meta response** | `meta_status_code`, `meta_response_ok`, `meta_response_body`, `meta_payload_sent` | Full request + response |
| **GA4 response** | `ga4_status_code`, `ga4_response_ok`, `ga4_response_body`, `ga4_payload_sent` | Same |
| **Google Ads response** | `google_ads_status_code`, `google_ads_response_ok`, `google_ads_response_body`, `google_ads_payload_sent` | `response_ok = 0` if Google Ads returned 200 but the body had a `partialFailureError` |
| **Click IDs** | `gclid`, `gbraid`, `wbraid` | Copied from `checkout_sessions`; used by Google Ads fan-out |
| **UTMs (from webhook)** | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` | The webhook payload's UTMs (may differ from `sessions`/`checkout_sessions` if the platform appends its own) |
| **Encharge response** | `encharge_status_code`, `encharge_response_ok`, `encharge_response_body` | |
| **ManyChat response** | `manychat_status_code`, `manychat_response_ok`, `manychat_response_body` | |
| **Timestamp** | `created_at` | Unix seconds |

**Indexes**: `idx_purchase_log_trk`, `idx_purchase_log_created`,
`idx_purchase_log_event_id`, `idx_purchase_log_product_id`,
`idx_purchase_log_transaction_id` (unique — dedup guard).

**Migration history**: 0003 created it, 0004 added product + Encharge +
ManyChat columns, 0006 added Google Ads columns, 0007 added
`*_payload_sent` columns plus `ga4_response_body`, 0012 added the unique
transaction index.

## `purchase_items`

One row per line-item inside a purchase. Written by `_core.js` as a
`db.batch()` right after the `purchase_log` insert. Read by
`api/products.js` for per-product revenue breakdowns.

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Auto |
| `purchase_id` | INTEGER | FK → `purchase_log.id` |
| `transaction_id` | TEXT | Denormalized for direct lookup |
| `product_id` | TEXT NOT NULL | Platform's product ID |
| `product_name` | TEXT | |
| `value` | REAL NOT NULL | Line total |
| `currency` | TEXT NOT NULL | Defaults to parent or 'BRL' |
| `utm_source` / `utm_campaign` / `utm_medium` / `utm_content` / `utm_term` | TEXT | Denormalized from parent for cheap GROUP BY queries |
| `created_at` | INTEGER NOT NULL | Unix seconds |

**Indexes**: `idx_purchase_items_purchase` (on `purchase_id`),
`idx_purchase_items_product` (on `(product_id, created_at)`).

**Invariant**: `SUM(purchase_items.value) WHERE purchase_id = X` equals
`purchase_log.value` where `id = X`. Enforced by the rollback in
`handlePurchaseLog` — if any item insert fails, the parent row is
deleted so the invariant always holds.

## `ad_spend`

One row per `(platform, date, campaign_id, ad_id)` tuple. Written by
`functions/api/sync/meta-ads.js` on each cron run via UPSERT. Read by
`functions/api/attribution.js` for CPA/ROAS calculations.

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Auto |
| `platform` | TEXT | `meta` today; `google` is the slot for future Google Ads sync |
| `date` | TEXT | `'YYYY-MM-DD'` in the ad account's timezone |
| `campaign_id` | TEXT NOT NULL | Meta campaign ID |
| `campaign_name` | TEXT | |
| `ad_id` | TEXT | Nullable — Meta returns campaign-level first, ad-level later |
| `ad_name` | TEXT | |
| `spend_cents` | INTEGER NOT NULL | Integer cents to avoid float drift across sync runs |
| `currency` | TEXT DEFAULT 'BRL' | |
| `impressions` / `clicks` | INTEGER | |
| `synced_at` | INTEGER NOT NULL | Unix seconds |

**Indexes**: unique on `(platform, date, campaign_id, COALESCE(ad_id, ''))`
for UPSERT; `idx_ad_spend_date` and `idx_ad_spend_platform_date` for
dashboard range queries.

**Why integer cents**: Meta's API returns strings like `"19.47"`. Stored as
REAL, repeated sync runs would accumulate float drift. Stored as
`Math.round(parseFloat(x) * 100)`, totals are exact forever.

## `sync_log`

One row per `/api/sync/*` invocation. Written by the sync endpoint, read
by the dashboard's "last synced at" indicator.

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Auto |
| `platform` | TEXT NOT NULL | `meta` / `google` |
| `status` | TEXT NOT NULL | `ok` / `error` |
| `rows_upserted` | INTEGER | 0 on failure |
| `date_from` / `date_to` | TEXT | `'YYYY-MM-DD'` range pulled |
| `error_message` | TEXT | Null on success |
| `duration_ms` | INTEGER | For performance monitoring |
| `run_at` | INTEGER NOT NULL | Unix seconds |

**Index**: `idx_sync_log_platform_run_at` on `(platform, run_at DESC)`.

## Things NOT in the schema (deliberate)

- **No `leads` table.** Lead events live in `event_log` and are joined to
  `sessions` at query time for UTM display. Avoids duplicating
  attribution data.
- **No `customers` table.** Email is the de facto customer key; resolving
  "same email across purchases" is a reporting concern, not a schema
  concern.
- **No soft-delete columns.** Retention is handled out-of-band if the
  recipient needs it.
- **No `migration_history` table beyond what `wrangler d1 migrations
  apply` manages internally.** Don't add one.
