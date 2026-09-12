// Tests for the model catalog and the per-user overrides on top of it.
//
//   node scripts/test-models.mjs
//
// js/model-router.js is pure logic with no DOM, so it loads straight into Node.
// The properties pinned here are the ones that break quietly:
//
//   • A duplicate slug makes two catalog rows fight over one lookup, and the
//     loser's color and price silently belong to the winner.
//   • Preferences key on the catalog `key`, never the slug — keying on the slug
//     would mean renaming a model threw away the color you picked for it.
//   • A routine stores the slug it was pinned to. After a rename, that slug is
//     no longer in the live catalog, so the fallback to the shipped table is the
//     only thing standing between an old routine and an unnamed, grey block.
//   • The picker must always contain the selected value. A <select> silently
//     re-points at its first option when the current value is missing, so a
//     picker that drops an unknown slug does not show an error — it changes the
//     routine's model the moment you open the drawer.
import {
  MODEL_LABS, MODEL_TIERS, DEFAULT_CATALOG, catalog, catalogByLab, allModels,
  modelBySlug, modelLabel, modelFullLabel, modelColor, routineColor, rateLabel,
  modelOptionsHtml, setModelPrefs, getModelPrefs, normalizeModelPrefs, modelPrefsAreDefault,
  estimateRunCost, pricingFor, UNKNOWN_MODEL_COLOR, MODELS,
} from '../js/model-router.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ''}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

console.log('\nmodel catalog');
const reset = () => setModelPrefs(null);
reset();

// ── Shape ────────────────────────────────────────────────────────────────────
ok('every lab has a name, an origin and models',
  MODEL_LABS.every((l) => l.id && l.name && l.origin && Array.isArray(l.models) && l.models.length >= 3));

// "Three tiers per lab" is the ask in issue #102/#103 and the thing that makes
// the grouped picker legible: pick a lab, then pick how much to spend.
const tierIds = MODEL_TIERS.map((t) => t.id);
ok('every lab covers all three tiers',
  MODEL_LABS.every((l) => tierIds.every((t) => l.models.some((m) => m.tier === t))),
  MODEL_LABS.filter((l) => !tierIds.every((t) => l.models.some((m) => m.tier === t))).map((l) => l.id).join(', '));

ok('both the US and China are represented',
  MODEL_LABS.some((l) => l.origin === 'US') && MODEL_LABS.some((l) => l.origin === 'China'));

const slugs = DEFAULT_CATALOG.map((m) => m.slug);
eq('no duplicate slugs', slugs.filter((s, i) => slugs.indexOf(s) !== i), []);
const keys = DEFAULT_CATALOG.map((m) => m.key);
eq('no duplicate keys', keys.filter((k, i) => keys.indexOf(k) !== i), []);

