import assert from 'node:assert/strict';
import { environment, loadModules } from './vm-harness.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const correction = 'Preserve the established voice, careful judgment, and supported relationship-specific warmth. In the next reply, make a context-appropriate choice from the character’s own motives and follow through within the character’s control. Avoid repeatedly asking the user to decide the character’s actions. Keep the user free to respond or decline, and do not decide their thoughts, actions, dialogue, feelings or consent. Do not invent a new event or reset the current scene. Express the repair through an observable choice or action while preserving the already healthy traits and natural development.';

async function fixture() {
    const env = environment();
    env.context.chat = Array.from({ length: 10 }, (_, n) => [
        { is_user: true, mes: `The partner offers an option ${n}.` },
        { is_user: false, mes: `The investigator considers the option ${n}.` },
    ]).flat();
    env.context.getRequestHeaders = () => ({ 'X-CSRF-Token': 'fixture' });
    const bodies = [];
    let choose = (id, q) => id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present';
    env.globals.fetch = async (_url, options) => {
        const body = JSON.parse(JSON.parse(options.body).custom_include_body);
        bodies.push(body);
        return { ok: true, json: async () => ({ model: 'jev-test', answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
            const selected = choose(id, q);
            const choice = /^repetition__(match|pattern)_/.test(id) && !Object.hasOwn(q.criteria, selected) ? 'none' : selected;
            return [id, { type: 'choice', choice, confidence: 0.95, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
        })) }) };
    };
    const m = await loadModules(env); await env.ready[0]();
    const storage = m.namespace('core/storage.js'), audit = m.namespace('features/audit.js');
    const diagnosis = m.namespace('features/jev-diagnosis.js'), client = m.namespace('core/jev-client.js');
    const settings = storage.ensureModuleSettings(), state = storage.ensureChatState();
    settings.jevEnabled = true; settings.jevConsentVersion = 1; settings.outputLanguage = 'en';
    state.genreSelection.primaryId = 'romance'; state.genreSelection.supportIds = ['mystery'];
    const identity = m.namespace('core/context.js').getCurrentCharacterIdentity();
    storage.writeCharacterBaselineVersion(identity, { fields: {
        core_identity: { text: 'A restrained independent investigator with firm boundaries.', pinned: true },
        relationship_response: { text: 'A trusted partner; increased warmth is supported within that relationship.' },
    }, boostAnchor: 'Preserve independent judgment, restraint and relationship-specific trust.', sourceHash: identity.sourceHash, updatedAt: Date.now() }, '');
    client.setJevSessionKey('synthetic-key');
    const selection = () => audit.getBoosterSelection(state);
    const run = scope => {
        const selected = audit.getScopedAuditSelection(selection(), scope);
        return diagnosis.runJevDiagnosis({ selection: selected, transcript: 'Numbered synthetic replies.', reviewedResponses: 10,
            schema: audit.buildGenreAuditJsonSchema(scope, 'en'), outputLanguage: 'en',
            parseResult: raw => audit.parseGenreAuditResult(raw, Boolean(selected.supportGenre), 10, scope, 'en', false) });
    };
    const feedback = (scope = 'combined', targets = []) => ({
        reasons: Object.fromEntries(diagnosis.getJevDimensions(audit.getScopedAuditSelection(selection(), scope)).map(d => [d.id,
            targets.includes(d.id) ? 'The character repeatedly defers independent judgment despite opportunities to act.' : 'The observed behavior remains appropriate to the scene and selected standard.'])),
        corrections: Object.fromEntries(targets.map(k => [k, correction])),
        next_corrections: Object.fromEntries(targets.map(code => [code, 'Let the next response reflect the established motive through a concrete choice.'])),
        character_focus_fields: targets.some(k => k.startsWith('character_') || k === 'char_agency') ? ['core_identity'] : [],
    });
    return { env, m, storage, audit, diagnosis, client, settings, state, bodies, selection, run, feedback,
        decide: fn => { choose = fn; } };
}

