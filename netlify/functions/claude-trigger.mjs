/**
 * Claude routine trigger — server-side forwarder with auth gating.
 *
 * Fires an Anthropic Claude Code routine and appends the prompt as an extra
 * turn in that session. The browser POSTs here with the signed-in user's
 * Supabase access token; this function adds the Anthropic auth + beta headers
 * server-side so the token never reaches the client.
 *
 * Netlify environment variables (Site settings → Environment variables):
 *   CLAUDE_TRIGGER        – routine trigger id ("trig_…") OR full /fire URL. Required.
 *   CLAUDE_TOKEN          – Anthropic bearer token. Required.
 *                           (ANTHROPIC_API_KEY / CLAUDE_TRIGGER_TOKEN are aliases.)
 *   CLAUDE_ROUTINE_BETA   – optional override for the anthropic-beta header.
 *
 *   --- gating (optional; when set, callers must be authorized) ---
 *   ROUTINER_FIRE_SECRET  – shared secret the scheduler presents. SETTING THIS
 *                           TURNS GATING ON: browser callers must then send a
 *                           valid Supabase access token (Authorization: Bearer).
 *   ALLOWED_EMAILS        – optional comma-separated allowlist; when set, only
 *                           these signed-in emails may fire (locks out random
 *                           sign-ups). Omit to allow any signed-in user.
 */

const BETA = process.env.CLAUDE_ROUTINE_BETA || 'experimental-cc-routine-2026-04-01';
const VERSION = '2023-06-01';

// Public Supabase project values (anon key is safe to expose).
const SUPABASE_URL = 'https://vonfdzttupyemtomsojy.supabase.co';
const SUPABASE_ANON = 'sb_publishable_60-OPzmfueDopyogbm20pg_linElDjT';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

function resolveFireUrl(trigger) {
  if (!trigger) return null;
  if (/^https?:\/\//i.test(trigger)) return trigger;
  if (/^trig_/.test(trigger)) return `https://api.anthropic.com/v1/claude_code/routines/${trigger}/fire`;
  return trigger;
}

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function verifyUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return await r.json(); // { id, email, ... }
  } catch { return null; }
}

// Returns null if authorized, otherwise a Response to short-circuit with.
async function authorize(req) {
  const secret = process.env.ROUTINER_FIRE_SECRET;
  if (!secret) return null; // gating not configured → open (back-compat)

  const tok = bearer(req);
  if (tok && tok === secret) return null; // the scheduler

  const user = await verifyUser(tok);
  if (!user) {
    return Response.json({ ok: false, error: 'Unauthorized — sign in to fire routines.' }, { status: 401, headers: cors });
  }
  const allow = (process.env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes((user.email || '').toLowerCase())) {
    return Response.json({ ok: false, error: 'This account is not allowed to fire routines.' }, { status: 403, headers: cors });
  }
  return null;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });
  if (req.method !== 'POST') return Response.json({ ok: false, error: 'Use POST.' }, { status: 405, headers: cors });

  const denied = await authorize(req);
  if (denied) return denied;

  const url = resolveFireUrl(process.env.CLAUDE_TRIGGER || process.env.CLAUDE_TRIGGER_URL);
  const token = process.env.CLAUDE_TOKEN || process.env.CLAUDE_TRIGGER_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (!url) return Response.json({ ok: false, error: 'CLAUDE_TRIGGER env var is not set (trigger id or fire URL).' }, { status: 500, headers: cors });
  if (!token) return Response.json({ ok: false, error: 'No token — set CLAUDE_TOKEN (or ANTHROPIC_API_KEY) in Netlify env.' }, { status: 500, headers: cors });

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