ok('every model is priced and colored',
  DEFAULT_CATALOG.every((m) => Number.isFinite(m.in) && Number.isFinite(m.out) && /^#[0-9A-Fa-f]{6}$/.test(m.color)));
ok('every model has a tier the tier table knows',
  DEFAULT_CATALOG.every((m) => tierIds.includes(m.tier)));
ok('Claude rows are the only ones marked as Claude-executed',
  DEFAULT_CATALOG.every((m) => (m.via === 'claude') === /^claude-/.test(m.slug)));
ok('the back-compat MODELS list covers the catalog', MODELS.length === DEFAULT_CATALOG.length + 2);

// ── Lookups ──────────────────────────────────────────────────────────────────
console.log('\nlookups');
eq('a known slug resolves to its name', modelLabel('z-ai/glm-4.7'), 'GLM 4.7');
ok('the long form names the lab and the tier', modelFullLabel('z-ai/glm-4.7').includes('Z.ai'));
eq('auto is named, not echoed', modelLabel('auto'), 'Auto');
// An unknown slug is shown verbatim: it is the truest name anyone has for it,
// and blanking it would hide which model a routine is actually pinned to.
eq('an unknown slug is shown as itself', modelLabel('who/knows-1'), 'who/knows-1');
eq('an unknown slug gets the neutral color', modelColor('who/knows-1'), UNKNOWN_MODEL_COLOR);
ok('a known slug gets its own color', modelColor('z-ai/glm-4.7') !== UNKNOWN_MODEL_COLOR);
ok('rates read as in/out per million', /^\$[\d.]+\/\$[\d.]+ per M/.test(rateLabel('openai/gpt-5.6-sol')));
eq('an unpriced pseudo-model has no rate', rateLabel('openrouter/auto'), '');

// A routine colored by its resolved model, not by the literal string 'auto' —
// otherwise every auto routine is one indistinguishable color on the calendar.
ok('an auto routine takes the color of the model auto picks',
  routineColor({ model: 'auto', taskType: 'general', complexity: 'high' }) !== UNKNOWN_MODEL_COLOR);

// ── Preferences ──────────────────────────────────────────────────────────────
console.log('\npreferences');
eq('junk prefs normalize to nothing', normalizeModelPrefs({ slugs: { 'no.such.key': 'x/y' }, colors: { 'zai.fast': 'not-a-color' } }), { slugs: {}, colors: {} });
ok('an empty prefs object counts as default', modelPrefsAreDefault(normalizeModelPrefs({})));
ok('null counts as default', modelPrefsAreDefault(null));

setModelPrefs({ slugs: { 'zai.fast': 'z-ai/glm-4.9' }, colors: { 'zai.fast': '#112233' } });
eq('a renamed slug is what the catalog now offers', modelBySlug('z-ai/glm-4.9')?.key, 'zai.fast');
eq('the renamed row keeps its name', modelLabel('z-ai/glm-4.9'), 'GLM 4.7');
eq('the renamed row keeps its price', pricingFor('z-ai/glm-4.9')?.in, 0.6);
eq('the recolored row wears the new color', modelColor('z-ai/glm-4.9'), '#112233');
// The whole point of keying prefs on `key`: a routine pinned before the rename
// still resolves, rather than going grey and nameless.
eq('a routine pinned to the old slug still resolves', modelLabel('z-ai/glm-4.7'), 'GLM 4.7');
eq('prefs round-trip', getModelPrefs().slugs['zai.fast'], 'z-ai/glm-4.9');
ok('a renamed row is flagged as renamed', catalog().find((m) => m.key === 'zai.fast').renamed === true);
ok('cost estimates follow a renamed slug',
  Math.abs(estimateRunCost({ prompt: 'x', model: 'z-ai/glm-4.9' }).usd - estimateRunCost({ prompt: 'x', model: 'z-ai/glm-4.7' }).usd) < 1e-12);
reset();
eq('resetting prefs restores the shipped slug', modelBySlug('z-ai/glm-4.7')?.key, 'zai.fast');
eq('and drops the renamed one', modelBySlug('z-ai/glm-4.9'), null);

// ── Pickers ──────────────────────────────────────────────────────────────────
console.log('\npickers');
const html = modelOptionsHtml('z-ai/glm-4.7');
ok('groups by lab', html.includes('<optgroup label="Z.ai (Zhipu) · China">'));
ok('marks the selection', html.includes('<option value="z-ai/glm-4.7" selected>'));
ok('names the tier and the rate on the row', /GLM 4.7 · Fast · \$/.test(html));
ok('offers auto by default', html.includes('value="auto"'));
ok('auto can be turned off', !modelOptionsHtml('z-ai/glm-5', { auto: false }).includes('value="auto"'));

const orOnly = modelOptionsHtml('moonshotai/kimi-k3', { auto: false, via: 'openrouter' });
ok('an OpenRouter-only picker excludes Claude', !orOnly.includes('claude-'));
ok('…and still offers the OpenRouter labs', orOnly.includes('moonshotai/kimi-k3'));
ok('a Claude-only picker excludes OpenRouter Auto', !modelOptionsHtml('claude-sonnet-5', { via: 'claude' }).includes('openrouter/auto'));

// A <select> whose value is absent silently selects its first option, so a
// picker that drops an unknown slug does not report an error — it re-points the
// routine at whatever sits first the moment the drawer opens.
const orphan = modelOptionsHtml('legacy/model-x');
ok('an unknown pin is kept selectable', orphan.includes('value="legacy/model-x" selected'));
ok('…and is labeled as outside the catalog', orphan.includes('Not in the catalog'));

// A routine pinned to the OTHER executor's model — a DeepSeek pin on a Claude
// account, which claude-trigger.mjs drops at fire time. Narrowing the picker is
// the fix, but narrowing it *alone* would be worse than the bug: the pin falls
// out of the list, the <select> lands on option zero, and the next save quietly
// rewrites the routine. So it stays selectable and says why it cannot run.
const crossed = modelOptionsHtml('deepseek/deepseek-r1', { via: 'claude' });
ok('a Claude picker offers no OpenRouter model', !/value="deepseek\/deepseek-chat"/.test(crossed));
ok('…but an existing pin to one survives', crossed.includes('value="deepseek/deepseek-r1" selected'));
ok('…labelled with what it would need', /Won.t run on this account/.test(crossed) && crossed.includes('OpenRouter agent account'));
// The mirror case, so the rescue is not Claude-specific.
const crossedOr = modelOptionsHtml('claude-sonnet-5', { auto: false, via: 'openrouter' });
ok('an agent picker keeps a Claude pin selectable', crossedOr.includes('value="claude-sonnet-5" selected'));
ok('…and says it needs a Claude account', crossedOr.includes('a Claude account'));
// Rescue only fires for something the picker genuinely dropped.
ok('a model the picker does offer is not double-listed',
  (modelOptionsHtml('claude-sonnet-5', { via: 'claude' }).match(/value="claude-sonnet-5"/g) || []).length === 1);

// Escaping: these strings land straight in innerHTML.
ok('a hostile slug cannot break out of the option', !modelOptionsHtml('"><script>x</script>').includes('<script>'));

console.log('\nfilters');
ok('allModels can drop the pseudo-models', allModels({ auto: false }).every((m) => !m.auto));
eq('catalogByLab keeps every lab', catalogByLab().length, MODEL_LABS.length);
eq('…and every model', catalogByLab().reduce((n, l) => n + l.models.length, 0), DEFAULT_CATALOG.length);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