// Full genre+character evaluation: sixty independent questions, then final
// category and per-reply evidence checks. Question IDs are not prose reasons.
{
    const f = await fixture(); const result = await f.run('combined');
    assert.equal(Object.keys(f.bodies[0].questions).length, 60);
    assert.equal(Object.keys(f.bodies[1].questions).length, 110);
    assert.equal(result.jev.questions, 170);
    assert.equal(result.observations.char_agency.length, 6);
    assert.ok(f.bodies[1].state.independent_observations.char_agency);
    assert.deepEqual(clone(result.correctionCodes), []);
}

// A single independently verified facet is not erased by five healthy facets.
// The existing distinct-reply reducer must still confirm the problem.
{
    const f = await fixture();
    f.decide((id, q) => id.includes('__facet_') ? (id === 'character_consistency__facet_motives' ? 'no' : 'yes')
        : id === 'character_consistency' ? 'drifted'
        : id.startsWith('character_consistency__') ? (Number(id.split('__')[1]) >= 9 ? 'failure' : 'none')
        : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present');
    const result = await f.run('character');
    assert.deepEqual(clone(result.correctionCodes), ['character_consistency']);
    assert.equal(result.observations.character_consistency.filter(x => x.verdict === 'yes').length, 5);
    assert.equal(result.evidence.characterConsistency.length, 2);
}

// Supported emotional change is preserved, and an unsupported aggregate
// failure cannot invent a correction absent from the independent observations.
for (const inconsistentAggregate of [false, true]) {
    const f = await fixture();
    f.decide((id, q) => id.includes('__facet_') ? (id === 'character_consistency__facet_emotion' ? 'justified' : 'yes')
        : id === 'character_consistency' && inconsistentAggregate ? 'drifted'
        : id.startsWith('character_consistency__') ? 'justified'
        : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present');
    const result = await f.run('character');
    assert.deepEqual(clone(result.correctionCodes), []);
    assert.equal(result.ratings.character_consistency, inconsistentAggregate ? 'attention' : 'stable');
    assert.ok(result.observations.character_consistency.some(x => x.verdict === 'justified'));
}

// An untested or uncertain facet cannot veto sufficient clear positives.
// It contributes no positive evidence of its own and authorizes no repair.
{
    const f = await fixture();
    f.decide((id, q) => id === 'character_consistency__facet_values' ? 'uncertain'
        : id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present');
    const result = await f.run('character');
    assert.equal(result.ratings.character_consistency, 'stable');
    assert.ok(!result.uncertain.includes('character_consistency'));
    assert.deepEqual(clone(result.correctionCodes), []);
}

// Existing analysis profile writes all reasons and both selected corrections
// in ONE successful call; genre+character text survives reload and is injected
// only for the currently selected targets.
{
    const f = await fixture();
    f.settings.analysisProfileId = 'analysis-fixture';
    f.env.context.ConnectionManagerRequestService.getSupportedProfiles = async () => [
        { id: 'analysis-fixture', name: 'Analysis fixture', model: 'fixture-model', apiType: 'openai' },
    ];
    f.decide((id, q) => id.includes('__facet_') ? (['primary_genre__facet_choices', 'character_consistency__facet_motives'].includes(id) ? 'no' : 'yes')
        : id === 'primary_genre' ? 'weak' : id === 'character_consistency' ? 'drifted'
        : /^(primary_genre|character_consistency)__\d+$/.test(id) ? (Number(id.split('__')[1]) >= (id.startsWith('primary_genre__') ? 8 : 9) ? 'failure' : 'none')
        : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present');
    const baseline = JSON.stringify(f.settings.characterBaselines);
    const feedback = f.feedback('combined', ['primary_genre', 'character_consistency']);
    feedback.corrections.primary_genre = 'Preserve the established romantic atmosphere while letting the current relationship affect a concrete choice and its immediate consequence. Let the character’s own motives guide that choice without inventing a new event, forcing intimacy, or deciding the user’s response. Continue the existing scene and leave the user free to respond.';
    f.env.responses([JSON.stringify(feedback)]);
    await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: true, scope: 'combined' });
    const record = f.state.genreAnchor.lastAudit;
    assert.equal(f.env.requests.length, 1);
    assert.equal(f.env.requests[0][0], 'analysis-fixture');
    assert.match(f.env.requests[0][1][0].content, /independent observations/);
    assert.match(f.env.requests[0][1][0].content, /supported growth/);
    assert.equal(record.feedbackConnection.profileName, 'Analysis fixture');
    assert.deepEqual(clone(record.correctionCodes), ['character_consistency', 'primary_genre']);
    assert.equal(f.state.genreAnchor.correctionRemaining, 1);
    assert.equal(JSON.stringify(f.settings.characterBaselines), baseline);
    const restored = f.storage.normalizeGenreAuditRecord(clone(record));
    assert.equal(restored.correctionByCode.primary_genre, feedback.corrections.primary_genre);
    assert.equal(restored.reasons.character_consistency, feedback.reasons.character_consistency);
    assert.match(f.audit.buildGenrePromptText(f.selection()), /concrete choice and its immediate consequence/);
    f.audit.toggleManualAuditBoost('primary_genre', record);
    assert.doesNotMatch(f.audit.buildGenrePromptText(f.selection()), /concrete choice and its immediate consequence/);
    assert.match(f.audit.buildGenrePromptText(f.selection()), /repeatedly asking the user/);
    f.audit.cancelPendingGenreCorrection('character');
    assert.deepEqual(clone(f.state.genreAnchor.correctionByCode), {});
    assert.doesNotMatch(f.audit.buildGenrePromptText(f.selection()), /repeatedly asking the user/);
}

// Reply-count reducers may not bypass healthy independent observations.
for (const target of ['char_agency', 'relationship', 'continuity', 'scene_density']) {
    const f = await fixture();
    f.decide((id, q) => id.includes('__facet_') ? 'yes'
        : id === target ? 'weak'
        : id.startsWith(`${target}__`) ? 'failure'
        : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present');
    const result = await f.run('combined');
    assert.equal(result.ratings[target], 'attention');
    assert.ok(result.uncertain.includes(target));
    assert.ok(!result.correctionCodes.includes(target));
}

// Generated prose cannot add corrections for healthy/unselected dimensions.
{
    const f = await fixture(); const result = await f.run('genre');
    await assert.rejects(f.diagnosis.writeJevFeedback(result, f.audit.getScopedAuditSelection(f.selection(), 'genre'), 'test', async options => {
        const malformed = f.feedback('genre'); malformed.corrections.char_agency = correction;
        return options.parseResult(JSON.stringify(malformed));
    }, 'en'), error => error.code === 'STORYBOOSTER_INVALID_FIELDS');
}

// Updating older development settings requires new Jev disclosure consent
// while preserving automatic-plot opt-in and application history.
{
    const env = environment();
    env.settings['rp-genre-plot-booster'] = {
        settingsSchemaVersion: 23, jevEnabled: true, jevConsentVersion: 1,
        chats: { chat_A: { automaticPlot: { enabled: true, cooldownReplies: 30, lastAppliedCount: 7, status: 'idle' } } },
    };
    const m = await loadModules(env);
    const settings = m.namespace('core/storage.js').ensureModuleSettings();
    assert.equal(settings.settingsSchemaVersion, 25);
    assert.equal(settings.jevEnabled, false);
    assert.equal(settings.jevConsentVersion, 0);
    assert.equal(settings.chats.chat_A.automaticPlot.enabled, true);
    assert.equal(settings.chats.chat_A.automaticPlot.lastAppliedCount, 7);
    assert.ok(!Object.hasOwn(settings.chats.chat_A.automaticPlot, 'cooldownReplies'));
}

console.log('Deep observations, natural growth, non-voting guards, analysis profile, combined feedback, persistence, correction removal and migration passed.');

function configureProblems(f, problems) {
    const facets = new Set(problems.map(p => `${p.code}__facet_${p.facet}`));
    f.decide((id, q) => {
        if (id.includes('__facet_')) return facets.has(id) ? 'no' : 'yes';
        const problem = problems.find(p => id === p.code || id.startsWith(`${p.code}__`));
        if (problem) {
            if (id === problem.code) return problem.rating || 'attention';
            const n = Number(id.split('__')[1]);
            return n > 10 - (problem.count || 1) ? 'failure' : 'none';
        }
        return id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present';
    });
}
// A single confirmed mild lapse can receive a proportionate correction without
// pretending the old sustained-drift threshold was met.
{
    const f = await fixture();
    configureProblems(f, [{ code: 'character_consistency', facet: 'motives' }]);
    const result = await f.run('character');
    assert.equal(result.ratings.character_consistency, 'attention');
    assert.ok(!result.uncertain.includes('character_consistency'));
    assert.deepEqual(clone(result.correctionCodes), ['character_consistency']);
    const baseline = JSON.stringify(f.settings.characterBaselines);
    f.env.responses([JSON.stringify(f.feedback('character', ['character_consistency']))]);
    await f.audit.runGenreDriftAudit('chat_A', f.audit.getScopedAuditSelection(f.selection(), 'character'), { manual: true, scope: 'character' });
    assert.equal(f.env.requests.length, 1, 'Reason, repair and summary share one successful profile call');
    assert.equal(f.state.genreAnchor.correctionRemaining, 1);
    const saved = f.storage.normalizeGenreAuditRecord(clone(f.state.genreAnchor.lastCharacterAudit));
    assert.equal(saved.ratings.character_consistency, 'attention');
    assert.match(saved.correctionSummaries.character_consistency, /concrete choice/);
    assert.equal(JSON.stringify(f.settings.characterBaselines), baseline);
    assert.match(f.audit.buildGenrePromptText(f.selection()), /careful judgment/);
}
// Five cautions do not produce five repairs: motives and knowledge directly
// constrain the next response, ahead of prose repetition/texture.
{
    const f = await fixture();
    configureProblems(f, [
        { code: 'character_consistency', facet: 'motives' },
        { code: 'continuity', facet: 'knowledge' },
        { code: 'primary_genre', facet: 'core' },
        { code: 'genre_expression', facet: 'narration' },
        { code: 'repetition', facet: 'wording' },
    ]);
    const result = await f.run('combined');
    assert.deepEqual(clone(result.correctionCodes), ['character_consistency', 'continuity']);
    assert.equal(result.ratings.primary_genre, 'attention');
}
// Strong, independently confirmed failure outranks a mild lapse even if the
// mild lapse has a higher impact weight. Counts refer to distinct replies.
{
    const f = await fixture();
    configureProblems(f, [
        { code: 'primary_genre', facet: 'choices', rating: 'weak', count: 3 },
        { code: 'character_consistency', facet: 'values', count: 1 },
    ]);
    const result = await f.run('combined');
    assert.equal(result.ratings.primary_genre, 'weak');
    assert.deepEqual(clone(result.correctionCodes), ['primary_genre', 'character_consistency']);
}
// Support has no attention enum in the legacy provider schema, but a confirmed
// Jev mild problem is represented and preserved after the legacy reducer.
{
    const f = await fixture();
    configureProblems(f, [{ code: 'support_texture', facet: 'integration' }]);
    const result = await f.run('genre');
    assert.equal(result.ratings.support_texture, 'attention');
    assert.deepEqual(clone(result.correctionCodes), ['support_texture']);
    const restored = f.storage.normalizeGenreAuditRecord({ ...result, selection: {}, status: 'pending' });
    assert.equal(restored.ratings.support_texture, 'attention');
}
// Same severity and impact: actual failed-reply frequency, confidence, then
// deterministic order. Never count correlated facets as extra failed replies.
{
    const f = await fixture(); const policy = f.m.namespace('features/jev-policy.js');
    const common = { rating: 'attention', severe: false, impact: 3, failedReplies: 2, confidence: 0.9 };
    assert.deepEqual(clone(policy.rankJevCorrections([
        { ...common, code: 'primary_genre', failedReplies: 5 },
        { ...common, code: 'relationship', confidence: 0.95 },
        { ...common, code: 'character_interpretation' },
    ])), ['primary_genre', 'relationship']);
    assert.deepEqual(clone(policy.rankJevCorrections([
        { ...common, code: 'relationship' }, { ...common, code: 'primary_genre' },
    ])), ['relationship', 'primary_genre']);
}
console.log('Confirmed caution, proportional one-shot repair, deferred uncertainty, two-repair priority, summary persistence and support caution passed.');
