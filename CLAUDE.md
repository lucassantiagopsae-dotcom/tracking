# Tracking Stack Template

> This file is Claude Code's anchor. It is loaded into the context of every
> conversation in this repo. Keep it under ~200 lines. Put detailed reference
> in `docs/` and procedural walkthroughs in `.claude/skills/`.

## What this repo is

A Cloudflare Pages + D1 tracking stack that captures first-party attribution
data, fires server-side conversion events to Meta CAPI / GA4 / Google Ads,
and ships a built-in dashboard that shows revenue, products, UTMs, and
tracking health. It replaces Stape + GTM Server-Side for creators running
paid traffic to lead or sales pages.

Each recipient deploys their own copy in their own Cloudflare account with
their own D1 database. There is no shared backend. The template is designed
to be unpacked into a blank folder and driven from Claude Code.

**The stack does three things:**

1. **Server-side conversions** with ITP-resistant identifier capture (400-day
   first-party cookies, edge-set `fbp`/`fbc`, GA4 client ID parsing, event
   deduplication between browser pixel and server CAPI).
2. **First-party attribution persistence** — every lead and every purchase
   stores its UTMs, `fbp`/`fbc`, `gclid`, and originating session, so the
   dashboard can show where each conversion came from.
3. **A self-contained dashboard** at `/dash` with six sections: revenue,
   product sales, paid-traffic attribution with Meta spend/CPA/ROAS, UTM
   breakdown, recent leads with UTMs, and tracking health (ITP recovery,
   adblock recovery, bot filters).

## Triage: what to do when a recipient starts a conversation

If the recipient has **just unpacked the template into a blank folder** and
the repo is otherwise untouched, invoke the `deploy-stack` skill.

If a recipient is asking **"is my tracking working"** or **"why isn't my
Meta dashboard showing conversions"**, invoke `verify-tracking`.

If they want to **add another lead page or sales page**, invoke `add-page`.

If they say **"I use [sales platform not in Eduzz/Hotmart/Kiwify]"**, invoke
`add-sales-platform`.

For anything else, ask a clarifying question before reaching for a skill.

## Identifier chain

Every visit generates identifiers at the edge, persists them to D1, and
threads them through the checkout flow so the webhook can enrich the
purchase with its original attribution.

| Identifier | Origin | Storage | Used by |
|---|---|---|---|
| `_rugido_sid` | Middleware, UUID per visit | 400d cookie + `sessions` row | Joins every event to its originating visit |
| `fbp` | Middleware, Meta spec `fb.2.{ts}.{rand}` | Cookie + `sessions.fbp` | Meta CAPI |
| `fbc` | Middleware, derived from `fbclid` URL param | Cookie + `sessions.fbc` | Meta CAPI |
| `ga_client_id` | Parsed from GA4's `_ga` cookie at edge | `checkout_sessions.ga_client_id` | GA4 Measurement Protocol |
| `trk` | Sales page JS, UUID per checkout intent | `checkout_sessions.trk` (unique) | Webhook lookup after purchase |
| `event_id` | Client, UUID per event | `event_log`, `purchase_log` | Dedup between browser pixel and server CAPI |
| `external_id` | Middleware, UUID per visitor | Cookie + `sessions.external_id` | Meta Advanced Matching |

**The `trk` chain is the critical one for sales pages**: generated on the
sales page visit → persisted to `checkout_sessions` with all attribution →
passed to the sales platform as a custom field (`tracker.code1` for Eduzz,
`xcod` for Hotmart, `sck` for Kiwify) → returned in the webhook payload →
looked up to enrich the Meta/GA4/Google Ads conversion.

Hop-by-hop debugging bible: `docs/data-flow.md`

## Hard rules (do not violate)

- **Never log PageView events to `event_log`.** PageView still fires to
  Meta/GA4 — it just doesn't write to D1. This keeps per-instance D1 write
  volume sustainable forever. Enforced at `functions/tracker.js:118`.
- **Never commit secrets.** `wrangler.toml`, `.dev.vars`, `.env*` are all
  gitignored. Only `wrangler.toml.example` is tracked. Product configuration
  (`config/products.js`) IS tracked — product IDs and tag IDs are not secrets.
- **Always use parameterized SQL.** Every D1 query uses `.bind()`. No string
  interpolation of user input, ever.
- **Hash PII before sending to ad platforms.** Email, phone, name get SHA-256
  hashed after lowercase-and-trim normalization (phone additionally strips
  non-digits and leading zeros). Raw PII persists in D1 for debugging only
  and never leaves the recipient's own infrastructure.
