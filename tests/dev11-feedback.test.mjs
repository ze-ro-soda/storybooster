import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';
const clone = value => JSON.parse(JSON.stringify(value));
// Ordinary context-appropriate language is observable normality for repetition;
// missing comparisons, low-confidence evidence and real problems still survive.
{
    const f = await fixture();
    const d = f.diagnosis, selection = f.selection();
    const question = d.buildJevEvidenceQuestions(d.getJevDimensions(selection), {}, 10).repetition__1;
    assert.match(question.criteria.positive, /Ordinary natural prose is sufficient/);
    assert.match(question.instructions, /None means no readable comparator/);
    assert.match(d.buildJevScreenQuestions(selection).repetition.instructions, /do not demand novel words/);
    assert.doesNotMatch(question.criteria.positive, /absence of an error alone does not count/);
    const healthy = await f.run('combined');
    assert.equal(healthy.ratings.repetition, 'stable'); assert.ok(!healthy.uncertain.includes('repetition'));
    f.decide((id, q) => id.startsWith('repetition__') && !id.includes('__facet_') ? 'none'
        : id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present');
    const unresolved = await f.run('combined');
    assert.ok(unresolved.uncertain.includes('repetition')); assert.ok(!unresolved.correctionCodes.includes('repetition'));
    const auto = f.m.namespace('features/automatic-plot.js');
    assert.ok(auto.healthyAuditForAutomaticPlot(selection, unresolved));
    for (const code of ['continuity','character_consistency','primary_genre','support_texture']) {
        const deferred = clone(unresolved); deferred.uncertain.push(code); deferred.ratings[code] = 'attention';
        assert.equal(auto.healthyAuditForAutomaticPlot(selection, deferred), true);
    }
    for (const rating of ['attention','weak']) {
        const blocked = clone(healthy); blocked.ratings.repetition = rating;
        assert.equal(auto.healthyAuditForAutomaticPlot(selection, blocked), false);
    }
    f.decide((id,q) => id.startsWith('repetition__match_') ? `pattern_${id.endsWith('_1') ? 2 : Number(id.split('_').at(-1)) - 1}` : id.startsWith('repetition__pattern_') ? 'wording' : id.startsWith('repetition__facet_') ? 'no' : id.startsWith('repetition__') ? 'failure'
        : id === 'repetition' ? 'weak' : id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present');
    const failure = await f.run('combined');
    assert.ok(failure.correctionCodes.includes('repetition')); assert.equal(auto.healthyAuditForAutomaticPlot(selection, failure), false);
}
// Zero-target schema no longer asks providers to emit empty object fields.
// Missing reasons or invented repairs are still rejected, without another call.
{
    const f = await fixture(); const result = await f.run('combined');
    let calls = 0;
    const output = await f.diagnosis.writeJevFeedback(result, f.selection(), '', async options => {
        calls++;
        assert.deepEqual([...options.jsonSchema.schema.required], ['reasons']);
        assert.deepEqual(Object.keys(options.jsonSchema.schema.properties), ['reasons']);
        return options.parseResult(JSON.stringify({ reasons: f.feedback().reasons }));
    }, 'en');
    assert.equal(calls, 1); assert.deepEqual(clone(output.correctionByCode), {});
    for (const malformed of [{ reasons: {} }, { reasons: f.feedback().reasons, corrections: { repetition: 'Invented repair' } }]) {
        await assert.rejects(f.diagnosis.writeJevFeedback(result, f.selection(), '', async options => options.parseResult(JSON.stringify(malformed))),
            error => error.code === 'STORYBOOSTER_INVALID_FIELDS');
    }
}
// Recommendation cancel removes only the proposal; apply updates selection and
// dismisses it. Neither operation generates an AI request.
{
    const f = await fixture(); const recommendation = f.m.namespace('features/recommendation.js');
    const initial = clone(f.state.genreSelection);
    f.state.genreAnchor.recommendation = { primaryId: 'romcom', supportId: 'cozy', reason: 'Synthetic recommendation.' };
    recommendation.cancelGenreRecommendation();
    assert.deepEqual(clone(f.state.genreSelection), initial); assert.equal(f.state.genreAnchor.recommendation, null);
    f.state.genreAnchor.recommendation = { primaryId: 'romcom', supportId: 'cozy', reason: 'Synthetic recommendation.' };
    recommendation.applyGenreRecommendation();
    assert.equal(f.state.genreSelection.primaryId, 'romcom'); assert.deepEqual([...f.state.genreSelection.supportIds], ['cozy']);
    assert.equal(f.state.genreAnchor.recommendation, null); assert.equal(f.env.requests.length, 0);
}
console.log('dev.11: repetition comparison semantics, actual defects vs uncertainty, independent plot gate, compact valid feedback and recommendation apply/cancel passed.');
