export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body = await request.json();
    const clientIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
    const userAgent = request.headers.get('user-agent') || '';
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    const userData = body.user_data || {};

    // --- Session enrichment from D1 ---
    let sessionData = {};
    const sessionId = cookies['_rugido_sid'] || '';
    if (sessionId && env.DB) {
      try {
        const row = await env.DB.prepare(
          'SELECT * FROM sessions WHERE session_id = ?'
        ).bind(sessionId).first();
        if (row) sessionData = row;
      } catch (e) {
        console.error('D1 session lookup error:', e.message);
      }
    }

    // --- Resolve fbp/fbc with fallback chain ---
    const fbp = validateFbCookie(userData.fbp) || validateFbCookie(cookies['_fbp']) || validateFbCookie(sessionData.fbp) || '';
    const fbc = validateFbCookie(sessionData.fbc) || validateFbCookie(cookies['_fbc']) || validateFbCookie(userData.fbc) || '';
    const externalId = userData.external_id || cookies['_rugido_eid'] || sessionData.external_id || '';

    // Track sources for analytics
    const fbpSource = userData.fbp ? 'pixel_js'
      : (cookies['_fbp'] ? 'middleware_http'
        : (sessionData.fbp ? 'tracker_http' : 'none'));
    const fbcSource = sessionData.fbc ? 'middleware_http'
      : (cookies['_fbc'] ? 'middleware_http'
        : (userData.fbc ? 'pixel_js' : 'none'));
    const fbclidSource = sessionData.fbclid ? 'server_middleware'
      : (userData.fbc ? 'client_url' : 'none');
    const pixelWasBlocked = (!userData.fbp && !userData.fbc) ? 1 : 0;

    // --- GA4 cookie parsing (READ ONLY) ---
    const gaClientIdFromCookie = extractGA4ClientId(cookies['_ga'] || '');
    const gaClientId = gaClientIdFromCookie
      || userData.ga_client_id
      || `${Date.now()}.${Math.floor(Math.random() * 1000000000)}`;
    const gaClientIdFallback = (!gaClientIdFromCookie && !userData.ga_client_id) ? 1 : 0;

    const gaSessionId = extractGA4SessionId(cookies) || body.event_time?.toString() || '';
    const gaCookiePresent = cookies['_ga'] ? 1 : 0;

    // --- PII normalization + SHA-256 hashing ---
    async function sha256(value) {
      if (!value) return '';
      const normalized = value.toLowerCase().trim();
      const encoded = new TextEncoder().encode(normalized);
      const buffer = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }

    // Meta CAPI expects phone digits INCLUDING country code + area code
    // (ex: `16505554444` or `5511987654321`). Users typing their own
    // number into a lead form almost never include the country code, so
    // we prepend a default. `countryCode` defaults to 55 (Brazil);
    // recipients elsewhere set `env.DEFAULT_COUNTRY_CODE` — see the
    // "decisions the recipient must make" table in CLAUDE.md.
    //
    // Detection is length-based and best-effort. A recipient whose
    // audience mixes country codes (rare for the target audience) gets
    // marginal mismatches; fixing that requires a real phone-parsing
    // library which is too heavy for an edge worker.
    function normalizePhone(ph, countryCode) {
      if (!ph) return '';
      const cc = String(countryCode || '55');
      const digits = ph.replace(/\D/g, '').replace(/^0+/, '');
      if (!digits) return '';
      // Already starts with the configured country code at a plausible
      // total length → leave as-is.
      if (digits.startsWith(cc) && digits.length >= cc.length + 8 && digits.length <= cc.length + 11) {
        return digits;
      }
      // Plausibly a locally-formatted number (no country code yet) → prepend.
      if (digits.length >= 8 && digits.length <= 11) {
        return cc + digits;
      }
      // Any other length (likely an already-international foreign number
      // whose country code isn't our default) → leave untouched.
      return digits;
    }

    // Meta Advanced Matching spec for fn/ln is lowercase only — do NOT
    // strip punctuation/accents. Meta's graph preserves apostrophes,
    // hyphens, and diacritics; stripping them breaks hash matches for
    // names like "O'Brien", "Garcia-Rodriguez", "João".
    function normalizeName(name) {
      if (!name) return '';
      return name.trim().toLowerCase();
    }

    const hashedEm = await sha256(userData.em);
    const hashedFn = await sha256(normalizeName(userData.fn));
    const hashedLn = await sha256(normalizeName(userData.ln));
    const hashedPh = await sha256(normalizePhone(userData.ph, env.DEFAULT_COUNTRY_CODE));
    const hashedExternalId = await sha256(externalId);

    // --- Bot detection ---
    const { isBot, botReason } = detectBot(userAgent);

    // --- Fan out to ad platforms (skipped for bot UAs) ---
    // Bots still get logged to event_log so the dashboard's bot-filter
    // tracking-health metric stays accurate; only the outbound CAPI /
    // GA4 fires are suppressed. Without this gate, every link-unfurl
    // crawl (WhatsApp preview, Slackbot, facebookexternalhit, etc.)
    // would burn a Meta CAPI event and pollute the Pixel.
    const results = isBot ? [] : await Promise.allSettled([
      sendToMeta({ body, clientIp, userAgent, fbp, fbc, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, sessionData, env }),
      sendToGA4({ body, gaClientId, gaSessionId, hashedEm, env }),
    ]);

    // --- Parse Meta result ---
    let metaStatusCode = 0, metaResponseOk = 0, metaResponseBody = '', metaPayloadSent = null;
    if (results[0]?.status === 'fulfilled' && results[0].value) {
      const v = results[0].value;
      metaPayloadSent = v.payload;
      if (v.skipped) {
        metaResponseBody = `skipped: ${v.skipped}`;
      } else if (v.response) {
        metaStatusCode = v.response.status;
        metaResponseOk = v.response.ok ? 1 : 0;
        try { metaResponseBody = await v.response.text(); } catch (e) { metaResponseBody = `Read error: ${e.message}`; }
      }
    } else if (results[0]?.status === 'rejected') {
      metaResponseBody = `Fetch error: ${results[0].reason?.message || 'unknown'}`;
    }

    // --- Parse GA4 result ---
    let ga4StatusCode = 0, ga4ResponseOk = 0, ga4ResponseBody = '', ga4PayloadSent = null;
    if (results[1]?.status === 'fulfilled' && results[1].value) {
      const v = results[1].value;
      ga4PayloadSent = v.payload;
      if (v.skipped) {
        ga4ResponseBody = `skipped: ${v.skipped}`;
      } else if (v.response) {
        ga4StatusCode = v.response.status;
        ga4ResponseOk = v.response.ok ? 1 : 0;
        try { ga4ResponseBody = await v.response.text(); } catch (e) { ga4ResponseBody = `Read error: ${e.message}`; }
      }
    } else if (results[1]?.status === 'rejected') {
      ga4ResponseBody = `Fetch error: ${results[1].reason?.message || 'unknown'}`;
    }

    const rawEmail = userData.em || '';

    // --- Log to D1 (background) ---
    // Skip PageView: conversions fire regardless of this log, and the health
    // dashboard only reports Lead/Purchase. Dropping PageView cuts ~70% of
    // event_log writes so per-instance D1 stays healthy long-term.
    const loggedEventName = (body.event_name || '').toLowerCase();
    const shouldLogEvent = loggedEventName !== 'pageview' && loggedEventName !== 'page_view';
    const browserInfo = parseBrowser(userAgent);
    context.waitUntil(
      (async () => {
        try {
          if (env.DB && shouldLogEvent) {
            await env.DB.prepare(`
              INSERT INTO event_log (
                session_id, event_name, event_id, timestamp,
                browser, browser_version, os, is_mobile,
                pixel_was_blocked, fbp_source, fbc_source, fbclid_source,
                ga_cookie_present, ga_client_id_fallback, itp_cookie_extended,
                is_bot, bot_reason, consent_status,
                sent_to_meta, meta_status_code, meta_response_ok, meta_response_body, meta_payload_sent,
                sent_to_ga4, ga4_status_code, ga4_response_ok, ga4_response_body, ga4_payload_sent,
                has_email, has_phone, has_name,
                raw_email
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              sessionId, body.event_name, body.event_id, body.event_time,
              browserInfo.browser, browserInfo.version, browserInfo.os, browserInfo.isMobile ? 1 : 0,
              pixelWasBlocked, fbpSource, fbcSource, fbclidSource,
              gaCookiePresent, gaClientIdFallback, fbpSource === 'middleware_http' ? 1 : 0,
              isBot ? 1 : 0, botReason, body.consent_status || 'unknown',
              isBot ? 0 : 1, metaStatusCode, metaResponseOk, metaResponseBody, metaPayloadSent ?? null,
              isBot ? 0 : 1, ga4StatusCode, ga4ResponseOk, ga4ResponseBody, ga4PayloadSent ?? null,
              hashedEm ? 1 : 0, hashedPh ? 1 : 0, (hashedFn || hashedLn) ? 1 : 0,
              rawEmail
            ).run();
          }
        } catch (e) {
          console.error('D1 log error:', e.message);
        }
      })()
    );

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  }
}

// -------------------------------------------------------
// META CAPI
// -------------------------------------------------------
async function sendToMeta({ body, clientIp, userAgent, fbp, fbc, hashedEm, hashedFn, hashedLn, hashedPh, hashedExternalId, sessionData, env }) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) {
    return { skipped: 'missing meta env', payload: null, response: null };
  }

  const metaUserData = {
    client_ip_address: clientIp,
    client_user_agent: userAgent,
  };

  if (hashedEm) metaUserData.em = [hashedEm];
  if (hashedFn) metaUserData.fn = [hashedFn];
  if (hashedLn) metaUserData.ln = [hashedLn];
  if (hashedPh) metaUserData.ph = [hashedPh];
  if (hashedExternalId) metaUserData.external_id = [hashedExternalId];
  if (fbp) metaUserData.fbp = fbp;
  if (fbc) metaUserData.fbc = fbc;

  const payload = {
    data: [{
      event_name: body.event_name,
      event_time: body.event_time,
      event_id: body.event_id,
      event_source_url: body.event_source_url || '',
      action_source: 'website',
      user_data: metaUserData,
    }],
  };

  if (env.META_TEST_EVENT_CODE) {
    payload.test_event_code = env.META_TEST_EVENT_CODE;
  }

  const payloadJson = JSON.stringify(payload);
  const response = await fetch(`https://graph.facebook.com/v25.0/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payloadJson,
  });
  return { payload: payloadJson, response };
}

// -------------------------------------------------------
// GA4 MEASUREMENT PROTOCOL — CONVERSIONS ONLY
// -------------------------------------------------------
async function sendToGA4({ body, gaClientId, gaSessionId, hashedEm, env }) {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) {
    return { skipped: 'missing ga4 env', payload: null, response: null };
  }

  const eventName = (body.event_name || '').toLowerCase();
  if (eventName === 'pageview' || eventName === 'page_view') {
    return { skipped: 'pageview', payload: null, response: null };
  }

  const ga4EventName = eventName === 'lead' ? 'generate_lead'
    : eventName === 'purchase' ? 'purchase'
    : eventName === 'initiatecheckout' ? 'begin_checkout'
    : eventName;

  const payload = {
    client_id: gaClientId,
    events: [{
      name: ga4EventName,
      params: {
        session_id: gaSessionId,
        engagement_time_msec: 100,
        page_location: body.event_source_url || '',
      },
    }],
  };

  if (hashedEm) {
    payload.user_properties = { email: { value: hashedEm } };
  }

  const payloadJson = JSON.stringify(payload);
  const response = await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payloadJson,
  });
  return { payload: payloadJson, response };
}