- **Per-platform webhook adapter pattern.** Each sales platform has its own
  file at `functions/webhook/<platform>/[slug].js` that gates on the URL
  slug, then parses the platform's payload into the normalized shape. The
  shared lookup/enrichment/fan-out lives in `functions/webhook/_core.js`.
  When adding a new platform, copy an existing adapter as a structural
  reference — do not add platform branching to `_core.js`.
- **Webhook endpoints are gated by an obscure URL.** Every platform has a
  per-recipient UUID v4 slug stored as `env.<PLATFORM>_WEBHOOK_SLUG`. The
  adapter's full path is `/webhook/<platform>/<slug>`; wrong slug returns
  404 (indistinguishable from a missing route). `deploy-stack` generates
  the UUIDs automatically and prints the full URLs for the recipient to
  paste into each platform's dashboard. Platform-native signature
  verification (HMAC/hottok) is deliberately deferred to the post-launch
  `harden-tracking` skill — adding it pre-launch was judged too high-friction
  for 1000+ non-dev recipients. A missing `<PLATFORM>_WEBHOOK_SLUG` env var
  is a deploy-blocking 500 on the endpoint, not a silent accept.
- **Dashboard and sync endpoints have separate secrets.** `DASH_KEY` gates
  `/dash` and `/api/*` reads. `SYNC_SECRET` gates `/api/sync/*` writes from
  external cron. Never reuse the same value for both.

## File map

### Edge runtime (`functions/`)

| Path | Purpose |
|---|---|
| `_middleware.js` | Runs on every page request. Generates `_rugido_sid`, captures `fbclid`/`gclid`/UTMs, computes `SUB_DOMAIN_INDEX` from the Host header, sets 400-day cookies, upserts `sessions`. Skips `/tracker`, `/webhook/*`, `/api/*`, `/dash`. |
| `tracker.js` | `POST /tracker` — client events. Hashes PII, fires Meta CAPI + GA4 MP, logs to `event_log` (PageView skipped). |
| `checkout-session.js` | `POST /checkout-session` — persists `trk` + attribution when a sales-page loads or a checkout button fires. |
| `scripts/[[path]].js` | First-party proxy for `gtag.js`. Example pages load GA4 via `/scripts/gtag.js?id=...`. |
| `webhook/_core.js` | Platform-agnostic brain: lookup `trk` → enrich → fan out to Meta/GA4/Google Ads/Encharge/ManyChat → persist `purchase_log` + `purchase_items`. |
| `webhook/_utils.js` | `timingSafeEqual` + `guardSlug` helpers shared by adapters. |
| `webhook/eduzz/[slug].js` | Eduzz adapter. Gates on `EDUZZ_WEBHOOK_SLUG`, parses Eduzz shape, delegates to `_core.js`. |
| `webhook/hotmart/[slug].js` | Hotmart adapter. Gates on `HOTMART_WEBHOOK_SLUG`, parses Hotmart shape. |
| `webhook/kiwify/[slug].js` | Kiwify adapter. Gates on `KIWIFY_WEBHOOK_SLUG`, parses Kiwify shape. |
| `api/revenue.js` | Dashboard: gross revenue, sales, AOV, daily time series from `purchase_log`. |
| `api/products.js` | Dashboard: per-product breakdown + time series from `purchase_items`. |
| `api/utm-breakdown.js` | Dashboard: tabbed UTM drill-down from `purchase_log` with cascading filters. |
| `api/attribution.js` | Dashboard: meta/google/organic split + Meta CPA/ROAS (joins `ad_spend`). |
| `api/leads.js` | Dashboard: Lead events joined to `sessions` for originating UTMs. |
| `api/events.js` | Dashboard: tracking-health stats (ITP recovery, adblock, bot filter, fbp source). |
| `api/purchases.js` | Dashboard: purchases table with platform delivery status. |
| `api/sync/meta-ads.js` | `POST /api/sync/meta-ads` — cron-triggered Meta Marketing API pull into `ad_spend`. Gated by `SYNC_SECRET` header. |

### Schema, config, and static (`migrations/`, `config/`, `dash/`, `examples/`)

