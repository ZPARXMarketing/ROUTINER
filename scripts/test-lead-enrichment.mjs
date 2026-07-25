#!/usr/bin/env node --experimental-strip-types
// ============================================================================
// test-lead-enrichment — no network, no Deno, no Supabase.
//
// Exercises the pure half of the lead pipeline: the area filter that stops
// out-of-metro drift, the gap-fill parser that backs the automatic second pass,
// and the research prompt's location/exclusion rules. Run it before shipping a
// change to lead-parse.ts or lead-enrichment/index.ts:
//
//   node --experimental-strip-types scripts/test-lead-enrichment.mjs
// ============================================================================
import {
  areaMatch,
  buildGapFillPrompt,
  buildResearchPrompt,
  parseGapFill,
  parseLeads,
  extractPhones,
  phoneCeiling,
  phoneVerdict,
  scoreCeiling,
  toE164,
  verificationVerdict,
} from "../supabase/functions/_shared/lead-parse.ts";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const lead = (city, region, address) => ({ city, region, enrichment: { address } });

console.log("\nareaMatch — the out-of-metro filter");
{
  // The real drift seen in production: Huntsville targets returning Birmingham
  // (205) and Chattanooga (423) businesses.
  eq("Birmingham lead vs Huntsville target → mismatch",
    areaMatch(lead("Birmingham", "AL", "123 Main St, Birmingham, AL"), "Huntsville, AL"), "mismatch");
  eq("Chattanooga TN vs Huntsville AL → mismatch (state differs)",
    areaMatch(lead("Chattanooga", "TN", "9 Market St, Chattanooga, TN"), "Huntsville, AL"), "mismatch");
  eq("Huntsville lead vs Huntsville target → confirmed",
    areaMatch(lead("Huntsville", "AL", "1 Clinton Ave, Huntsville, AL 35801"), "Huntsville, AL"), "confirmed");

  // The critical safety property: a lead with no address of its own inherits
  // the target city in parseLeads. Calling that a mismatch would silently throw
  // away good leads for having a shy address line.
  eq("no address of its own → assumed, never mismatch",
    areaMatch(lead("Huntsville", null, null), "Huntsville, AL"), "assumed");
  eq("no target location → assumed",
    areaMatch(lead("Anywhere", "AL", "x, Anywhere, AL"), null), "assumed");
  eq("suburb naming the metro is kept",
    areaMatch(lead("Huntsville", "AL", "Research Park, Huntsville, AL"), "Huntsville"), "confirmed");
}

console.log("\nparseGapFill — the second pass's reply parser");
{
  const good = parseGapFill(JSON.stringify({
    website: "https://www.advancedlifeclinic.com/about",
    phone: "(256) 882-6555",
    contact_name: "Hayley DeGraaff, MD",
    contact_title: "Owner / Medical Director",
    email: "Info@AdvancedLifeClinic.com",
    linkedin: "linkedin.com/company/advanced-life-clinic",
    note: "Named on the clinic's About page.",
    confidence: "high",
  }));
  eq("website reduced to a bare host", good.website_domain, "advancedlifeclinic.com");
  eq("phone kept readable", good.phone, "(256) 882-6555");
  eq("contact name", good.contact_name, "Hayley DeGraaff, MD");
  eq("email lowercased", good.email, "info@advancedlifeclinic.com");
  eq("linkedin normalised", good.linkedin, "https://linkedin.com/company/advanced-life-clinic");
  eq("confidence", good.confidence, "high");

  // The guardrail that matters: the second pass must not be a back door around
  // the validators the first pass enforces.
  const junk = parseGapFill(JSON.stringify({
    website: "https://www.facebook.com/somebiz",
    phone: "call us!",
    contact_name: "unknown",
    email: "not-an-email",
    linkedin: "https://example.com/x",
    confidence: "certain",
  }));
  eq("Facebook rejected as a website", junk.website_domain, null);
  eq("non-numeric phone rejected", junk.phone, null);
  eq('"unknown" contact → null', junk.contact_name, null);
  eq("malformed email rejected", junk.email, null);
  eq("non-LinkedIn URL rejected", junk.linkedin, null);
  eq("bogus confidence → null", junk.confidence, null);

  // Perplexity habitually wraps JSON in prose or a code fence.
  const fenced = parseGapFill('Here is what I found:\n```json\n{"phone":"+12565551234"}\n```\nHope that helps!');
  eq("fenced + prose-wrapped JSON still parses", fenced?.phone, "+12565551234");
  eq("unparseable reply → null", parseGapFill("I could not find anything."), null);
  eq("empty reply → null", parseGapFill(""), null);
}

