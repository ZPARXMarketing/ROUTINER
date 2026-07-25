// ============================================================================
// lead-parse.ts — self-contained parse + validation for research output.
//
// Ported from Abstrax's proven finder/discovery validators
// (lib/intel/modules/website-finder.ts + lib/intel/discovery/discover.ts) but
// with ZERO Abstrax imports so it runs in the Supabase edge runtime. Same
// discipline: a value that doesn't validate becomes null — the pipeline never
// promotes an invented phone/email/site into the Review tab.
// ============================================================================

import type { EnrichedLead, LeadEnrichment } from "./lead-schema.ts";

/** Hosts that are never a business's own website (social / directory / aggregator). */
const NON_SITE_HOSTS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com",
  "linkedin.com", "yelp.com", "google.com", "goo.gl", "maps.google.com",
  "g.page", "youtube.com", "pinterest.com", "yellowpages.com", "bbb.org",
  "mapquest.com", "foursquare.com", "tripadvisor.com", "angi.com", "thumbtack.com",
];

/** Read one `LABEL: value` line; NONE/blank/unknown → null. */
export function fieldFrom(block: string, label: string): string | null {
  const m = new RegExp(`^\\s*${label}:\\s*(.+)$`, "im").exec(block);
  const v = m?.[1]?.trim();
  if (!v || /^(none|n\/a|unknown|not found|not available)\b/i.test(v)) return null;
  return v.replace(/[.,;]+$/, "");
}

/** Trimmed, junk-rejected, length-capped plain text. */
export function cleanText(raw: string | null, maxLen = 120): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v) return null;
  return v.length > maxLen ? v.slice(0, maxLen).trim() : v;
}

/** Reduce any URL/host to a bare hostname; reject social/aggregator hosts. */
export function validateWebsite(raw: string | null): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").replace(/^www\./, "");
  host = host.split(/[/?#]/)[0].replace(/[.,;]+$/, "");
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  if (NON_SITE_HOSTS.some((bad) => host === bad || host.endsWith("." + bad))) return null;
  return host;
}

/** Keep the readable phone if it has 7–15 digits; also return an E.164 best-effort. */
export function validatePhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return raw.trim();
}

/** Best-effort E.164 for staged_leads.phone_e164 (approval re-normalizes anyway). */
export function toE164(raw: string | null): string | null {
  if (!raw) return null;
  const hasPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (hasPlus) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;          // bare US/CA
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;                                      // assume already country-coded
}

