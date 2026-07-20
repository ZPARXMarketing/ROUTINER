// ============================================================================
// lead-schema.ts — the SHARED enriched-lead contract (Deno / edge runtime).
//
// This is the ONE canonical shape a sourced+enriched lead takes as it flows
// between the four surfaces:
//
//   Perplexity (raw research)  ─▶  EnrichedLead  ─▶  Command  staged_leads   (Review tab)
//                                                └▶  Abstrax  competitors     (prospect pipeline)
//
// Command, Abstrax, and the `lead-enrichment` edge function all agree on these
// field names, so "populating one informs the others" even though Command lives
// on the zparx-dashboard Supabase project and Abstrax lives on RoiCal. The two
// mappers below are the only places that translate the shared shape into each
// destination's columns — keep them in sync with those tables' migrations.
//
// A mirror of this type (camelCase, for the browser) lives in Command at
// `src/types/enrichedLead.ts`. Field NAMES and MEANINGS must match; only the
// casing differs (snake_case here to match the DB, camelCase there for the UI).
// ============================================================================

/** Structured enrichment extras — lands in staged_leads.enrichment (jsonb). */
export interface LeadEnrichment {
  /** How sure the research pass was about this being a real, correctly-identified business. */
  confidence: "high" | "medium" | "low" | null;
  /** Where the decision-maker / details were found (e.g. "website/about", "linkedin"). */
  source: string | null;
  /** One short sentence on how the business was identified (or why fields are blank). */
  note: string | null;
  /** Decision-maker's direct/public email when distinct from the business email. */
  dm_email: string | null;
  /** Company LinkedIn URL (linkedin.com/company/…), validated. */
  linkedin: string | null;
  /** Street/city/state as free text, when found. */
  address: string | null;
  /** Other social profile URLs. */
  socials: string[];
  /** The model id that produced this record (e.g. "perplexity/sonar-pro"). */
  model: string | null;
  /** ISO timestamp the research ran. */
  found_at: string;
}

/**
 * The canonical enriched lead. Snake_case so it drops straight into
 * staged_leads. Every field except business_name is nullable — enrichment
 * NEVER invents a value; a missing phone/email/name stays null.
 */
export interface EnrichedLead {
  business_name: string;
  website_domain: string | null; // hostname only, e.g. "acmechiro.com"
  phone_e164: string | null;
  email: string | null;
  city: string | null;
  region: string | null;
  categories: string[];
  /** Niche key, e.g. "chiropractic" — becomes staged_leads.vertical + contacts.vertical. */
  vertical: string | null;
  /** Provenance, e.g. "perplexity:chiropractic/Huntsville, AL". */
  source: string;
  /** 0–100 heuristic; higher = better ICP fit / more complete record. */
  lead_score: number | null;
  /** Decision-maker full name (e.g. "Dr. Jane Reed"), null when unresolved. */
  contact_name: string | null;
  /** Their role (e.g. "Owner", "Lead DC", "Office Manager"). */
  contact_title: string | null;
  enrichment: LeadEnrichment;
}

/** A row shaped for Command's `staged_leads` (zparx-dashboard project). */
export interface StagedLeadInsert {
  business_name: string;
  website_domain: string | null;
  phone_e164: string | null;
  email: string | null;
  city: string | null;
  region: string | null;
  categories: string[];
  vertical: string | null;
  source: string | null;
  lead_score: number | null;
  contact_name: string | null;
  contact_title: string | null;
  enrichment: LeadEnrichment;
  raw: EnrichedLead; // full record preserved (parity with cal_bookings.raw / ADR-002)
  status: "pending";
}

/** Map the shared shape → a Command staged_leads insert. */
export function toStagedLead(lead: EnrichedLead): StagedLeadInsert {
  return {
    business_name: lead.business_name,
    website_domain: lead.website_domain,
    phone_e164: lead.phone_e164,
    email: lead.email,
    city: lead.city,
    region: lead.region,
    categories: lead.categories,
    vertical: lead.vertical,
    source: lead.source,
    lead_score: lead.lead_score,
    contact_name: lead.contact_name,
    contact_title: lead.contact_title,
    enrichment: lead.enrichment,
    raw: lead,
    status: "pending",
  };
}

/**
 * A row shaped for Abstrax's `competitors` (RoiCal project) prospect pipeline.
 * `source` is constrained to ('ads','places','manual','discovery') by the table
 * — an AI-web-search lead is 'discovery'; the true provenance goes in `notes`.
 * `platform`/`page_id` are omitted so the DB defaults apply (platform 'meta',
 * page_id null, which keeps the (platform,page_id) unique index inert here).
 */
export interface CompetitorInsert {
  name: string;
  website: string | null;
  niche: string | null;
  location: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  source: "discovery";
  pipeline_status: "prospect";
}

/** Map the shared shape → an Abstrax competitors (prospect) insert. */
export function toCompetitor(lead: EnrichedLead): CompetitorInsert {
  const location = [lead.city, lead.region].filter(Boolean).join(", ") || null;
  const noteBits = [
    lead.contact_title ? `Role: ${lead.contact_title}` : null,
    lead.enrichment.confidence ? `Confidence: ${lead.enrichment.confidence}` : null,
    `via ${lead.source}`,
    lead.enrichment.note,
  ].filter(Boolean);
  return {
    name: lead.business_name,
    website: lead.website_domain ? `https://${lead.website_domain}` : null,
    niche: lead.vertical,
    location,
    contact_name: lead.contact_name,
    contact_email: lead.enrichment.dm_email ?? lead.email,
    contact_phone: lead.phone_e164,
    notes: noteBits.length ? noteBits.join(" · ") : null,
    source: "discovery",
    pipeline_status: "prospect",
  };
}
