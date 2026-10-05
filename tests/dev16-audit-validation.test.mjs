import { completeLegacyPolicyFixture } from './helpers/legacy-policy-fixture.mjs';
import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
function gate() {
    let start, release;
    return { entered: new Promise(resolve => { start = resolve; }), wait: new Promise(resolve => { release = resolve; }),
        start: () => start(), release: () => release() };
}
function legacyPayload(f, scope) {
    const value = f.diagnosis.createEmptyJevPayload(f.audit.buildGenreAuditJsonSchema(scope, 'en'));
    const normal = { primary_genre: 'present', genre_expression: 'present', support_texture: 'present', scene_density: 'present',
        character_consistency: 'stable', character_interpretation: 'stable', char_agency: 'present', relationship: 'present', continuity: 'present', repetition: 'stable' };
    for (const [code, rating] of Object.entries(normal)) if (Object.hasOwn(value, code)) value[code] = rating;
    for (const key of Object.keys(value)) {
        if (key.endsWith('_reason')) value[key] = 'The observed behavior consistently fits the scene and established standard.';
        if (key.endsWith('_evidence') && !/failure|negative|consistency_evidence|interpretation_evidence/.test(key)) value[key] = [1, 2, 3, 4];
    }
    if (Object.hasOwn(value, 'support_texture_identifiable')) value.support_texture_identifiable = true;
    return completeLegacyPolicyFixture(value);
}
async function pausedAudit(f, scope, engine = 'jev') {
    f.settings.jevEnabled = engine === 'jev';
    const g = gate();
    f.env.context.generateRawData = async () => {
        g.start(); await g.wait;
        return JSON.stringify(engine === 'jev' ? f.feedback(scope) : legacyPayload(f, scope));
    };
    const selected = f.audit.getScopedAuditSelection(f.selection(), scope);
    const task = f.audit.runGenreDriftAudit('chat_A', selected, { manual: true, scope });
    await g.entered;
    return { task, release: g.release, plot: f.m.namespace('core/automatic-plot-state.js') };
}

// Reproduce the report: no chat edit, only a plot setting/cancellation while
// feedback is in flight. Both engines must store independent audit results.
for (const engine of ['jev', 'legacy']) for (const scope of ['genre', 'character', 'combined']) {
    const f = await fixture(), pending = await pausedAudit(f, scope, engine);
    f.settings.plotProfileId = 'synthetic-plot-profile'; f.settings.plotMaxTokens = 2000;
    pending.plot.cancelAutomaticPlot();
    pending.release();
    const row = await pending.task;
    assert.equal(row.status, 'completed', `${engine}/${scope}`);
    assert.equal(row.metrics.resultSaved, true); assert.equal(row.metrics.displayUpdated, true);
    assert.equal(f.state.genreAnchor.auditHistory.length, 1);
}

// Toggling the audited feature off and back on still invalidates its run;
// changing only the other booster does not cancel a scoped audit.
for (const scope of ['genre', 'character']) for (const same of [true, false]) {
    const f = await fixture(), p = await pausedAudit(f, scope);
    const panels = f.m.namespace('ui/panels.js');
    const feature = same ? scope : scope === 'genre' ? 'character' : 'genre';
    panels.changeBoosterFeature(feature, false); panels.changeBoosterFeature(feature, true);
    p.release(); const row = await p.task;
    assert.equal(row.status, same ? 'cancelled' : 'completed', `${scope}/${feature}`);
    if (same) assert.equal(row.reason, 'selection_changed');
}

// Genre diagnosis also works when no individual character is selected.
{
    const f = await fixture(); f.env.context.characterId = undefined;
    const p = await pausedAudit(f, 'genre'); p.plot.cancelAutomaticPlot(); p.release();
    const row = await p.task; assert.equal(row.status, 'completed'); assert.equal(row.metrics.resultSaved, true);
}

// A combined audit actually including plot still discards outdated decisions.
{
    const f = await fixture(); f.m.namespace('features/automatic-plot.js').setAutomaticPlotEnabled(true);
    assert.equal(f.selection().autoPlotEnabled, true);
    const p = await pausedAudit(f, 'combined'); p.plot.cancelAutomaticPlot(); p.release();
    const row = await p.task;
    assert.equal(row.status, 'cancelled'); assert.equal(row.reason, 'plot_epoch_changed');
    assert.equal(row.metrics.resultSaved, false); assert.equal(f.state.genreAnchor.auditHistory.length, 0);
}

