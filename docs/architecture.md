# Architecture

This document is the long-form companion to `CLAUDE.md`. If you've read that
file you already know the shape; this one explains *why* each piece exists
and how they fit together.

## The problem this stack solves

Paid-traffic creators who run ads to lead pages and sales pages need two
things:

1. **Server-side conversion events** that survive iOS ITP, ad-blockers, and
   Firefox ETP — i.e. attribution that doesn't depend on the browser pixel
   loading and the cookie not being partitioned.
2. **First-party attribution persistence** — knowing which UTM / campaign /
   ad brought each specific lead and each specific sale, so they can judge
   traffic quality per source instead of trusting the ad platform's
   in-network reporting.

Stape, GTM Server-Side, and the ad-platform-owned integrations all solve
piece #1 but leave the recipient without #2 — the data either lives in the
ad platform only, or lives in a GTM container the recipient can't query.
This stack owns both halves by sitting on Cloudflare Pages with a D1
database and doing the persistence and the fan-out in the same worker.

## The two halves

The worker has two independent conversion flows. They share `sessions` and
the identifier-capture middleware, but nothing else.

### Flow A — Browser-initiated events (Lead, PageView, InitiateCheckout)

```
browser visits page
   → _middleware.js (sets _rugido_sid, _fbp, _fbc cookies, upserts sessions row)
   → page HTML loads (GA4 + Meta Pixel in the head)
   → user submits form / clicks CTA
   → client JS calls fetch('/tracker', {...})
   → functions/tracker.js
        • SHA-256 hashes em/fn/ln/ph
        • enriches fbp/fbc/external_id from D1 sessions row
        • fires Meta CAPI + GA4 Measurement Protocol in parallel
        • logs to event_log (except PageView — dropped to save writes)
```

The browser pixel *also* fires the same event with the same `event_id`.
Meta dedupes them server-side. If the pixel is blocked, CAPI still fires.
If CAPI fails, the pixel still fires. Both paths independent, always.

### Flow B — Sales-platform webhooks (Purchase)

```
buyer arrives on sales page (Flow A middleware still runs here)
   → page JS generates `trk` (UUID, stored in sessionStorage)
   → page JS POSTs to /checkout-session with trk + UTMs
   → functions/checkout-session.js inserts checkout_sessions row
       carrying the full attribution snapshot (fbp, fbc, gclid, UTMs, ga_client_id)
   → buyer clicks CTA; page appends trk to the checkout URL in the
       platform's native custom-field name (tracker.code1 / xcod / sck)
   → buyer pays on the sales platform
   → sales platform POSTs its webhook to /webhook/<platform>/<slug>
   → functions/webhook/<platform>/[slug].js
        • checks params.slug against env.<PLATFORM>_WEBHOOK_SLUG (timing-safe)
        • wrong slug → 404 (indistinguishable from a missing route)
        • parses the platform's payload into the normalized shape
        • delegates to functions/webhook/_core.js
   → _core.js
        • SELECTs checkout_sessions by trk → pulls fbp, fbc, UTMs, gclid
        • fans out to Meta CAPI + GA4 MP + Google Ads (click conversions)
        • runs Encharge + ManyChat if per-product config matches
        • persists one purchase_log row + N purchase_items rows
```

The critical join is `checkout_sessions.trk` — that's what lets a webhook
arriving hours after the sale reach back to the original visit and enrich
the conversion with real attribution data. Without it, a sales-platform
webhook only knows about the buyer's email and the product; it has no idea
which ad they came from.

## Why each file exists

### `functions/_middleware.js`
Runs on every HTML page request (static assets, API calls, and
`/webhook/*` / `/api/*` / `/dash` are excluded). Responsibilities:

- Read cookies; generate `_rugido_sid` and `_rugido_eid` UUIDs if missing.
- Parse `fbclid` / `gclid` / `msclkid` from the raw query string (not
  `searchParams.get()` — that URL-decodes and Meta wants the raw value).
- Compute `SUB_DOMAIN_INDEX` from the Host header so `fb.1.*` / `fb.2.*`
  is correct for `.com` vs `.com.br` without recipient config.
- Build `_fbc` from `fbclid` if present, generate `_fbp` if missing.
- Set 400-day cookies on the response.
- Upsert the `sessions` row in the background via `waitUntil` so page
  latency isn't affected by D1.

### `functions/tracker.js`
Handles `POST /tracker`. Does three things that matter:

- **PII hashing** — SHA-256 after lowercase-and-trim normalization (phone
  strips non-digits and leading zeros; name strips punctuation).
- **Identifier fallback chain** — for each of `fbp` / `fbc` / `external_id`
  it tries multiple sources (client body → cookies → D1 sessions row) so
  ITP-truncated client cookies don't break attribution.
- **Bot + health tagging** — records `fbp_source`, `pixel_was_blocked`,
  `is_bot`, `bot_reason`, `itp_cookie_extended` on every event so the
  dashboard's Tracking Health section can show recovery rates.

PageView events are fired to Meta/GA4 but NOT logged to `event_log`. That's
an intentional write-volume cut (see the "Hard rules" section of
`CLAUDE.md`) — per-instance volume stays safe long-term.

### `functions/checkout-session.js`
Handles `POST /checkout-session`. Runs once per sales-page visit, writes
the full attribution snapshot keyed by `trk`. Extracts GA4 `client_id`
from the `_ga` cookie here because the webhook won't have cookies. Uses
`INSERT OR REPLACE` so a page refresh updates the row instead of failing
on the PK conflict.