console.log("\nbuildGapFillPrompt — asks only for what's missing");
{
  const { system, user } = buildGapFillPrompt(
    { business_name: "Revive Clinic", website_domain: "revivehsv.com", city: "Huntsville", region: "AL", phone_e164: "+12562032178" },
    { wants: ["contact"], niche: "med spa", dmTitles: ["Owner", "Medical Director"] },
  );
  ok("asks for the decision-maker", user.includes("contact_name"));
  ok("does NOT re-ask for the phone it already has", !user.includes('"phone":'));
  ok("hands over what we already know", user.includes("revivehsv.com") && user.includes("+12562032178"));
  ok("passes the ICP titles through", user.includes("Medical Director"));
  ok("forbids fabrication", /NEVER guess or fabricate/i.test(system));
  ok("guards against matching a different company", /different company or a different city/i.test(user));
}

console.log("\nbuildResearchPrompt — location hard filter + exclusion list");
{
  const { system, user } = buildResearchPrompt({
    niche: "med spas", location: "Huntsville, AL", count: 10,
    dmTitles: ["Owner"], exclude: ["Revive Clinic", "Synergy Med-Spa"],
  });
  ok("states location is a hard filter", /LOCATION IS A HARD FILTER/.test(system));
  ok("tells it to return fewer rather than pad", /RETURN FEWER/.test(system));
  ok("pushes harder on finding the owner", /WORK HARD ON CONTACT/.test(system));
  ok("lists the businesses we already have", user.includes("Revive Clinic") && user.includes("Synergy Med-Spa"));
  ok("omits the exclusion block when there's nothing to exclude",
    !buildResearchPrompt({ niche: "x", location: null, count: 5, dmTitles: [] }).user.includes("ALREADY have"));
}

console.log("\ntoE164 — never invent a country code");
{
  eq("bare 10-digit US → +1", toE164("(256) 764-9533"), "+12567649533");
  eq("bare 11-digit starting 1 → +1", toE164("1-256-764-9533"), "+12567649533");
  eq("explicit + is trusted as given", toE164("+44 20 7946 0958"), "+442079460958");

  // The real defect: a Florence, AL dental practice came back as +25676495335 —
  // an 11-digit 256-area-code number reinterpreted as country code +256,
  // Uganda. This feeds a dialer, so a guess is worse than nothing.
  eq("11 digits not starting with 1 → null, NOT a foreign country code",
    toE164("256-764-95335"), null);
  eq("12 bare digits → null", toE164("256764953355"), null);
  eq("a stray extension digit does not become a country code",
    toE164("(256) 764-9533 x2"), null);

  eq("too short → null", toE164("12345"), null);
  eq("too long → null", toE164("+1234567890123456"), null);
  eq("null in, null out", toE164(null), null);
}

console.log("\nextractPhones — reading numbers off a business's own page");
{
  const html = `
    <a href="tel:+1-256-882-6555">Call us</a>
    <p>Fax: (256) 882-6556</p>
    <span>Open since 1998 · 1234 Whitesburg Dr · ZIP 35801</span>
    <div>Prices from 1,250.00 to 9,999.99</div>`;
  const found = extractPhones(html);
  ok("finds the tel: link", found.has("2568826555"));
  ok("finds a visible formatted number", found.has("2568826556"));
  eq("ignores years, ZIPs, street numbers and prices", found.size, 2);

  // Numbers split across markup must not fuse into a phantom number.
  const split = extractPhones("<b>555</b><i>123</i><u>4567</u>");
  eq("adjacent tags do not fuse into a false match", split.size, 0);

  eq("strips a leading US 1 so formats compare equal",
    [...extractPhones('<a href="tel:12568826555">x</a>')][0], "2568826555");
  eq("empty page yields nothing", extractPhones("").size, 0);

  // Real Huntsville sites publish placeholders in their own markup. Left in,
  // they pollute the evidence and could let a template's dummy number
  // "confirm" a lead's dummy number.
  eq("555-555-5555 placeholder rejected", extractPhones("call 555-555-5555").size, 0);
  eq("999-999-9999 placeholder rejected", extractPhones("call 999-999-9999").size, 0);
  eq("area code starting with 1 rejected", extractPhones("call 155-123-4567").size, 0);
  eq("exchange starting with 0 rejected", extractPhones("call 256-012-3456").size, 0);
  ok("a real number still passes", extractPhones("call 256-882-6555").has("2568826555"));
}

