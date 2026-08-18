# Lead form page recipe

A lead form page captures a visitor's contact details and fires a `Lead`
event to Meta CAPI + GA4 Measurement Protocol. There is exactly one recipe
for this — the only thing that varies is which PII fields the form
collects. The starter in `examples/lead-form-page/index.html` is
**email-only** by default (lowest friction); add `ph`/`fn`/`ln` fields
if the funnel needs them.

## What the page must do

Every lead form page has the same five responsibilities:

1. **Let the middleware run.** Don't put the page under `/api/*`,
   `/webhook/*`, or `/dash` — those paths bypass middleware and you won't
   get a `_rugido_sid` cookie, which means no session row, which means no
   attribution. Any other path is fine.
2. **Load the GA4 first-party script**:
   ```html
   <script async src="/scripts/gtag.js?id=G-XXXXXXXXXX"></script>
   ```
   The `/scripts/[[path]].js` function proxies `googletagmanager.com` as
   first-party — not optional; ad blockers kill third-party gtag loads.
3. **Load the Meta Pixel** with `fbq('init', '<pixel_id>')` and fire
   `PageView` on load.
4. **On submit**, build a single `event_id` (UUID) and fire two copies of
   the Lead event: once via `fbq('track', 'Lead', {}, { eventID: eventId })`
   (browser) and once via `fetch('/tracker', ...)` (server). Meta dedupes
   them by `event_id`.
5. **Send the PII under the exact Meta keys** in `user_data`:

| Key | Meaning | Notes |
|---|---|---|
| `em` | Email | `/tracker` lowercases + trims + SHA-256 hashes |
| `fn` | First name | `/tracker` strips punctuation + lowercases + hashes |
| `ln` | Last name | Same as `fn` |
| `ph` | Phone | `/tracker` strips non-digits, strips leading zeros, hashes |

**Never** send keys like `email`, `firstName`, or `phoneNumber`. Meta's
Advanced Matching expects `em`/`fn`/`ln`/`ph` literally, and `tracker.js`
reads from those keys. Anything else silently becomes empty.

## PII field variants

The three variants reduce to "which of `em`, `fn`, `ln`, `ph` you fill
in". The starter ships the minimum case (just `em`); upsize by adding
form inputs and extending the `user_data` payload.

### Email-only (newsletter, content gate — **starter default**)
```js
user_data: {
  em: email,
}
```
No extra inputs needed. Meta still matches on `em` alone — the Advanced
Matching quality score drops vs. a fuller payload but the match rate is
already usable.

### Email + phone (WhatsApp funnel)
Add a `<input type="tel" id="phone" name="phone" required>` to the form
and extend `user_data`:
```js
user_data: {
  em: email,
  ph: phone,
}
```
Phone gets normalized server-side — send whatever the user typed
(`+55 (11) 98765-4321` becomes `5511987654321`).

### Email + phone + name (high-intent lead)
Add a `<input type="text" id="name" name="name" required>` on top of the
phone input, split on whitespace, and extend `user_data`:
```js
const nameParts = name.trim().split(/\s+/);
const fn = nameParts[0] || '';
const ln = nameParts.slice(1).join(' ') || '';
user_data: { em: email, fn, ln, ph: phone }
```
Full hash coverage maximizes Meta's Advanced Matching quality at the
cost of a longer form.

## The submit handler, annotated

From `examples/lead-form-page/index.html`:

```js
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  // 1. Single event_id for dedup
  const eventId = crypto.randomUUID();
  const eventTime = Math.floor(Date.now() / 1000);

  // 2. Browser pixel fire (will be deduped against server fire)
  try { fbq('track', 'Lead', {}, { eventID: eventId }); } catch (_) {}

  // 3. Server fire — authoritative
  const response = await fetch('/tracker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'Lead',
      event_id: eventId,
      event_time: eventTime,
      event_source_url: window.location.href,
      user_data: { em: email },
    }),
  });

  if (!response.ok) throw new Error(await response.text());

  // 4. Show thank-you, or redirect
  form.classList.add('hidden');
  thankYou.classList.remove('hidden');
});
```

## How UTMs show up in the dashboard

You don't need to send UTMs from the page. The middleware captured them
into `sessions` on the initial visit. The dashboard's Leads tab runs this
query:

```sql
SELECT e.*, s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, s.landing_url
FROM event_log e
LEFT JOIN sessions s ON e.session_id = s.session_id
WHERE e.event_name = 'Lead'
ORDER BY e.timestamp DESC
```

See `functions/api/leads.js`. If a lead shows up without UTMs but you know
it came from a UTM-tagged URL, the break is in Hop 1 — the middleware
didn't see the UTM, usually because the lead page is routed through a
proxy that stripped query params. Test with a fresh query-stringed URL
directly against your Pages domain.

## Multiple forms on one page

Same rules, same `/tracker` endpoint, but each form needs its own submit
handler and its own `event_id` per submission. If a form fires twice with
the same `event_id`, Meta's dedup window (~48h) will silently drop the
second event.

## Redirect vs inline thank-you

Both work. The starter uses inline (swap the form for a success div).
If you prefer a redirect:

```js
if (response.ok) {
  window.location.href = '/thank-you.html';
}
```

Use `window.location.replace(...)` instead of `href` if you don't want
the lead page in the back-button history — prevents form resubmits on
back navigation.

## What Claude should check after adding a lead page

1. Visit the new page in a browser with `utm_source=test` appended.
2. In DevTools → Application → Cookies, confirm `_rugido_sid` and `_fbp` are
   set.
3. Submit the form with a test email.
4. Network tab: `/tracker` returns 200 with `{"ok": true}`.
5. In Meta Events Manager → Test Events, look for the Lead event with the
   email already matched via Advanced Matching.
6. Query D1:
   ```
   wrangler d1 execute <db> --remote --command "SELECT event_name, raw_email, timestamp FROM event_log ORDER BY id DESC LIMIT 3"
   ```
   The test submission should be the top row.
7. Open `/dash?key=<DASH_KEY>`, go to the Leads tab, confirm the row shows
   `utm_source = test`.

If any step breaks, walk [docs/data-flow.md](../data-flow.md) starting at
Hop 1.
