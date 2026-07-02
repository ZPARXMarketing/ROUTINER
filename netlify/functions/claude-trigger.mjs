/**
 * Claude routine trigger — server-side forwarder with auth gating.
 *
 * Fires an Anthropic Claude Code routine and appends the prompt as an extra
 * turn in that session. The browser POSTs here with the signed-in user's
 * Supabase access token; this function adds the Anthropic auth + beta headers
 * server-side so the token never reaches the client.
 *
 * Credential sources (checked in this order, per account):
 *   1. The signed-in user's in-app Settings — stored in Supabase
 *      `routiner_settings` (RLS per user) and read here server-side via the
 *      caller's access token. This is the zero-config path: a user just pops
 *      their trigger + token into the app's Settings and it works.
 *   2. Netlify environment variables (below) — used as a fallback, and for the
 *      scheduler which fires with the shared secret instead of a user session.
 *
 * Netlify environment variables (Site settings → Environment variables):
 *   CLAUDE_TRIGGER        – routine trigger id ("trig_…") OR full /fire URL.
 *   CLAUDE_TOKEN          – Anthropic bearer token.
 *                           (ANTHROPIC_API_KEY / CLAUDE_TRIGGER_TOKEN are aliases.)
 *   CLAUDE_ROUTINE_BETA   – optional override for the anthropic-beta header.
 *
 *   --- multi-account routing ---
 *   The browser sends an "account" id (e.g. "sparks9679", "zparxmarketing") in the
 *   POST body. For account <ID> this function looks for CLAUDE_TRIGGER_<ID> /
 *   CLAUDE_TOKEN_<ID> (id upper-cased, non-alphanumerics stripped), e.g.
 *     CLAUDE_TRIGGER_SPARKS9679       / CLAUDE_TOKEN_SPARKS9679
 *     CLAUDE_TRIGGER_ZPARXMARKETING   / CLAUDE_TOKEN_ZPARXMARKETING
 *   If a per-account var is missing it falls back to the legacy CLAUDE_TRIGGER /
 *   CLAUDE_TOKEN above, so the original single-account setup keeps working.
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

// Don't let a hung upstream stall the function: cap the auth/creds lookups and
// the fire itself. (Overridable via env for slow networks.)
const LOOKUP_TIMEOUT_MS = Number(process.env.ROUTINER_LOOKUP_TIMEOUT_MS) || 8000;
const FIRE_TIMEOUT_MS = Number(process.env.ROUTINER_FIRE_TIMEOUT_MS) || 20000;

// Public Supabase project values (anon key is safe to expose).
// FORKING? Replace these with your own Supabase project URL + publishable (anon) key
// (Supabase > Project Settings > API) — keep them in sync with js/config.js.
const SUPABASE_URL = 'https://vonfdzttupyemtomsojy.supabase.co';
const SUPABASE_ANON = 'sb_publishable_60-OPzmfueDopyogbm20pg_linElDjT';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-expose-headers': 'x-routiner-warning',
};

function resolveFireUrl(trigger) {
  if (!trigger) return null;
  if (/^https?:\/\//i.test(trigger)) return trigger;
  if (/^trig_/.test(trigger)) return `https://api.anthropic.com/v1/claude_code/routines/${trigger}/fire`;
  // Anything else is a misconfiguration (e.g. the Anthropic token was pasted
  // into CLAUDE_TRIGGER). Reject it instead of trying to fetch() a non-URL —
  // that throws an error whose text would leak the value back to the caller.
  return null;
}

// Resolve the trigger + token for a given account id, falling back to the
// legacy single-account vars when no per-account override is configured.
function resolveAccountCreds(account) {
  const suffix = String(account || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const env = process.env;
  const legacyTrigger = env.CLAUDE_TRIGGER || env.CLAUDE_TRIGGER_URL;
  const legacyToken = env.CLAUDE_TOKEN || env.CLAUDE_TRIGGER_TOKEN || env.ANTHROPIC_API_KEY;
  const trigger = (suffix && env[`CLAUDE_TRIGGER_${suffix}`]) || legacyTrigger;
  const token = (suffix && env[`CLAUDE_TOKEN_${suffix}`]) || legacyToken;
  return { trigger, token };
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
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return await r.json(); // { id, email, ... }
  } catch { return null; }
}

// Look up the caller's own per-account trigger+token from Supabase
// (routiner_settings, RLS per user) using their access token. Lets users
// configure everything in-app — no Netlify env vars needed. Returns
// { trigger, token } (either may be empty) or null when unavailable.
function pickCreds(accounts, account, triggerKey) {
  // New shape: array of { id, label, triggers: [ {id, label, trigger, token} ] }
  if (Array.isArray(accounts)) {
    const a = accounts.find((x) => x && x.id === account);
    if (!a) return null;
    const trigs = a.triggers || [];
    const t = (triggerKey && trigs.find((x) => x.id === triggerKey)) || trigs[0];
    return t ? { trigger: t.trigger || '', token: t.token || '' } : null;
  }
  // Old shape: { accountId: { trigger, token } }
  if (accounts && typeof accounts === 'object') {
    const a = accounts[account];
    return a ? { trigger: a.trigger || '', token: a.token || '' } : null;
  }
  return null;
}

async function loadUserCreds(accessToken, account, triggerKey) {
  if (!accessToken || !account) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/routiner_settings?select=accounts`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const accounts = (rows && rows[0] && rows[0].accounts) || {};
    return pickCreds(accounts, account, triggerKey);
  } catch { return null; }
}

// True when no gating secret is configured, so anyone who can reach this
// function can fire routines using the fallback env-var creds. Surfaced as a
// server-side warning + an x-routiner-warning response header so the
// misconfiguration is visible instead of silent.
const UNGATED = !process.env.ROUTINER_FIRE_SECRET;

// Returns null if authorized, otherwise a Response to short-circuit with.
async function authorize(req) {
  const secret = process.env.ROUTINER_FIRE_SECRET;
  if (!secret) {
    // gating not configured → open (back-compat), but make it loud.
    console.warn('[claude-trigger] UNGATED: ROUTINER_FIRE_SECRET is not set — anyone who can reach this endpoint can fire routines. Set it to require a signed-in user.');
    return null;
  }

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

  let incoming = {};
  try { incoming = JSON.parse((await req.text()) || '{}'); } catch { /* ignore */ }
  const text = incoming.text ?? incoming.prompt ?? '';
  const account = incoming.account ?? '';
  const triggerKey = incoming.triggerKey ?? null;
  // Resolved model the caller (app/scheduler) picked for this run. Only forward
  // Anthropic model ids to the routine's /fire — a non-Claude id (e.g. an
  // OpenRouter model) is meaningless here and could be rejected.
  const rawModel = incoming.model ?? null;
  const model = /^claude-/i.test(rawModel || '') ? rawModel : null;

  // Prefer the signed-in user's in-app settings; fall back to env vars per field.
  const accessToken = bearer(req);
  const userCreds = (accessToken && accessToken !== process.env.ROUTINER_FIRE_SECRET)
    ? await loadUserCreds(accessToken, account, triggerKey) : null;
  const envCreds = resolveAccountCreds(account);
  const trigger = (userCreds && userCreds.trigger) || envCreds.trigger;
  const token = (userCreds && userCreds.token) || envCreds.token;
  const url = resolveFireUrl(trigger);
  if (!url) return Response.json({ ok: false, error: `No trigger configured for account "${account || 'default'}" — add its trigger in the app's Settings, or set CLAUDE_TRIGGER_<ACCOUNT> in Netlify env. It must be a routine id (trig_…) or a full /fire URL.` }, { status: 500, headers: cors });
  if (!token) return Response.json({ ok: false, error: `No token for account "${account || 'default'}" — add its token in the app's Settings, or set CLAUDE_TOKEN_<ACCOUNT> in Netlify env.` }, { status: 500, headers: cors });

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': VERSION,
        'anthropic-beta': BETA,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...(text ? { text } : {}), ...(model ? { model } : {}) }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
    const body = await resp.text();
    return new Response(body || JSON.stringify({ ok: resp.ok, status: resp.status }), {
      status: resp.ok ? 200 : resp.status,
      headers: {
        'content-type': resp.headers.get('content-type') || 'application/json',
        ...(UNGATED ? { 'x-routiner-warning': 'ungated: ROUTINER_FIRE_SECRET not set' } : {}),
        ...cors,
      },
    });
  } catch (err) {
    // Never surface the raw error: it can embed the fire URL / token. Log it
    // server-side and return a generic message to the caller.
    console.error('claude-trigger fetch failed:', err);
    return Response.json({ ok: false, error: 'Failed to reach the Claude routine endpoint. Check CLAUDE_TRIGGER / CLAUDE_TOKEN.' }, { status: 502, headers: cors });
  }
};