| Path | Purpose |
|---|---|
| `migrations/` | D1 schema, numbered 0001-0015 (0005 intentionally skipped). Applied via `wrangler d1 migrations apply`. Includes `sessions`, `checkout_sessions`, `event_log`, `purchase_log`, `purchase_items`, `ad_spend`, `sync_log`. |
| `config/products.js` | Per-product integration config: Encharge tag, ManyChat tag ID, Google Ads conversion action. Keyed by `platform → productId`. Tracked in git; no secrets. |
| `dash/index.html` | Self-contained dashboard. Tailwind + Chart.js via CDN, no build step. Auth via `DASH_KEY` query param. Click any Lead or Purchase row to inspect the exact payload sent to Meta/GA4/Google Ads and the response. |
| `examples/lead-form-page/index.html` | Lead form starter (email-only by default; add phone/name per `docs/page-types/lead-form-page.md`). Demonstrates the full pixel+CAPI dedup pattern. |
| `examples/sales-page/index.html` | Sales page starter. Demonstrates `trk` generation, `checkout-session` persistence, platform-switchable checkout URL rewriting. Ships with `assets/hero.webp` placeholder. |
| `docs/` | Reference — architecture, data flow, schema, per-page-type recipes, per-platform notes, ad-spend sync setup. |
| `.claude/skills/` | Procedural walkthroughs invoked by name when the recipient's request matches. |

## Skills

Invoke these when the recipient's request matches the trigger. All skills
live under `.claude/skills/<name>/SKILL.md`.

| Skill | Trigger phrases | What it does |
|---|---|---|
| `deploy-stack` | "set this up", "deploy this", "I just downloaded this", "first-time setup" | Phase A bootstrap, hybrid flow: uses `wrangler` only for D1 (create + migrations) and generates `wrangler.toml`; creates a private GitHub repo via `gh` and pushes; generates `DASH_KEY` and per-platform webhook slugs locally; hands off to the recipient for manual Pages-project creation, D1 binding, and env-var entry in the Cloudflare dashboard. Page deploys are driven by `git push` from then on. |
| `verify-tracking` | "is my tracking working", "check my tracking", "verify the chain" | Phase B: walks the 6-checkpoint Level 1 integrity chain (cookie → sessions row → checkout URL → webhook arrival → D1 lookup → platform receipt). |
| `add-page` | "add a lead page", "add a sales page", "create a landing page" | Copies the matching starter from `examples/`, reads `docs/page-types/*.md`, wires routing and platform-specific snippets. |
| `add-sales-platform` | "I use [platform not in Eduzz/Hotmart/Kiwify]" | Creates a new webhook adapter following `docs/platforms/_template.md` by copying an existing adapter as the structural reference. |

## Deep reference

| For… | Read |
|---|---|
| Architecture overview — how the pieces fit | `docs/architecture.md` |
| Identifier chain hop-by-hop with example payloads | `docs/data-flow.md` |
| D1 schema, every table, every column | `docs/schema.md` |
| Lead form recipe | `docs/page-types/lead-form-page.md` |
| Sales page recipe | `docs/page-types/sales-page.md` |
| Eduzz-specific notes | `docs/platforms/eduzz.md` |
| Hotmart-specific notes | `docs/platforms/hotmart.md` |
| Kiwify-specific notes | `docs/platforms/kiwify.md` |
| Adding a new sales platform | `docs/platforms/_template.md` |
| Setting up Meta Ads spend sync via external cron | `docs/ad-spend-sync.md` |

## Decisions the recipient must make

These have sensible defaults. Change them only if you know why.

| Decision | Default | How to change |
|---|---|---|
| Domain handling | `_middleware.js` computes the ETLD+1 sub-domain index from the Host header at runtime | No action — it self-configures, including `.com.br`, `.co.uk`, and other two-label TLDs |
| Timezone for Google Ads conversion timestamps | `-03:00` (São Paulo, DST-free since 2019) | Set `TIMEZONE_OFFSET` secret to any ISO offset (`+00:00`, `-05:00`, etc.) |
| Default phone country code | `55` (Brazil) — prepended to local-format phone numbers before hashing for Meta CAPI / ManyChat, per Meta Advanced Matching spec (digits must include country code + area code) | Set `DEFAULT_COUNTRY_CODE` secret to the recipient's ISO calling code (`1` US/CA, `44` UK, `351` Portugal, etc.). Detection is length-based — if a lead already typed a number at a plausible international length it passes through untouched. |
| PII retention window | Raw email/name/phone stored indefinitely | Manual: run a periodic `DELETE` via scheduled worker. Not enforced by default. |
| Which sales platforms are active | Eduzz / Hotmart / Kiwify all built in | A platform goes live once its `<PLATFORM>_WEBHOOK_SLUG` env var is set. Recipients paste the full `/webhook/<platform>/<slug>` URL into the platform's dashboard; wrong slug = 404 |
| Dashboard auth | Query param `?key=<DASH_KEY>` | Rotate by changing the env var; no code change |
| Ad-spend sync | Off until recipient configures Meta Ads cron (see `docs/ad-spend-sync.md`) | Set `META_ADS_ACCESS_TOKEN`, `META_ADS_ACCOUNT_ID`, `SYNC_SECRET` and schedule an external cron to hit `/api/sync/meta-ads` hourly |