console.log("\nphoneVerdict — the last unverified field");
{
  const site = new Set(["2568826555", "2568826556"]);

  eq("number published on the site → confirmed",
    phoneVerdict("+12568826555", site).status, "confirmed");
  eq("formatting differences still match",
    phoneVerdict("(256) 882-6555", site).status, "confirmed");

  // The failure this was built for: a plausible number on a real business.
  const c = phoneVerdict("+12568222228", site);
  eq("number absent from the site → conflict", c.status, "conflict");
  ok("the conflict names what the site actually publishes", c.note.includes("+12568826555"));
  ok("and offers them as candidates", c.candidates.length === 2);

  // Absence of evidence is not evidence of a wrong number.
  eq("site unreachable → unverified, not conflict",
    phoneVerdict("+12568826555", null).status, "unverified");
  eq("site publishes no numbers → unverified",
    phoneVerdict("+12568826555", new Set()).status, "unverified");
  eq("no phone on the lead → no-phone",
    phoneVerdict(null, site).status, "no-phone");

  // Franchise/hospital-group sites publish a national line and never the
  // branch's local number — BrightStar, FirstLight, Aveanna, MDVIP and ATI all
  // did. Calling that a conflict wrongly caps a perfectly good lead.
  eq("site publishes only toll-free → unverified, not conflict",
    phoneVerdict("+12568013600", new Set(["8666187827", "8009876543"])).status, "unverified");
  eq("but a real local number on the site still contradicts",
    phoneVerdict("+12568013600", new Set(["8666187827", "2565551234"])).status, "conflict");
  eq("a toll-free lead number matching a toll-free site number is confirmed",
    phoneVerdict("+18666187827", new Set(["8666187827"])).status, "confirmed");

  eq("a conflicted number is capped below a checked one", phoneCeiling("conflict"), 30);
  eq("confirmed does not cap", phoneCeiling("confirmed"), 100);
  eq("unverified does not cap — only a contradiction does", phoneCeiling("unverified"), 100);
}

console.log("\nverificationVerdict — the fabrication gate");
{
  const v = (o) => verificationVerdict({
    gained: 0, confidence: "low", siteStatus: "dead", hasPhone: true, hasContact: false, ...o,
  }).verdict;

  // The exact shape of the three leads that triggered this: sonar-pro padded a
  // count:10 request with invented businesses, the second pass corroborated
  // nothing, and the domains did not exist.
  eq("nothing corroborated + dead domain → quarantined", v({}), "failed");

  // Both halves are required. One alone must never auto-reject.
  eq("dead domain but details WERE corroborated → kept, unconfirmed",
    v({ gained: 3, confidence: "high" }), "unconfirmed");
  eq("nothing corroborated but the site is live → kept, unconfirmed",
    v({ siteStatus: "alive" }), "unconfirmed");
  eq("a real business with no website at all is never quarantined",
    v({ siteStatus: "none" }), "unconfirmed");

  // A slow host must not be mistaken for a fake one.
  eq("timeout is not evidence of fabrication", v({ siteStatus: "unknown" }), "unconfirmed");

  // High confidence from the second pass overrides the zero-gain signal: there
  // was nothing left to fill because the first pass already had it right.
  eq("high confidence + live site → verified",
    v({ gained: 0, confidence: "high", siteStatus: "alive" }), "verified");
  eq("corroborated + live site → verified",
    v({ gained: 2, confidence: "medium", siteStatus: "alive" }), "verified");

  eq("quarantined leads score 0", scoreCeiling("failed"), 0);
  eq("unconfirmed leads are capped below verified ones", scoreCeiling("unconfirmed"), 20);
  eq("verified leads keep their score", scoreCeiling("verified"), 100);

  ok("the quarantine note explains itself",
    /does not resolve/.test(verificationVerdict({ gained: 0, confidence: "low", siteStatus: "dead", hasPhone: false, hasContact: false }).note));
}

console.log("\nparseLeads — still parses the block format (regression)");
{
  const leads = parseLeads(
    ["NAME: Advanced Life Clinic",
      "WEBSITE: https://advancedlifeclinic.com",
      "ADDRESS: 123 Whitesburg Dr, Huntsville, AL",
      "PHONE: (256) 882-6555",
      "CONTACT: Hayley DeGraaff",
      "TITLE: Owner",
      "CONFIDENCE: high",
      "",
      "NAME: Gapped Clinic",
      "WEBSITE: NONE",
      "PHONE: NONE",
      "CONTACT: NONE",
    ].join("\n"),
    { niche: "med spas", location: "Huntsville, AL", model: "perplexity/sonar-pro", foundAt: new Date().toISOString() },
  );
  eq("two blocks parsed", leads.length, 2);
  eq("phone → E.164", leads[0].phone_e164, "+12568826555");
  eq("complete lead scores high", leads[0].lead_score >= 85, true);
  eq("gapped lead keeps nulls", leads[1].contact_name, null);
  eq("gapped lead scores low (so deepen has something to fix)", leads[1].lead_score <= 45, true);
  // The gapped lead is exactly what the second pass exists to rescue.
  eq("gapped lead inherits target city, so the area filter won't drop it",
    areaMatch(leads[1], "Huntsville, AL"), "assumed");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