// Independent audits retain all relevant guards, even a chat round trip or
// generation stop followed by an unrelated plot cancellation.
for (const change of ['profile', 'language', 'profile_round_trip', 'language_round_trip', 'character', 'baseline', 'messages', 'key', 'chat_round_trip', 'stop_then_plot']) {
    const f = await fixture(), p = await pausedAudit(f, 'character');
    const reasons = { profile: 'profile_changed', language: 'language_changed', profile_round_trip: 'profile_changed',
        language_round_trip: 'language_changed', character: 'character_changed', baseline: 'selection_changed',
        messages: 'messages_changed', key: 'key_changed', chat_round_trip: 'chat_changed', stop_then_plot: 'generation_stopped' };
    if (change === 'profile') f.settings.analysisProfileId = 'synthetic-analysis-profile';
    if (change === 'language') f.settings.outputLanguage = 'ko';
    if (change.endsWith('_round_trip') && change !== 'chat_round_trip') {
        p.plot.cancelAutomaticPlot(change.startsWith('profile') ? 'profile_changed' : 'language_changed');
        p.plot.cancelAutomaticPlot();
    }
    if (change === 'character') f.env.context.characters[0].avatar = 'different-synthetic-character.png';
    if (change === 'baseline') {
        const identity = f.m.namespace('core/context.js').getCurrentCharacterIdentity();
        f.storage.writeCharacterBaselineVersion(identity, { fields: { core_identity: { text: 'Changed synthetic baseline.' } },
            boostAnchor: 'Changed synthetic anchor.', sourceHash: identity.sourceHash, updatedAt: Date.now() }, '');
    }
    if (change === 'messages') f.env.context.chat.at(-1).mes += ' Edited.';
    if (change === 'key') f.client.setJevSessionKey('changed-synthetic-key');
    if (change === 'chat_round_trip') {
        f.env.context.chatId = 'chat_B'; f.env.listeners.get('CHAT_CHANGED')[0]();
        f.env.context.chatId = 'chat_A'; f.env.listeners.get('CHAT_CHANGED')[0]();
    }
    if (change === 'stop_then_plot') { p.plot.cancelAutomaticPlot('generation_stopped'); p.plot.cancelAutomaticPlot(); }
    p.release(); const row = await p.task;
    assert.equal(row.status, 'cancelled', change); assert.equal(row.reason, reasons[change], change);
    assert.equal(row.metrics.resultSaved, false); assert.equal(f.state.genreAnchor.auditHistory.length, 0);
    assert.equal(f.m.namespace('core/runtime.js').genreAuditPendingChats.size, 0);
}

// Exercise each failed feedback contract without logging its values or keys.
{
    const f = await fixture(), fixed = await f.run('character');
    const cases = [
        [() => null, 'field_type', 'response'],
        [v => { delete v.reasons; return v; }, 'field_missing', 'reasons'],
        [v => { v.reasons = []; return v; }, 'field_type', 'reasons'],
        [v => { delete v.reasons.character_consistency; return v; }, 'field_missing', 'reasons.character_consistency'],
        [v => { v.reasons.character_consistency = 123; return v; }, 'field_type', 'reasons.character_consistency'],
        [v => { v.reasons.character_consistency = 'short'; return v; }, 'field_too_short', 'reasons.character_consistency'],
        [v => { v.reasons['secret-in-unexpected-key'] = 'private-value'; return v; }, 'unexpected_field', 'reasons'],
        [v => { v.character_focus_fields = ['private-value']; return v; }, 'field_value', 'character_focus_fields'],
        [v => { v.corrections = { char_agency: 'private-value' }; return v; }, 'unexpected_field', 'corrections'],
    ];
    for (const [mutate, code, field] of cases) {
        await assert.rejects(f.diagnosis.writeJevFeedback(fixed, f.audit.getScopedAuditSelection(f.selection(), 'character'), '',
            async opts => opts.parseResult(JSON.stringify(mutate(copy(f.feedback('character')))))), error => {
                assert.equal(error.code, 'STORYBOOSTER_INVALID_FIELDS');
                assert.equal(error.validationCode, code); assert.equal(error.validationField, field);
                assert.ok(!error.message.includes('private-value')); return true;
            });
    }
    const repair = { ...fixed, correctionCodes: ['char_agency'] };
    for (const [mutate, code, field] of [
        [v => { delete v.corrections.char_agency; }, 'field_missing', 'corrections.char_agency'],
        [v => { v.corrections.char_agency = []; }, 'field_type', 'corrections.char_agency'],
        [v => { v.corrections.char_agency = 'short'; }, 'field_too_short', 'corrections.char_agency'],
        [v => { delete v.next_corrections.char_agency; }, 'field_missing', 'next_corrections.char_agency'],
        [v => { v.next_corrections.char_agency = false; }, 'field_type', 'next_corrections.char_agency'],
        [v => { v.next_corrections.char_agency = 'short'; }, 'field_too_short', 'next_corrections.char_agency'],
        [v => { v.next_corrections.char_agency = 'x'.repeat(141); }, 'field_too_long', 'next_corrections.char_agency'],
    ]) {
        const value = f.feedback('character', ['char_agency']); mutate(value);
        await assert.rejects(f.diagnosis.writeJevFeedback(repair, f.audit.getScopedAuditSelection(f.selection(), 'character'), '',
            async opts => opts.parseResult(JSON.stringify(value))), error => error.validationCode === code && error.validationField === field);
    }
}