// -------------------------------------------------------
// HELPERS
// -------------------------------------------------------

function validateFbCookie(value) {
  if (!value) return '';
  const parts = value.split('.');
  if (parts.length < 4 || parts.length > 5) return '';
  if (parts[0] !== 'fb') return '';
  if (!/^\d+$/.test(parts[1])) return '';
  if (!/^\d+$/.test(parts[2])) return '';
  if (!parts[3]) return '';
  return value;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  });
  return cookies;
}

function extractGA4ClientId(gaCookie) {
  if (!gaCookie) return '';
  const parts = gaCookie.split('.');
  return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : '';
}

function extractGA4SessionId(cookies) {
  for (const [name, value] of Object.entries(cookies)) {
    if (name.startsWith('_ga_') && name !== '_ga') {
      if (!value) continue;
      if (value.startsWith('GS2')) {
        const mainPart = value.split('.').slice(2).join('.');
        const segments = mainPart.split('$');
        for (const seg of segments) {
          if (seg.startsWith('s') && seg.length > 1) {
            const candidate = seg.slice(1);
            if (/^\d+$/.test(candidate)) return candidate;
          }
        }
      } else {
        const parts = value.split('.');
        if (parts.length >= 3) {
          const candidate = parts[2];
          if (/^\d+$/.test(candidate)) return candidate;
        }
      }
    }
  }
  return '';
}

