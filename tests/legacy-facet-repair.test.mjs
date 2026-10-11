import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/diagnosis-fixture.mjs';
import { completeLegacyPolicyFixture } from './helpers/legacy-policy-fixture.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
function payload(f, scope = 'combined') {
    const p = f.diagnosis.createEmptyJevPayload(f.audit.buildGenreAuditJsonSchema(scope, 'en'));
    for (const code of Object.keys(p)) {
        if (code.endsWith('_reason')) p[code] = 'Synthetic observations support the applicable scene and established standard.';
        if (code.endsWith('_evidence') && !/failure|consistency_evidence|interpretation_evidence/.test(code)) p[code] = [1, 2, 3, 4];
    }
    for (const [code, rating] of Object.entries({ primary_genre: 'present', genre_expression: 'present', support_texture: 'present',
        scene_density: 'present', character_consistency: 'stable', character_interpretation: 'stable', char_agency: 'present',
        relationship: 'present', continuity: 'present', repetition: 'stable' })) if (code in p) p[code] = rating;
    if ('support_texture_identifiable' in p) p.support_texture_identifiable = true;
    return completeLegacyPolicyFixture(p);
}
const parse = (f, p) => f.audit.parseGenreAuditResult(JSON.stringify(p), true, 10, 'combined', 'en');
const promptText = request => typeof request.prompt === 'string' ? request.prompt : request.prompt[0].content;

test('plain JSON contains complete character facet objects without changing shared choices or genre-only scope', async () => {
    const f = await fixture(), policy = f.m.namespace('core/audit-policy.js'), validation = f.m.namespace('core/response-validation.js');
    for (const scope of ['combined', 'character']) {
        const prompt = f.audit.buildGenreAuditPrompt(f.audit.getScopedAuditSelection(f.selection(), scope), scope, 'en');
        const match = prompt.match(/CHARACTER FACET JSON CONTRACT:.*?: (\{[^\n]+?\})\. Each value/);
        assert.ok(match, scope);
        const shape = JSON.parse(match[1]);
        for (const code of ['character_consistency', 'character_interpretation']) {
            const field = `${code}_facets`;
            assert.deepEqual(Object.keys(shape[field]), Object.keys(policy.AUDIT_PROBLEM_IMPACT[code]));
            for (const id of Object.keys(shape[field])) {
                assert.equal(shape[field][id], 'uncertain');
                assert.equal(validation.filterResponseValidationDetails({ validationCode: 'field_type', validationField: `${field}.${id}` }).validationField, `${field}.${id}`);
            }
        }
        assert.match(prompt, /structural placeholders, not suggested verdicts/);
    }
    const genre = f.audit.buildGenreAuditPrompt(f.audit.getScopedAuditSelection(f.selection(), 'genre'), 'genre', 'en');
    assert.doesNotMatch(genre, /CHARACTER FACET JSON CONTRACT/);
});

test('malformed facet objects report safe exact fields and reject missing, wrong-type, wrong-value and extra keys', async () => {
    const f = await fixture(), diagnostics = f.m.namespace('core/diagnostics.js');
    const cases = [
        [null, 'field_type', 'character_consistency_facets'],
        [[], 'field_type', 'character_consistency_facets'],
        [{ ...payload(f).character_consistency_facets, motives: true }, 'field_type', 'character_consistency_facets.motives'],
        [{ ...payload(f).character_consistency_facets, motives: 'SYNTHETIC_PRIVATE_VALUE' }, 'field_value', 'character_consistency_facets.motives'],
        [Object.fromEntries(Object.entries(payload(f).character_consistency_facets).filter(([id]) => id !== 'voice')), 'field_missing', 'character_consistency_facets.voice'],
        [{ ...payload(f).character_consistency_facets, SYNTHETIC_PRIVATE_KEY: 'SYNTHETIC_PRIVATE_VALUE' }, 'unexpected_field', 'character_consistency_facets'],
    ];
    for (const [value, code, field] of cases) {
        const p = payload(f); p.character_consistency_facets = value;
        let error; assert.throws(() => parse(f, p), e => { error = e; return e.code === 'STORYBOOSTER_INVALID_FIELDS'; });
        assert.equal(error.validationCode, code); assert.equal(error.validationField, field);
        assert.deepEqual(Array.from(error[code === 'field_missing' ? 'missingFields' : 'invalidFields']), [field]);
        const diagnostic = diagnostics.createOperationDiagnostic({ task: 'synthetic_facet_validation' });
        diagnostics.captureOperationResponseDiagnostic(diagnostic, null, JSON.stringify(p), 'generateRawData');
        const row = diagnostics.recordStoryBoosterError(error, { diagnostic });
        const report = diagnostics.formatStoryBoosterErrorEntry(row, 0);
        assert.ok(report.includes(`검증 분류/필드: ${code} / ${field}`));
        assert.doesNotMatch(report, /SYNTHETIC_PRIVATE_VALUE|SYNTHETIC_PRIVATE_KEY/);
        assert.ok(row.returnedFields.some(item => item.startsWith('character_consistency_facets:')));
        assert.ok(row.returnedFields.some(item => item.startsWith('character_interpretation_facets:')));
        assert.ok(row.returnedFields.length <= 40);
    }
});

