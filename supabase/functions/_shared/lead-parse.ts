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

/** The research prompt. Pure + exported so it can be unit-tested. */
export function buildResearchPrompt(opts: {
  niche: string;
  location: string | null;
  count: number;
  dmTitles: string[];
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
    "page. No preamble, no numbering, no markdown, no commentary.";
  const user = `Niche: ${opts.niche}${where ? `\nPlace: ${opts.location}` : ""}\nList the real ${opts.niche} businesses${where} and each one's decision-maker.`;
  return { system, user };
}