function detectBot(userAgent) {
  if (!userAgent || userAgent.length < 10) {
    return { isBot: true, botReason: 'Missing or short user-agent' };
  }
  const patterns = [
    { p: /googlebot|google-inspectiontool/i, r: 'Googlebot' },
    { p: /bingbot|msnbot/i, r: 'Bingbot' },
    { p: /facebookexternalhit|facebot/i, r: 'Facebook crawler' },
    { p: /twitterbot/i, r: 'Twitter crawler' },
    { p: /linkedinbot/i, r: 'LinkedIn crawler' },
    { p: /slackbot/i, r: 'Slackbot' },
    { p: /whatsapp/i, r: 'WhatsApp preview' },
    { p: /bot|crawler|spider|scraper|headless/i, r: 'Generic bot' },
    { p: /python-requests|axios|node-fetch|curl|wget|httpie/i, r: 'HTTP library' },
    { p: /phantomjs|selenium|puppeteer|playwright/i, r: 'Automation tool' },
  ];
  for (const { p, r } of patterns) {
    if (p.test(userAgent)) return { isBot: true, botReason: r };
  }
  return { isBot: false, botReason: '' };
}

function parseBrowser(ua) {
  const r = { browser: 'Unknown', version: '', os: 'Unknown', isMobile: false };
  if (!ua) return r;
  r.isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  if (/Edg\//i.test(ua)) { r.browser = 'Edge'; r.version = ua.match(/Edg\/([\d.]+)/)?.[1] || ''; }
  else if (/OPR\//i.test(ua)) { r.browser = 'Opera'; r.version = ua.match(/OPR\/([\d.]+)/)?.[1] || ''; }
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) { r.browser = 'Chrome'; r.version = ua.match(/Chrome\/([\d.]+)/)?.[1] || ''; }
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) { r.browser = 'Safari'; r.version = ua.match(/Version\/([\d.]+)/)?.[1] || ''; }
  else if (/Firefox\//i.test(ua)) { r.browser = 'Firefox'; r.version = ua.match(/Firefox\/([\d.]+)/)?.[1] || ''; }
  if (/Windows/i.test(ua)) r.os = 'Windows';
  else if (/Mac OS X/i.test(ua)) r.os = 'macOS';
  else if (/iPhone|iPad/i.test(ua)) r.os = 'iOS';
  else if (/Android/i.test(ua)) r.os = 'Android';
  else if (/Linux/i.test(ua)) r.os = 'Linux';
  return r;
}