### `functions/webhook/_core.js`
Platform-agnostic. Contract is documented at the top of the file: every
adapter must produce a normalized purchase object and call `processPurchase`.
`_core.js` handles lookup, fan-out, response parsing, and persistence.

Fan-out runs via `Promise.allSettled` — one failing handler never blocks
the others. The `purchase_log` insert happens in `waitUntil` so the
webhook returns quickly even when D1 is slow. `purchase_items` inserts run
as a `db.batch()`; if any item fails, the parent `purchase_log` row is
deleted to keep the invariant `SUM(items) = header`.

### `functions/webhook/<platform>/[slug].js`
Each adapter is ~80 lines: gate on URL slug, parse payload, delegate.
They never import from each other and never branch on platform — if you
find yourself adding `if (platform === 'hotmart')` in `_core.js`, push
the logic back into the adapter instead.

The `[slug]` path segment is Cloudflare Pages dynamic routing — the
platform adapter receives `context.params.slug` and compares it to the
per-platform env var via `guardSlug()` from `functions/webhook/_utils.js`.
Wrong slug returns 404 (not 401 or 403) so a scanner can't even tell the
route exists, let alone try to attack it.

### `functions/webhook/_utils.js`
Two helpers: `timingSafeEqual(a, b)` for constant-time string comparison,
and `guardSlug(paramSlug, expectedSlug)` which returns a 500 Response if
the env var is unset, a 404 Response if the slug is wrong, or `null` if
the slug is valid.

### `functions/api/*.js`
Read-only dashboard endpoints. All gated by `DASH_KEY`. Each one owns one
section of the dashboard and reads from a specific table (`revenue` and
`products` from `purchase_log` + `purchase_items`, `leads` from `event_log`
joined to `sessions`, `attribution` joins `ad_spend`, `events` reads
tracking-health columns from `event_log`).

### `functions/api/sync/meta-ads.js`
Gated by `SYNC_SECRET` header — a separate secret from `DASH_KEY` so the
external cron that calls this endpoint can't also read dashboard data. One
call per hour pulls yesterday + today from the Meta Marketing API and
UPSERTs into `ad_spend`. The dashboard reads `ad_spend` directly; there's
no real-time Meta API call in the request path.

### `dash/index.html`
Self-contained HTML served at `/dash`. Tailwind + Chart.js via CDN, no
build step. Query parameter `?key=<DASH_KEY>` is the only auth — it's a
read-only dashboard with no write paths, so key rotation is the full
control surface.

## Why Cloudflare Pages + D1 specifically

- **No cold starts, no regional routing** — conversion requests hit the
  closest Cloudflare PoP, which is usually lower-latency than the
  recipient's own origin would be.
- **Workers and D1 share the same edge** — the worker can read/write D1
  without a network hop.
- **Free tier covers real usage** — at ~3k visits/day and 150 sales/day the
  live reference implementation is comfortably inside the free tier. This
  matters because recipients run their own accounts.
- **Deploy is hybrid: `wrangler` for D1, GitHub + dashboard for Pages** —
  the `deploy-stack` skill uses `wrangler` only to create the D1 database
  and apply migrations. Everything else is direct: `gh` creates a private
  GitHub repo, the recipient connects that repo to a Pages project in the
  Cloudflare dashboard, and every `git push` thereafter triggers an
  auto-redeploy. No Docker, no CI, no Terraform.

## What this stack deliberately does NOT do

- **No retry queue for failed fan-outs.** If Meta CAPI returns 500, the
  event is lost. At per-instance volume this is acceptable; a retry queue
  would add operational complexity (DLQ, poison-pill handling, alerting)
  that isn't worth it. If you need guaranteed delivery, put Cloudflare
  Queues in front of the handler yourself.
- **No PII retention worker.** Raw email/name/phone sit in D1 indefinitely.
  The recipient is responsible for their own retention policy (GDPR,
  LGPD). The template documents the default and ships no enforcement.
- **No rate limiting on `/tracker` and `/checkout-session`.** These
  endpoints are public and unauthenticated by design (the browser fires
  them). If you get DDoSed, enable Cloudflare rate-limiting rules at the
  dashboard level — not in the worker code.
- **No platform-native signature verification** (HMAC-SHA256 for Eduzz,
  `hottok` for Hotmart, HMAC-SHA1 for Kiwify). Webhook endpoints are
  gated only by an unguessable per-recipient URL slug. This is the same
  pattern n8n / Zapier / GitHub / Stripe use for webhook endpoints. The
  post-launch `harden-tracking` skill layers real HMAC verification on
  top for recipients who want defense-in-depth.
- **No alerting.** There is no "webhook failed" page or email. The
  dashboard's Tracking Health section surfaces aggregate issues; recipients
  should check it weekly.

These are explicit Level-2 features, out of scope for v1. The philosophy is
"ship the 20% that delivers 95% of the value, let the recipient harden
what their specific scale demands."

## Where to go next

- Identifier chain, hop-by-hop, with example payloads at each step:
  [docs/data-flow.md](data-flow.md)
- Every D1 table, column by column: [docs/schema.md](schema.md)
- Lead-page recipe: [docs/page-types/lead-form-page.md](page-types/lead-form-page.md)
- Sales-page recipe: [docs/page-types/sales-page.md](page-types/sales-page.md)
- Per-platform webhook notes: [docs/platforms/](platforms/)