// Failed attempts are preserved individually even when the final retry saves.
// Export and restored session records must use the same allowlists.
{
    const f = await fixture({ developerMode: true });
    const first = f.feedback(), second = f.feedback();
    delete first.reasons.character_consistency; second.reasons.continuity = 'short';
    f.env.responses([JSON.stringify(first), JSON.stringify(second), JSON.stringify(f.feedback())]);
    const row = await f.audit.runAutomaticAuditTest();
    assert.equal(row.status, 'completed'); assert.equal(row.metrics.requestCount, 3);
    const events = row.events.filter(e => e.stage === 'compatibility_retry');
    assert.equal(events[0].validationCode, 'field_missing'); assert.equal(events[0].validationField, 'reasons.character_consistency');
    assert.equal(events[0].attemptMode, 'schema');
    assert.equal(events[1].validationCode, 'field_too_short'); assert.equal(events[1].validationField, 'reasons.continuity');
    assert.equal(events[1].attemptMode, 'plain_json');
    const trace = f.m.namespace('core/audit-run-trace.js');
    assert.ok(trace.buildAuditRunReport().includes('reasons.character_consistency'));
    const run = trace.beginAuditRun({ trigger: 'test' });
    trace.traceAuditStage(run, 'compatibility_retry', { validationCode: 'secret-in-code', validationField: 'secret-in-field',
        attemptMode: 'secret-in-mode', message: 'secret-in-message', response: 'secret-in-response', apiKey: 'secret-in-key' });
    trace.finishAuditRun(run, 'completed');
    assert.ok(!trace.buildAuditRunReport().includes('secret-in-'));
    const details = f.m.namespace('core/response-validation.js');
    for (const [error, code] of [[{ code: 'STORYBOOSTER_EMPTY_STRUCTURED_OUTPUT' }, 'output_empty'],
        [{ code: 'STORYBOOSTER_INCOMPLETE_JSON' }, 'json_incomplete'], [{ code: 'STORYBOOSTER_TRUNCATED_JSON' }, 'output_truncated'],
        [{ status: 422, message: 'secret-in-message' }, 'schema_rejected']]) {
        assert.equal(details.responseValidationDetails(error).validationCode, code);
    }
    // Persisted hostile metadata is filtered again when reloading the report.
    const saved = JSON.parse(f.env.globals.sessionStorage.getItem('storybooster.audit-runs.v1'));
    saved[0].metrics.validationCode = 'secret-in-code'; saved[0].metrics.validationField = 'secret-in-field';
    saved[0].events[0].validationField = 'secret-in-field';
    const f2 = await fixture({ configure: env => env.globals.sessionStorage.setItem('storybooster.audit-runs.v1', JSON.stringify(saved)) });
    assert.ok(!f2.m.namespace('core/audit-run-trace.js').buildAuditRunReport().includes('secret-in-'));
}

// Final invalid responses retain their specific cause and existing fallback.
{
    const f = await fixture({ developerMode: true }); const invalid = f.feedback(); delete invalid.reasons.relationship;
    f.env.responses(Array(3).fill(JSON.stringify(invalid)));
    const row = await f.audit.runAutomaticAuditTest();
    assert.equal(row.status, 'completed'); assert.equal(row.metrics.feedbackFallback, true);
    const event = row.events.find(e => e.stage === 'feedback_fallback');
    assert.equal(event.attemptMode, 'repair_json');
    assert.equal(event.validationCode, 'field_missing'); assert.equal(event.validationField, 'reasons.relationship');
    assert.equal(f.state.genreAnchor.lastAudit.correctionGeneration, 'template_fallback');
}

console.log('dev.16 scoped audit cancellation, feedback validation classification, retry history and privacy regressions passed.');
