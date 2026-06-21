/**
 * Claude routine trigger — server-side forwarder.
 *
 * The browser can't (and shouldn't) hold the trigger secret, so the
 * Planner POSTs here and this function forwards the request to your
 * Claude routine webhook using the CLAUDE_TRIGGER environment variable
 * (set in Netlify → Site settings → Environment variables).
 *
 *   CLAUDE_TRIGGER        – the webhook URL to POST to (required)
 *   CLAUDE_TRIGGER_TOKEN  – optional bearer token, sent as Authorization
 */

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });
  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'Use POST.' }, { status: 405, headers: cors });
  }

  const target = process.env.CLAUDE_TRIGGER;
  if (!target) {
    return Response.json(
      { ok: false, error: 'CLAUDE_TRIGGER env var is not set on this site.' },
      { status: 500, headers: cors },
    );
  }

  let body = '{}';
  try { body = (await req.text()) || '{}'; } catch { /* keep default */ }

  const headers = { 'content-type': 'application/json' };
  if (process.env.CLAUDE_TRIGGER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.CLAUDE_TRIGGER_TOKEN}`;
  }

  try {
    const resp = await fetch(target, { method: 'POST', headers, body });
    const text = await resp.text();
    return new Response(text || JSON.stringify({ ok: resp.ok, status: resp.status }), {
      status: resp.ok ? 200 : resp.status,
      headers: { 'content-type': resp.headers.get('content-type') || 'application/json', ...cors },
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 502, headers: cors });
  }
};
