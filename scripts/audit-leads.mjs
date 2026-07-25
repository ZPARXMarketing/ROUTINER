#!/usr/bin/env node
// ============================================================================
// audit-leads — dry-run a target and audit the result for fabrication smells.
//
// Nothing is inserted, so this is safe to run against production. It exists
// because two separate fabrication modes have now shipped past a "looks fine"
// eyeball check:
//
//   1. Padding — asked for 10 businesses in a city that had ~3, sonar-pro
//      invented the rest. Tells: domains that do not resolve, and a block of
//      phone numbers that are sequential across DIFFERENT businesses
//      (...822-2227 / 2228 / 2229 / 2270).
//   2. A mangled country code — an 11-digit US number normalised to +256
//      (Uganda). Tells: any phone that is not +1 for a US target.
//
// Usage:
//   node scripts/audit-leads.mjs "Florence, AL" "dental practices" [count]
//   node scripts/audit-leads.mjs --repeat 2 "Athens, AL" "dental practices" 8
//   node scripts/audit-leads.mjs --stress "Athens, AL" "chiropractic clinics"
//
// --stress asks for far more than the market plausibly holds; a healthy run
// returns FEWER than requested rather than filling the quota.
// Exit code 1 if any hard fabrication signal is found.
// ============================================================================

const ENG = process.env.LEAD_ENGINE_URL
  ?? "https://vonfdzttupyemtomsojy.supabase.co/functions/v1/lead-enrichment";

const argv = process.argv.slice(2);
// Boolean flags must NOT consume the following argument — an earlier version
// did, and silently swallowed the location so the audit ran on nonsense input
// while still printing a confident-looking verdict.
const boolFlag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};
const valueFlag = (name, def) => {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const stress = boolFlag("--stress");
const repeat = Number(valueFlag("--repeat", 1)) || 1;
const [location, niche, countArg] = argv;

if (!location || !niche) {
  console.error('usage: audit-leads.mjs [--repeat N] [--stress] "<City, ST>" "<niche>" [count]');
  process.exit(2);
}
const count = Number(countArg) || (stress ? 15 : 8);

/**
 * Exchange clustering: most businesses sharing one NPA-NXX prefix.
 *
 * INFORMATIONAL ONLY — read the honest history before acting on it. It was
 * added on a hypothesis that over-asking makes the model attach local-exchange
 * numbers to real businesses: Athens at count=12 put 5 of 8 phones on 256-232
 * and gave one practice a different number than two count=6 runs had agreed on.
 * **That did not replicate.** A repeat put count=12 at no clustering and
 * count=6 at 67%, so the pattern does not track the quota, and 256-232 is
 * simply a real Athens exchange that many local businesses use.
 *
 * What IS real and unresolved: the same practice came back with two different
 * phone numbers on different runs. First-pass phones are not verified against
 * anything — the DNS gate only checks websites — so a wrong number on a real
 * business is the one fabrication mode nothing here currently catches.
 *
 * Threshold kept deliberately high so legitimate small-town data stays quiet.
 */
function exchangeClusters(leads) {
  const pref = leads
    .filter((l) => l.phone_e164)
    .map((l) => String(l.phone_e164).replace(/\D/g, "").slice(-10, -4));
  if (pref.length < 6) return null;
  const counts = {};
  for (const p of pref) counts[p] = (counts[p] ?? 0) + 1;
  const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const share = n / pref.length;
  return share > 0.7 ? { top, n, total: pref.length, pct: Math.round(share * 100) } : null;
}

/** Sequential phones across different businesses are a padding signature. */
function sequentialClusters(leads) {
  const nums = leads
    .filter((l) => l.phone_e164)
    .map((l) => ({ name: l.business_name, n: Number(String(l.phone_e164).replace(/\D/g, "").slice(-7)) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n);
  const out = [];
  for (let i = 1; i < nums.length; i++) {
    const d = nums[i].n - nums[i - 1].n;
    if (d > 0 && d <= 5) out.push(`${nums[i - 1].name} ↔ ${nums[i].name} (Δ${d})`);
  }
  return out;
}

async function once(i) {
  const res = await fetch(ENG, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      niche, location, count, dryRun: true, report: false, sampleSize: 25,
    }),
  });
  const data = await res.json();
  const r = data?.runs?.[0];
  if (!r || r.error) {
    console.log(`  run ${i}: ERROR ${r?.error ?? JSON.stringify(data).slice(0, 200)}`);
    return { hard: 1 };
  }

  const leads = r.sample ?? [];
  const badCc = leads.filter((l) => l.phone_e164 && !String(l.phone_e164).startsWith("+1"));
  const seq = sequentialClusters(leads);
  const exch = exchangeClusters(leads);
  const noDm = leads.filter((l) => !l.contact_name).length;

  console.log(
    `  run ${i}: requested ${r.requested} → parsed ${r.parsed} ` +
    `(dup ${r.skipped}, offArea ${r.offArea}, deadSite ${r.deadSites}) $${Number(r.cost).toFixed(4)}`,
  );
  for (const l of leads) {
    const marks = [
      !l.phone_e164 ? "no-phone" : null,
      l.phone_e164 && !String(l.phone_e164).startsWith("+1") ? "!! NON-US CC" : null,
      !l.contact_name ? "no-dm" : null,
      !l.website_domain ? "no-site" : null,
    ].filter(Boolean);
    console.log(
      `     ${String(l.business_name).slice(0, 40).padEnd(40)} ` +
      `${String(l.phone_e164 ?? "—").padEnd(15)} ${marks.join(",")}`,
    );
  }

  let hard = 0;
  if (badCc.length) { console.log(`     ✗ ${badCc.length} phone(s) with a non-US country code`); hard++; }
  if (seq.length) { console.log(`     ✗ sequential phone block: ${seq.join("; ")}`); hard++; }
  if (exch) {
    console.log(
      `     · ${exch.n}/${exch.total} phones share exchange ${exch.top} (${exch.pct}%) — ` +
      `may be a real local exchange; spot-check a couple against the businesses' own sites`,
    );
  }
  if (r.deadSites) console.log(`     ⚠ ${r.deadSites} domain(s) did not resolve (gate will handle)`);
  if (stress && r.parsed >= count) { console.log(`     ✗ filled the quota (${r.parsed}/${count}) in a thin market — padding`); hard++; }
  if (noDm) console.log(`     · ${noDm}/${leads.length} without a decision-maker (the 2nd pass targets these)`);

  return { hard, parsed: r.parsed, names: leads.map((l) => l.business_name) };
}

console.log(`\n${location} · ${niche} · count=${count}${stress ? " · STRESS" : ""}`);
let hard = 0;
const runs = [];
for (let i = 1; i <= repeat; i++) runs.push(await once(i));
for (const r of runs) hard += r.hard ?? 0;

if (repeat > 1 && runs.every((r) => r.names)) {
  // Run-to-run agreement: a source that invents results is far less consistent
  // than one reading the same real businesses off the web each time.
  const [a, b] = runs.map((r) => new Set(r.names.map((n) => n.toLowerCase())));
  const overlap = [...a].filter((n) => b.has(n)).length;
  const pct = Math.round((overlap / Math.max(1, Math.min(a.size, b.size))) * 100);
  console.log(`  consistency: ${overlap} shared name(s) across runs (${pct}% of the smaller run)`);
}

console.log(hard ? `\n✗ ${hard} hard fabrication signal(s)\n` : `\n✓ no hard fabrication signals\n`);
process.exit(hard ? 1 : 0);
