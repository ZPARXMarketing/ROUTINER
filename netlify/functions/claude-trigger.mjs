/**
 * Claude routine trigger — server-side forwarder.
 *
 * Fires an Anthropic Claude Code routine and (optionally) appends the
 * routine's prompt as an extra turn in that session. The browser POSTs
 * here; this function adds the auth + beta headers server-side so the
 * token never reaches the client.
 *
 * Netlify environment variables (Site settings → Environment variables):
 *   CLAUDE_TRIGGER        – the routine trigger id ("trig_…") OR the full
 *                           fire URL. Required.
 *   CLAUDE_TOKEN          – Anthropic bearer token ($TOKEN in the example).
 *                           Required. (ANTHROPIC_API_KEY / CLAUDE_TRIGGER_TOKEN
 *                           are accepted as aliases.)
 *   CLAUDE_ROUTINE_BETA   – optional override for the anthropic-beta header.
 *
 * Mirrors:
 *   curl -X POST https://api.anthropic.com/v1/claude_code/routines/<id>/fire \
 *     -H "Authorization: Bearer $TOKEN" \
 *     -H "anthropic-version: 2023-06-01" \
 *     -H "anthropic-beta: experimental-cc-routine-2026-04-01" \
 *     -H "Content-Type: application/json" \
 *     -d '{"text": "optional extra turn appended to the session"}'
 */

const BETA = process.env.CLAUDE_ROUTINE_BETA || 'experimental-cc-routine-2026-04-01';
const VERSION = '2023-06-01';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function resolveFireUrl(trigger) {
  if (!trigger) return null;
  if (/^https?:\/\//i.test(trigger)) return trigger;            // full URL provided
  if (/^trig_/.test(trigger)) {                                  // trigger id provided
    return `https://api.anthropic.com/v1/claude_code/routines/${trigger}/fire`;
  }
  return trigger;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });
  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'Use POST.' }, { status: 405, headers: cors });
  }

  const url = resolveFireUrl(process.env.CLAUDE_TRIGGER || process.env.CLAUDE_TRIGGER_URL);
  const token = process.env.CLAUDE_TOKEN || process.env.CLAUDE_TRIGGER_TOKEN || process.env.ANTHROPIC_API_KEY;

  if (!url) return Response.json({ ok: false, error: 'CLAUDE_TRIGGER env var is not set (trigger id or fire URL).' }, { status: 500, headers: cors });
  if (!token) return Response.json({ ok: false, error: 'No token — set CLAUDE_TOKEN (or ANTHROPIC_API_KEY) in Netlify env.' }, { status: 500, headers: cors });

  // The browser sends { text } (the routine's prompt) plus metadata.
  let incoming = {};
  try { incoming = JSON.parse((await req.text()) || '{}'); } catch { /* ignore */ }
  const text = incoming.text ?? incoming.prompt ?? '';

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': VERSION,
        'anthropic-beta': BETA,
        'content-type': 'application/json',
      },
      body: JSON.stringify(text ? { text } : {}),
    });
    const body = await resp.text();
    return new Response(body || JSON.stringify({ ok: resp.ok, status: resp.status }), {
      status: resp.ok ? 200 : resp.status,
      headers: { 'content-type': resp.headers.get('content-type') || 'application/json', ...cors },
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 502, headers: cors });
  }
};
