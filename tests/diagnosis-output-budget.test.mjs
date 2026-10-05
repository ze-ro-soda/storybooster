import { completeLegacyPolicyFixture } from './helpers/legacy-policy-fixture.mjs';
import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';

const copy = value => JSON.parse(JSON.stringify(value));

function legacyPayload(f, scope) {
    const properties = f.audit.buildGenreAuditJsonSchema(scope, 'en').schema.properties;
    const value = Object.fromEntries(Object.entries(properties).map(([key, p]) => [key,
        p.type === 'array' ? [] : p.type === 'object' ? {} : p.type === 'boolean' ? false : p.enum?.includes('na') ? 'na' : '']));
    const normal = { primary_genre: 'present', genre_expression: 'present', support_texture: 'present', scene_density: 'present',
        character_consistency: 'stable', character_interpretation: 'stable', char_agency: 'present', relationship: 'present', continuity: 'present', repetition: 'stable' };
    for (const [key, rating] of Object.entries(normal)) if (Object.hasOwn(value, key)) value[key] = rating;
    for (const key of ['primary_genre_evidence', 'genre_expression_evidence', 'support_texture_evidence', 'scene_density_evidence',
        'character_consistency_positive_evidence', 'character_interpretation_positive_evidence', 'char_agency_evidence', 'relationship_evidence', 'continuity_evidence']) {
        if (Object.hasOwn(value, key)) value[key] = [1, 2, 3, 4];
    }
    for (const key of Object.keys(value)) if (key.endsWith('_reason')) value[key] = 'The observed behavior consistently fits the scene and established standard.';
    if (Object.hasOwn(value, 'support_texture_identifiable')) value.support_texture_identifiable = true;
    for (const field of ['corrections', 'next_corrections']) value[field] = Object.fromEntries(Object.keys(properties[field].properties).map(code => [code, '']));
    const target = scope === 'genre' ? 'scene_density' : 'char_agency';
    value[target] = 'attention'; value[`${target}_failure_evidence`] = [8];
    value[`${target}_reason`] = 'One concrete small defect occurred despite an available opportunity.';
    value.corrections[target] = f.feedback(scope, [target]).corrections[target];
    value.next_corrections[target] = 'Use the available scene detail or character-owned choice in the next response.';
    value.character_focus_fields = scope === 'genre' ? [] : ['goals_motives'];
    return { value: completeLegacyPolicyFixture(value), target };
}

// A legacy diagnosis writes its judgment, reasons and repair in one request.
// Main/profile routes and Jev-to-legacy recovery use the same bounded budget
// for every scope, including the final compatibility repair.
for (const route of ['main', 'profile', 'jev_fallback']) for (const scope of ['genre', 'character', 'combined']) for (const attempts of [1, 3]) {
    const f = await fixture();
    f.settings.jevEnabled = route === 'jev_fallback';
    if (route === 'profile') {
        f.settings.analysisProfileId = 'analysis-fixture';
        f.env.context.ConnectionManagerRequestService.getSupportedProfiles = async () => [{ id: 'analysis-fixture', name: 'Synthetic analysis', apiType: 'openai' }];
    }
    if (route === 'jev_fallback') f.env.globals.fetch = async () => { throw Object.assign(new Error('Synthetic Jev timeout.'), { code: 'STORYBOOSTER_JEV_TIMEOUT' }); };
    const { value, target } = legacyPayload(f, scope), replies = JSON.stringify(value);
    const baseline = JSON.stringify(f.settings.characterBaselines);
    f.env.responses(attempts === 1 ? [replies] : ['{}', '{"reasons":', replies]);
    const selection = f.audit.getScopedAuditSelection(f.selection(), scope); selection.autoPlotEnabled = false;
    const row = await f.audit.runGenreDriftAudit('chat_A', selection, { manual: true, scope });
    assert.equal(row.status, 'completed'); assert.equal(row.metrics.engine, 'legacy');
    assert.equal(row.metrics.requestCount, attempts); assert.equal(row.metrics.retryCount, attempts - 1);
    assert.equal(row.metrics.resultSaved, true); assert.equal(row.metrics.displayUpdated, true);
    assert.equal(row.metrics.requestedOutputTokens, 4800);
    assert.deepEqual(f.env.requests.map(args => route === 'profile' ? args[2] : args[0].responseLength), Array(attempts).fill(4800));
    const record = f.state.genreAnchor.lastAudit;
    assert.deepEqual(copy(record.correctionCodes), [target]); assert.equal(record.correctionGeneration, 'generated');
    assert.equal(f.state.genreAnchor.correctionRemaining, 1);
    assert.equal(JSON.stringify(f.settings.characterBaselines), baseline);
    assert.equal(f.storage.normalizeGenreAuditRecord(copy(record)).correctionByCode[target], record.correctionByCode[target]);
    assert.equal(row.events.some(e => e.stage === 'jev_fallback'), route === 'jev_fallback');
    assert.equal(row.metrics.validationCode, undefined); assert.equal(row.metrics.errorKind, undefined);
}