export function validateEmail(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

export function validateLinkedin(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  return /^linkedin\.com\/(company|in|school)\/[^/?#]+/.test(v) ? "https://" + v.split(/[?#]/)[0] : null;
}

/** Split a "City, ST" / "123 Main St, City, ST" address into {city, region}. */
export function splitCityRegion(address: string | null): { city: string | null; region: string | null } {
  if (!address) return { city: null, region: null };
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { city: null, region: null };
  // Last part is usually "ST" or "ST 35801" — take the 2-letter state if present.
  const tail = parts[parts.length - 1];
  const stateMatch = /\b([A-Z]{2})\b/.exec(tail);
  const region = stateMatch ? stateMatch[1] : (parts.length > 1 ? tail : null);
  const city = parts.length >= 2 ? parts[parts.length - 2] : (parts.length === 1 ? parts[0] : null);
  return { city: cleanText(city, 80), region: cleanText(region, 40) };
}

/** Heuristic 0–100 lead score: reward a real DM + reachable contact + own site. */
export function scoreLead(l: Omit<EnrichedLead, "lead_score">): number {
  let s = 40;
  if (l.contact_name) s += 20;
  if (l.phone_e164) s += 15;
  if (l.email || l.enrichment.dm_email) s += 10;
  if (l.website_domain) s += 10;
  if (l.enrichment.confidence === "high") s += 5;
  else if (l.enrichment.confidence === "low") s -= 10;
  return Math.max(0, Math.min(100, s));
}

/**
 * Parse a research completion into validated EnrichedLeads. Businesses are
 * separated by blank lines; each block is a set of `LABEL: value` lines (the
 * format the prompt demands). A block with no usable NAME is dropped; a name
 * seen earlier in the same batch is skipped.
 */
export function parseLeads(
  text: string,
  ctx: { niche: string; location: string | null; model: string; foundAt: string },
): EnrichedLead[] {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const out: EnrichedLead[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const name = cleanText(fieldFrom(block, "NAME"), 120);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const address = cleanText(fieldFrom(block, "ADDRESS"), 160);
    const { city, region } = splitCityRegion(address);
    const socialsRaw = fieldFrom(block, "SOCIALS");
    const socials = socialsRaw
      ? socialsRaw.split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s))
      : [];

    const confidenceRaw = /CONFIDENCE:\s*(high|medium|low)/i.exec(block)?.[1]?.toLowerCase();
    const enrichment: LeadEnrichment = {
      confidence: (confidenceRaw ?? null) as LeadEnrichment["confidence"],
      source: cleanText(fieldFrom(block, "SOURCE"), 80),
      note: cleanText(fieldFrom(block, "NOTE"), 240),
      dm_email: validateEmail(fieldFrom(block, "DM_EMAIL")),
      linkedin: validateLinkedin(fieldFrom(block, "LINKEDIN")),
      address,
      socials,
      model: ctx.model,
      found_at: ctx.foundAt,
    };

    const phone = validatePhone(fieldFrom(block, "PHONE"));
    const base = {
      business_name: name,
      website_domain: validateWebsite(fieldFrom(block, "WEBSITE")),
      phone_e164: toE164(phone),
      email: validateEmail(fieldFrom(block, "EMAIL")),
      city: city ?? (ctx.location ? cleanText(ctx.location.split(",")[0], 80) : null),
      region,
      categories: [ctx.niche],
      vertical: ctx.niche,
      source: `perplexity:${ctx.niche}${ctx.location ? `/${ctx.location}` : ""}`,
      contact_name: cleanText(fieldFrom(block, "CONTACT"), 80),
      contact_title: cleanText(fieldFrom(block, "TITLE"), 60),
      enrichment,
    };
    out.push({ ...base, lead_score: scoreLead(base) });
  }
  return out;
}

/**
 * Does this lead actually sit in the target area?
 *
 * Perplexity drifts: Huntsville targets have come back with Birmingham (205)
 * and Chattanooga (423) businesses, which then burn a Review-tab slot. We only
 * ever reject on a POSITIVE mismatch — a lead whose address we couldn't read
 * inherits the target city in `parseLeads`, so "unknown" must not be treated as
 * "wrong" or we'd throw away good leads for having a shy address line.
 *
 *   "confirmed" — the lead's own address agrees with the target
 *   "mismatch"  — the lead's own address names a different city AND/OR state
 *   "assumed"   — no usable address of its own; caller decides (we keep these)
 */
export function areaMatch(
  l: { city: string | null; region: string | null; enrichment: { address: string | null } },
  location: string | null,
): "confirmed" | "mismatch" | "assumed" {
  if (!location) return "assumed";
  // No address of its own → parseLeads back-filled the target city. Unknowable.
  if (!l.enrichment.address) return "assumed";

  const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
  const wantCity = (parts[0] ?? "").toLowerCase();
  const wantRegion = /\b([A-Za-z]{2})\b/.exec(parts[1] ?? "")?.[1]?.toUpperCase() ?? null;

  const gotCity = (l.city ?? "").toLowerCase();
  const gotRegion = (l.region ?? "").toUpperCase();

  // A different state is a hard mismatch — no metro spans two of them here.
  if (wantRegion && gotRegion && gotRegion.length === 2 && gotRegion !== wantRegion) return "mismatch";

  if (!wantCity || !gotCity) return "assumed";
  // Suburbs are legitimately "the metro", so accept either direction of
  // containment (Huntsville ⊃ "Huntsville", "Madison" ⊄ "Huntsville" → checked
  // by the caller's tolerance, not here) plus an exact hit.
  if (gotCity === wantCity || gotCity.includes(wantCity) || wantCity.includes(gotCity)) return "confirmed";
  return "mismatch";
}