test('both plain JSON retries use the latest failed field and recover through the full audit path', async () => {
    for (const scope of ['combined', 'character']) {
        const f = await fixture(); f.settings.jevEnabled = false;
        const valid = payload(f, scope), first = clone(valid), second = clone(valid);
        first.character_consistency_facets = [];
        second.character_interpretation_facets.nuance = 'SYNTHETIC_PRIVATE_VALUE';
        const answers = [first, second, valid], calls = [];
        f.env.context.generateRawData = async options => { calls.push(options); return JSON.stringify(answers.shift()); };
        const row = await f.audit.runGenreDriftAudit('chat_A', f.audit.getScopedAuditSelection(f.selection(), scope), { manual: true, scope });
        assert.equal(row.status, 'completed'); assert.equal(row.metrics.resultSaved, true); assert.equal(row.metrics.displayUpdated, true);
        assert.equal(row.metrics.requestCount, 3); assert.equal(row.metrics.retryCount, 2);
        assert.doesNotMatch(promptText(calls[0]), /VALIDATION REPAIR/);
        assert.match(promptText(calls[1]), /Fixed field: character_consistency_facets\./);
        assert.match(promptText(calls[2]), /Fixed field: character_interpretation_facets.nuance\./);
        for (const call of calls) { assert.equal(call.responseLength, 4800); assert.ok(!call.jsonSchema); assert.doesNotMatch(promptText(call), /SYNTHETIC_PRIVATE_VALUE/); }
        const retries = row.events.filter(event => event.stage === 'compatibility_retry');
        assert.equal(retries[0].validationCode, 'field_type');
        assert.equal(retries[1].validationField, 'character_interpretation_facets.nuance');
    }
});

test('persistent malformed facets exhaust only two retries and never save a healthy diagnosis', async () => {
    const f = await fixture(); f.settings.jevEnabled = false;
    const p = payload(f); p.character_consistency_facets = { motives: 'yes' };
    f.env.responses([JSON.stringify(p), JSON.stringify(p), JSON.stringify(p)]);
    const row = await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: true, scope: 'combined' });
    assert.equal(row.status, 'failed'); assert.equal(row.metrics.resultSaved, false);
    assert.equal(row.metrics.requestCount, 3); assert.equal(row.metrics.retryCount, 2);
    assert.equal(f.state.genreAnchor.correctionCodes.length, 0);
    const log = f.m.namespace('core/diagnostics.js').readStoryBoosterErrorLog()[0];
    assert.equal(log.validationCode, 'field_missing'); assert.equal(log.validationField, 'character_consistency_facets.values');
    assert.match(log.retryReason, /필수 응답 필드 누락/);
});

test('unknown field names and raw provider errors cannot enter repair instructions or validation detail logs', async () => {
    const f = await fixture(), validation = f.m.namespace('core/response-validation.js');
    for (const validationField of ['character_consistency_facets.SYNTHETIC_PRIVATE_KEY', 'SYNTHETIC_PRIVATE_KEY']) {
        const error = { code: 'STORYBOOSTER_INVALID_FIELDS', validationCode: 'field_type', validationField, message: 'SYNTHETIC_PRIVATE_VALUE' };
        const repaired = validation.responseRepairInstruction(error);
        assert.doesNotMatch(repaired, /SYNTHETIC_PRIVATE/);
        assert.equal(repaired, '');
        assert.equal(validation.responseValidationDetails(error).validationField, undefined);
    }
});

test('all allowed facet verdicts keep their original meaning, and absent compatible fields still defer', async () => {
    const f = await fixture();
    for (const verdict of ['yes', 'no', 'justified', 'temporary', 'no_opportunity', 'uncertain']) {
        const p = payload(f);
        for (const code of ['character_consistency', 'character_interpretation']) p[`${code}_facets`] = Object.fromEntries(Object.keys(p[`${code}_facets`]).map(id => [id, verdict]));
        const result = parse(f, p);
        assert.equal(Array.from(result.uncertain).includes('character_consistency'), ['no', 'no_opportunity', 'uncertain'].includes(verdict));
        assert.equal(Array.from(result.uncertain).includes('character_interpretation'), ['no', 'no_opportunity', 'uncertain'].includes(verdict));
    }
    const p = payload(f); delete p.character_consistency_facets; delete p.character_interpretation_facets;
    const result = parse(f, p);
    assert.ok(Array.from(result.uncertain).includes('character_consistency'));
    assert.ok(Array.from(result.uncertain).includes('character_interpretation'));
});

test('Jev still uses its existing two decision calls and one feedback schema request', async () => {
    const f = await fixture(); f.env.responses([JSON.stringify(f.feedback())]);
    const row = await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: true, scope: 'combined' });
    assert.equal(row.metrics.engine, 'jev'); assert.equal(row.metrics.requestCount, 1); assert.equal(row.metrics.retryCount, 0);
    assert.equal(row.metrics.resultSaved, true); assert.equal(f.bodies.length, 2);
    assert.equal(f.env.requests[0][0].responseLength, 4800); assert.ok(f.env.requests[0][0].jsonSchema);
});
