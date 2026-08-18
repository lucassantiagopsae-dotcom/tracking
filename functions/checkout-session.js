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

    const trk = body.trk;
    if (!trk) {
      return new Response(JSON.stringify({ error: 'Missing trk' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Enrich with D1 session data (server-captured fbp/fbc are more reliable)
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

    // Priority: client cookies (set by Pixel JS) → D1 session (middleware) → body fallback
    const fbp = cookies['_fbp'] || sessionData.fbp || body.fbp || '';
    const fbc = cookies['_fbc'] || sessionData.fbc || body.fbc || '';
    const externalId = cookies['_rugido_eid'] || sessionData.external_id || body.external_id || '';
    const gclid = sessionData.gclid || body.gclid || '';
    const gbraid = body.gbraid || '';
    const wbraid = body.wbraid || '';
    // Extract GA4 client_id from _ga cookie (format: GA1.1.{timestamp}.{random})
    const gaCookie = cookies['_ga'] || '';
    const gaClientId = gaCookie ? gaCookie.split('.').slice(-2).join('.') : '';
    const now = Math.floor(Date.now() / 1000);

    if (env.DB) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO checkout_sessions (
          trk, session_id, ip_address, user_agent, external_id,
          fbp, fbc, gclid, gbraid, wbraid, ga_client_id,
          utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          event_source_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        trk, sessionId, clientIp, userAgent, externalId,
        fbp, fbc, gclid, gbraid, wbraid, gaClientId,
        body.utm_source || '', body.utm_medium || '', body.utm_campaign || '',
        body.utm_content || '', body.utm_term || '',
        body.event_source_url || '', now
      ).run();
    }

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

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  });
  return cookies;
}