/** The research prompt. Pure + exported so it can be unit-tested. */
export function buildResearchPrompt(opts: {
  niche: string;
  location: string | null;
  count: number;
  dmTitles: string[];
  /** Business names already in the CRM — the model is told to skip them. */
  exclude?: string[];
}): { system: string; user: string } {
  const where = opts.location ? ` in ${opts.location}` : "";
  const titleHint = opts.dmTitles.length
    ? ` The decision-maker is typically one of: ${opts.dmTitles.join(", ")}.`
    : "";
  const system =
    "You are a B2B lead researcher with live web search. Find real, currently-operating " +
    `businesses in a given niche and place, and for EACH resolve the decision-maker to contact.${titleHint} ` +
    `Return up to ${opts.count} DISTINCT real businesses. Output one business per block, blocks separated ` +
    "by a blank line, each block being these lines in order (use NONE for anything you cannot verify):\n" +
    "NAME: <business name>\n" +
    "WEBSITE: <official https site, or NONE>\n" +
    "ADDRESS: <street, city, state, or NONE>\n" +
    "PHONE: <main public phone, or NONE>\n" +
    "EMAIL: <public contact email, or NONE>\n" +
    "CONTACT: <decision-maker full name, or NONE>\n" +
    "TITLE: <their role, e.g. Owner / Founder / Office Manager, or NONE>\n" +
    "DM_EMAIL: <decision-maker's direct email if different from EMAIL, or NONE>\n" +
    "LINKEDIN: <company LinkedIn URL, or NONE>\n" +
    "SOCIALS: <comma-separated other social URLs, or NONE>\n" +
    "SOURCE: <where you found the decision-maker, e.g. website/about, linkedin>\n" +
    "CONFIDENCE: high|medium|low\n" +
    "NOTE: <one short sentence on how you identified the business>\n" +
    "Rules: only real businesses you can verify actually exist and operate" +
    (opts.location ? " in that specific place" : "") +
    ". NEVER invent a business, phone, email, address, or person — use NONE for anything unverified. " +
    "The WEBSITE must be the business's OWN site, never a Facebook/Instagram/Yelp/LinkedIn/Maps/directory " +
    "page. No preamble, no numbering, no markdown, no commentary." +
    (opts.location
      ? `\n\nLOCATION IS A HARD FILTER. Every business you return must have its own physical ` +
        `location in ${opts.location} or its immediate suburbs, and the ADDRESS line must be that ` +
        `local address. Do NOT include businesses from other metros or states. If you cannot find ` +
        `${opts.count} qualifying businesses in that area, RETURN FEWER — a short, correct list is ` +
        `the goal. Never pad the list with businesses from elsewhere.`
      : "") +
    `\n\nWORK HARD ON CONTACT. Before writing "CONTACT: NONE", actually check the business's own ` +
    `About / Our Team / Meet-the-staff / Contact pages, its LinkedIn company page and the profiles ` +
    `of people who list it as their employer, state license or registration lookups, and local press ` +
    `or interviews. A named owner is the single most valuable field here. Only use NONE once you ` +
    `have genuinely looked and cannot corroborate a name.`;

  const excl = (opts.exclude ?? []).filter(Boolean);
  // Dedupe used to happen only AFTER research, so the model spent real budget
  // rediscovering businesses we already had (one run: 5 of 6 results were dupes).
  // Naming them up front turns that wasted spend into new coverage.
  const excludeBlock = excl.length
    ? `\n\nWe ALREADY have these businesses — do not return any of them, and do not return ` +
      `another location of the same brand. Find ones that are NOT on this list:\n` +
      excl.map((n) => `- ${n}`).join("\n")
    : "";

  const user =
    `Niche: ${opts.niche}${where ? `\nPlace: ${opts.location}` : ""}\n` +
    `List the real ${opts.niche} businesses${where} and each one's decision-maker.${excludeBlock}`;
  return { system, user };
}