// Both explanations alone and selected repairs start at the successful live
// budget. Even the final repair cannot silently double it to 9600 tokens.
for (const scope of ['genre', 'character', 'combined']) for (const attempts of [1, 3]) {
    const f = await fixture();
    const replies = JSON.stringify(f.feedback(scope));
    f.env.responses(attempts === 1 ? [replies] : ['{}', '{"reasons":', replies]);
    const row = await f.audit.runGenreDriftAudit('chat_A', f.audit.getScopedAuditSelection(f.selection(), scope), { manual: true, scope });
    assert.equal(row.status, 'completed'); assert.equal(row.version, '1.7.1');
    assert.equal(row.metrics.resultSaved, true); assert.equal(row.metrics.displayUpdated, true);
    assert.equal(row.metrics.requestCount, attempts); assert.equal(row.metrics.retryCount, attempts - 1);
    assert.equal(row.metrics.requestedOutputTokens, 4800);
    assert.deepEqual(f.env.requests.map(args => args[0].responseLength), Array(attempts).fill(4800));
    for (const key of ['validationCode', 'validationField', 'errorKind']) assert.equal(row.metrics[key], undefined, key);
    assert.equal(row.metrics.attemptMode, attempts === 1 ? 'schema' : 'repair_json');
    const failures = row.events.filter(e => e.stage === 'compatibility_retry');
    assert.equal(failures.length, attempts - 1);
    if (attempts === 3) {
        assert.equal(failures[0].validationCode, 'output_empty'); assert.equal(failures[0].attemptMode, 'schema');
        assert.equal(failures[1].validationCode, 'json_incomplete'); assert.equal(failures[1].attemptMode, 'plain_json');
        assert.equal(row.metrics.compatibilityFallback, true);
    }
    // Saving/reloading doesn't reintroduce cleared latest errors or lose events.
    const raw = f.env.globals.sessionStorage.getItem('storybooster.audit-runs.v1');
    const next = await fixture({ configure: env => env.globals.sessionStorage.setItem('storybooster.audit-runs.v1', raw) });
    const restored = next.m.namespace('core/audit-run-trace.js').readAuditRuns()[0];
    assert.equal(restored.version, '1.7.1'); assert.equal(restored.metrics.validationCode, undefined);
    assert.equal(restored.events.filter(e => e.stage === 'compatibility_retry').length, attempts - 1);
}

// Confirmed one/two-target repairs keep the same reason and correction parser,
// target priorities, focus bounds and baseline while using the bounded budget.
for (const targets of [['char_agency'], ['char_agency', 'character_consistency']]) {
    const f = await fixture();
    f.decide((id, q) => targets.some(code => id.startsWith(`${code}__facet_`)) ? 'no'
        : targets.some(code => id.startsWith(`${code}__`)) ? 'failure'
        : id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive'
        : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present');
    const fixed = await f.run('character'), before = copy(fixed);
    assert.equal(fixed.correctionCodes.length, targets.length);
    f.env.responses(['{}', '{"reasons":', JSON.stringify(f.feedback('character', fixed.correctionCodes))]);
    const requests = f.m.namespace('core/requests.js');
    const result = await f.diagnosis.writeJevFeedback(fixed, f.audit.getScopedAuditSelection(f.selection(), 'character'), 'Synthetic input.',
        options => requests.requestStructuredJsonWithCompatibility({ ...options, connectionSnapshot: { source: 'profile', profileId: 'profile_A', apiType: 'openai' }, task: 'synthetic_feedback' }), 'en');
    assert.deepEqual(f.env.requests.map(args => args[2]), [4800, 4800, 4800]);
    assert.deepEqual(copy(result.correctionCodes), before.correctionCodes);
    assert.deepEqual(copy(result.ratings), before.ratings); assert.deepEqual(copy(result.uncertain), before.uncertain);
    assert.deepEqual(copy(fixed), before); assert.ok(result.characterFocusFields.length <= 2);
    assert.equal(Object.keys(result.correctionByCode).length, targets.length);
}

// An exhausted feedback fallback still exposes its real failure in latest
// metrics; only a validated result clears the error. Old budgets are unchanged.
{
    const f = await fixture({ developerMode: true }); f.env.responses(['{}', '{}', '{}']);
    const row = await f.audit.runAutomaticAuditTest();
    assert.equal(row.status, 'completed'); assert.equal(row.metrics.feedbackFallback, true);
    assert.equal(row.metrics.validationCode, 'output_empty'); assert.equal(row.metrics.attemptMode, 'repair_json');
    assert.equal(row.metrics.requestCount, 3); assert.equal(row.metrics.requestedOutputTokens, 4800);
    assert.deepEqual(f.env.requests.map(args => args[0].responseLength), [4800, 4800, 4800]);
    const requests = f.m.namespace('core/requests.js');
    for (const cap of [undefined, -1, 1000, NaN]) {
        f.env.responses(['{}', '{"event":', '{"event":"Synthetic event."}']);
        const value = await requests.requestStructuredJsonWithCompatibility({ prompt: 'Synthetic.', transcript: 'Synthetic.',
            responseLength: 1200, repairResponseLength: cap, connectionSnapshot: { source: 'main' },
            task: 'synthetic_legacy', parseResult: JSON.parse });
        assert.equal(value.event, 'Synthetic event.');
        assert.deepEqual(f.env.requests.map(args => args[0].responseLength), [1200, 1200, 4800]);
    }
    const trace = f.m.namespace('core/automatic-plot-trace.js');
    const run = trace.startAutomaticPlotTrace(row.id);
    assert.ok(trace.buildAutomaticPlotTraceReport().includes('1.7.1'));
    assert.ok(run);
}

console.log('Unified legacy/Jev 4800-token writing, all scopes and main/profile/fallback routes, bounded retries, saved repairs and unchanged generic transport passed.');
