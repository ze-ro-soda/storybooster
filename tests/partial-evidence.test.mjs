import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';

const normal = (id, q) => id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present';
const scopeFor = code => ['primary_genre', 'genre_expression', 'support_texture', 'scene_density'].includes(code) ? 'genre' : 'character';
const stableFor = code => ['character_consistency', 'character_interpretation', 'repetition'].includes(code) ? 'stable' : 'present';
const minimums = {
    primary_genre: 4, genre_expression: 4, support_texture: 2, scene_density: 4,
    character_consistency: 4, character_interpretation: 3, char_agency: 4,
    relationship: 3, continuity: 4, repetition: 3,
};

// Sufficient clear evidence can decide every genre/character dimension despite
// partial unknowns. One less clear reply must defer; the window stays at ten.
for (const [code, minimum] of Object.entries(minimums)) {
    for (const clear of [minimum - 1, minimum, 9]) {
        const f = await fixture();
        f.decide((id, q) => {
            const row = id.match(new RegExp(`^${code}__(\\d+)$`));
            return row ? (Number(row[1]) <= clear ? 'positive' : 'uncertain') : normal(id, q);
        });
        const result = await f.run(scopeFor(code));
        assert.equal(result.uncertain.includes(code), clear < minimum, `${code}: ${clear} clear replies`);
        if (clear >= minimum) assert.equal(result.ratings[code], stableFor(code));
        assert.equal(result.correctionCodes.includes(code), false);
        assert.deepEqual([...result.excludedReplies[code]], Array.from({ length: 10 - clear }, (_, n) => n + clear + 1));
        assert.equal(f.bodies.length, 2, 'No extra Jev request');
    }
}

// Low-confidence and low-probability answers are excluded, even if their label
// looks like a severe failure. They never count as proof of health or drift.
for (const low of ['confidence', 'probability']) {
    const f = await fixture();
    f.decide((id, q) => id === 'character_consistency__1' ? 'severe' : normal(id, q));
    const fetch = f.env.globals.fetch;
    f.env.globals.fetch = async (...args) => {
        const response = await fetch(...args); const body = await response.json();
        const a = body.answers.character_consistency__1;
        if (a) {
            if (low === 'confidence') a.confidence = 0.2;
            else { a.probabilities.severe = 0.79; a.probabilities.uncertain = 0.21; }
        }
        return { ...response, json: async () => body };
    };
    const result = await f.run('character');
    assert.equal(result.ratings.character_consistency, 'stable');
    assert.deepEqual([...result.excludedReplies.character_consistency], [1]);
    assert.deepEqual([...result.evidence.characterConsistency], []);
    assert.equal(result.correctionCodes.length, 0);
}

// Explicit essential missing context or unresolved contradictions cannot be
// erased by unrelated healthy observations; unsupported failures still defer.
for (const problem of ['essential-context', 'conflict', 'unpaired-failure', 'unpaired-facet', 'all-unknown']) {
    const f = await fixture();
    f.decide((id, q) => {
        if (problem === 'conflict' && id === 'character_consistency') return 'conflict';
        if (problem === 'essential-context' && id === 'character_consistency') return 'context_missing';
        if (problem === 'unpaired-failure' && id === 'character_consistency__10') return 'failure';
        if (problem === 'unpaired-facet' && id === 'character_consistency__facet_motives') return 'no';
        if (/^character_consistency__\d+$/.test(id) && (problem === 'all-unknown' || id.endsWith('__1'))) return 'uncertain';
        return normal(id, q);
    });
    const result = await f.run('character');
    assert.ok(result.uncertain.includes('character_consistency'), problem);
    assert.equal(result.correctionCodes.includes('character_consistency'), false);
}

// Confirmed mild and sustained failures still repair only the known problem;
// unknown replies neither cancel it nor raise its severity.
for (const count of [1, 2]) {
    const f = await fixture();
    f.decide((id, q) => {
        if (id === 'character_consistency__facet_motives') return 'no';
        if (id === 'character_consistency') return count === 1 ? 'attention' : 'drifted';
        const row = id.match(/^character_consistency__(\d+)$/);
        return row ? (Number(row[1]) > 10 - count ? 'failure' : 'uncertain') : normal(id, q);
    });
    const result = await f.run('character');
    assert.equal(result.ratings.character_consistency, count === 1 ? 'attention' : 'drifted');
    assert.equal(result.uncertain.includes('character_consistency'), false);
    assert.deepEqual([...result.correctionCodes], ['character_consistency']);
    assert.equal(result.evidence.characterConsistency.length, count);
}

// Temporary exceptions / supported growth remain legitimate; an opportunity
// shortage is not transformed into either an error or evidence of health.
{
    const f = await fixture();
    f.decide((id, q) => id === 'character_consistency__facet_emotion' ? 'justified'
        : /^character_consistency__\d+$/.test(id) ? (id.endsWith('__1') ? 'uncertain' : 'justified') : normal(id, q));
    const result = await f.run('character');
    assert.equal(result.ratings.character_consistency, 'stable'); assert.equal(result.correctionCodes.length, 0);
}
{
    const f = await fixture();
    f.decide((id, q) => id.startsWith('support_texture__facet_') ? 'no_opportunity'
        : id === 'support_texture' ? 'dormant'
        : /^support_texture__\d+$/.test(id) ? (id.endsWith('__1') ? 'uncertain' : 'none') : normal(id, q));
    const result = await f.run('genre');
    assert.equal(result.ratings.support_texture, 'dormant'); assert.ok(!result.uncertain.includes('support_texture'));
    assert.equal(result.decisionTrace.support_texture.route, 'no_opportunity');
    assert.equal(result.correctionCodes.includes('support_texture'), false);
}

// The feedback model receives the exclusions in the same existing call.
// A healthy diagnosis does not bypass auto-plot consent or stagnation checks.
{
    const f = await fixture();
    f.decide((id, q) => /^.+__1$/.test(id) ? 'uncertain' : normal(id, q));
    const result = await f.run('combined');
    assert.equal(result.uncertain.length, 0); assert.equal(result.correctionCodes.length, 0);
    const auto = f.m.namespace('features/automatic-plot.js');
    assert.ok(auto.healthyAuditForAutomaticPlot(f.selection(), result));
    assert.equal(auto.automaticPlotEnabled(f.state), false);
    let calls = 0;
    await f.diagnosis.writeJevFeedback(result, f.selection(), 'test', async options => {
        calls++;
        assert.match(options.prompt, /Never cite those excluded observations/);
        assert.ok(options.prompt.includes('"character_consistency":[1]'));
        return options.parseResult(JSON.stringify(f.feedback('combined')));
    }, 'en');
    assert.equal(calls, 1); assert.equal(f.bodies.length, 2);
    auto.ensureAutomaticPlotSettings(f.state).enabled = true;
    await auto.prepareAutomaticPlot({ chatId: 'chat_A', selection: f.selection(), result: { ...result, plotDecision: { eligible: false } },
        transcript: 'Meaningful quiet progress.', count: 10, isCurrent: () => true });
    assert.equal(f.m.namespace('core/automatic-plot-state.js').automaticPlotRuntime.pending, null);
    assert.equal(f.env.requests.length, 0);
}

console.log('Partial evidence: all ten dimensions, original thresholds, excluded weak answers, essential uncertainty, conflicting evidence, mild/strong repairs, natural growth, feedback and auto-plot safeguards passed.');