// ── Verification: is this business real at all? ──────────────────────────────
// A live run asked sonar-pro for 10 Decatur med spas, and it padded the list to
// hit the number: three of the returned domains did not exist in DNS, and four
// different "businesses" shared a sequential phone block (…822-2227 / 2228 /
// 2229 / 2270). The prompt already says to return fewer rather than pad; the
// model ignored it. Instructions alone cannot be the control here.
//
// The signal was already sitting there unused — the second pass reported those
// same leads as unresolved with "could not find any verified listing". Pair
// that with a DNS check (deterministic, free, no model) and fabrications
// identify themselves.

/** Whether a lead's website answers: 'none' = it never claimed one. */
export type SiteStatus = "alive" | "dead" | "unknown" | "none";

export type Verdict = "verified" | "unconfirmed" | "failed";

/**
 * Decide what a lead has earned after the second pass.
 *
 * Deliberately conservative — the only automatic rejection is the case with two
 * independent pieces of evidence against it: research corroborated *nothing*
 * AND the claimed website does not resolve. A real business with no web
 * presence, or a live site whose owner simply isn't published, lands in
 * `unconfirmed` and stays visible for a human to judge.
 */
export function verificationVerdict(o: {
  /** Fields the second pass managed to corroborate and fill. */
  gained: number;
  /** The second pass's own confidence, when it reported one. */
  confidence: "high" | "medium" | "low" | null;
  siteStatus: SiteStatus;
  hasPhone: boolean;
  hasContact: boolean;
}): { verdict: Verdict; note: string } {
  const foundNothing = o.gained === 0 && o.confidence !== "high";

  if (foundNothing && o.siteStatus === "dead") {
    return {
      verdict: "failed",
      note:
        "Quarantined: the claimed website does not resolve in DNS and the second pass found no " +
        "verifiable online presence for this business. Treated as a first-pass fabrication.",
    };
  }

  // A dead domain on a business we *did* corroborate means the URL was wrong,
  // not that the business is fake — the domain gets dropped, the lead survives.
  if (o.siteStatus === "dead") {
    return {
      verdict: "unconfirmed",
      note: "The website given by the first pass does not resolve and has been removed. Other details were corroborated.",
    };
  }

  if (foundNothing && !o.hasContact && !o.hasPhone) {
    return {
      verdict: "unconfirmed",
      note: "No decision-maker, no phone, and nothing corroborated by the second pass. Verify before spending time on it.",
    };
  }

  if (foundNothing) {
    return {
      verdict: "unconfirmed",
      note: "The second pass found no corroborating source for this business or its owner. Treat first-pass details as unverified.",
    };
  }

  return { verdict: "verified", note: "Corroborated by the second pass against live web sources." };
}

/** Score ceiling per verdict, so unverified leads can't outrank real ones. */
export function scoreCeiling(verdict: Verdict): number {
  return verdict === "failed" ? 0 : verdict === "unconfirmed" ? 20 : 100;
}

// ── Second pass: fill the gaps on ONE known business ─────────────────────────
// The first pass optimises for breadth and routinely returns NONE for phone,
// website, or the decision-maker. Re-asking about a single named business —
// with everything we already know handed to the model — is a much easier
// question than "find me 10 businesses", and it is what the human was doing by
// hand in the Review tab.

export interface GapFillFound {
  website_domain: string | null;
  phone: string | null;
  contact_name: string | null;
  contact_title: string | null;
  email: string | null;
  linkedin: string | null;
  note: string | null;
  confidence: "high" | "medium" | "low" | null;
}

/** Targeted "fill these specific blanks on this specific business" prompt. */
export function buildGapFillPrompt(
  lead: {
    business_name: string;
    website_domain?: string | null;
    city?: string | null;
    region?: string | null;
    phone_e164?: string | null;
    email?: string | null;
    contact_name?: string | null;
    contact_title?: string | null;
  },
  opts: { dmTitles?: string[]; niche?: string | null; wants: Array<"website" | "phone" | "contact" | "email"> },
): { system: string; user: string } {
  const known: string[] = [`Business name: ${lead.business_name}`];
  const place = [lead.city, lead.region].filter(Boolean).join(", ");
  if (opts.niche) known.push(`Type of business: ${opts.niche}`);
  if (place) known.push(`Location: ${place}`);
  if (lead.website_domain) known.push(`Website: ${lead.website_domain}`);
  if (lead.phone_e164) known.push(`Known phone: ${lead.phone_e164}`);
  if (lead.email) known.push(`Known email: ${lead.email}`);
  if (lead.contact_name) known.push(`Known contact: ${lead.contact_name}`);
  if (lead.contact_title) known.push(`Known contact title: ${lead.contact_title}`);

  const want: string[] = [];
  if (opts.wants.includes("website"))
    want.push(`"website": the business's OWN official website hostname (not Facebook/Yelp/Maps/a directory)`);
  if (opts.wants.includes("phone"))
    want.push(`"phone": the business's best public phone number, in E.164 (e.g. +12565551234)`);
  if (opts.wants.includes("contact")) {
    const hint = opts.dmTitles?.length ? ` — typically one of: ${opts.dmTitles.join(", ")}` : "";
    want.push(
      `"contact_name": the full name of the owner or primary decision-maker${hint}`,
      `"contact_title": that person's role (e.g. "Owner", "Medical Director")`,
    );
  }
  if (opts.wants.includes("email"))
    want.push(`"email": the best public contact email for the business or that person`);
  want.push(`"linkedin": the company's LinkedIn URL, or null`);

  const system =
    "You are a precise B2B lead researcher with live web search, working on ONE named business. " +
    "Dig properly: the business's own site (About / Our Team / Meet the staff / Contact), its " +
    "LinkedIn company page and employees who list it, state license and business registration " +
    "lookups, local news and interviews, and reputable local directories. " +
    "Report only values you can actually corroborate from a real source. If you cannot verify a " +
    "field with reasonable confidence, return null for it — NEVER guess or fabricate a phone " +
    "number, person, or email. Return STRICT JSON only: no markdown, no code fence, no commentary.";

  const user =
    `Here is what we already know:\n${known.join("\n")}\n\n` +
    `Find the missing details and return a JSON object with exactly these keys:\n` +
    want.map((w) => `- ${w}`).join("\n") +
    `\n- "note": one short sentence on where the information came from (or null)\n` +
    `- "confidence": "high", "medium", or "low"\n\n` +
    `This must be the business named above, at that location — if the only matches you find are a ` +
    `different company or a different city, return null for every field and say so in "note". ` +
    `Output ONLY the JSON object.`;
  return { system, user };
}

/**
 * Parse a gap-fill reply into validated values. Runs every field through the
 * same validators as the bulk path, so the second pass can never sneak a
 * fabricated phone or a Yelp URL past the guardrails the first pass enforces.
 */
export function parseGapFill(raw: string): GapFillFound | null {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    text = text.slice(start, end + 1);
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t || /^(null|n\/a|unknown|not found|none)$/i.test(t)) return null;
    return t;
  };
  const conf = str(obj.confidence)?.toLowerCase();
  return {
    website_domain: validateWebsite(str(obj.website)),
    phone: validatePhone(str(obj.phone)),
    contact_name: cleanText(str(obj.contact_name), 80),
    contact_title: cleanText(str(obj.contact_title), 60),
    email: validateEmail(str(obj.email)),
    linkedin: validateLinkedin(str(obj.linkedin)),
    note: cleanText(str(obj.note), 240),
    confidence: conf === "high" || conf === "medium" || conf === "low" ? (conf as GapFillFound["confidence"]) : null,
  };
}
