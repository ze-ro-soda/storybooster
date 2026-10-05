import { completeLegacyPolicyFixture } from './helpers/legacy-policy-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/diagnosis-fixture.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const normalChoice = (id, q) => id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive'
    : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present';

function legacyPayload(f, overrides = {}, scope = 'combined') {
    const schema = f.audit.buildGenreAuditJsonSchema(scope, 'en');
    const p = f.diagnosis.createEmptyJevPayload(schema);
    const normal = { primary_genre: 'present', genre_expression: 'present', support_texture: 'present', scene_density: 'present',
        character_consistency: 'stable', character_interpretation: 'stable', char_agency: 'present', relationship: 'present', continuity: 'present', repetition: 'stable' };
    for (const [key, value] of Object.entries(normal)) if (key in p) p[key] = value;
    for (const key of ['primary_genre_evidence', 'genre_expression_evidence', 'support_texture_evidence', 'scene_density_evidence',
        'character_consistency_positive_evidence', 'character_interpretation_positive_evidence', 'char_agency_evidence', 'relationship_evidence', 'continuity_evidence']) {
        if (key in p) p[key] = [1, 2, 3, 4];
    }
    for (const key of Object.keys(p)) if (key.endsWith('_reason')) p[key] = 'Observed behavior fits the synthetic scene and selected baseline.';
    if ('support_texture_identifiable' in p) p.support_texture_identifiable = true;
    for (const key of ['corrections', 'next_corrections']) p[key] = Object.fromEntries(Object.keys(schema.schema.properties[key].properties).map(id => [id, '']));
    return completeLegacyPolicyFixture(Object.assign(p, overrides));
}
const parseLegacy = (f, p) => f.audit.parseGenreAuditResult(JSON.stringify(p), true, 10, 'combined', 'en');

function setTransport(f, route) {
    f.env.context.generateQuietPrompt = f.env.context.generateRawData;
    f.env.context.generateRaw = f.env.context.generateRawData;
    if (['generateRaw', 'generateQuietPrompt'].includes(route)) delete f.env.context.generateRawData;
    if (route === 'generateQuietPrompt') delete f.env.context.generateRaw;
    return { source: route === 'profile' ? 'profile' : 'main', profileId: 'profile_A', apiType: 'openai' };
}

test('visible final JSON wins over thought drafts on every host transport; thoughts alone never succeed', async () => {
    for (const route of ['generateRawData', 'generateRaw', 'generateQuietPrompt', 'profile']) {
        for (const wrapped of [false, true]) {
            const f = await fixture(), response = f.m.namespace('core/responses.js');
            const diagnostic = f.m.namespace('core/diagnostics.js').createOperationDiagnostic({ task: 'synthetic_final_separation' });
            const draft = '{"value":"incorrect synthetic draft"}', final = '{"value":"correct synthetic final"}';
            const envelope = { candidates: [{ finishReason: 'STOP', content: { parts: [
                { thought: true, text: draft }, { text: final },
            ] } }] };
            const data = wrapped ? { response: envelope } : envelope;
            f.env.responses([data]);
            const connectionSnapshot = setTransport(f, route);
            const opts = { prompt: 'Return synthetic JSON.', transcript: 'Synthetic input.', responseLength: 4800,
                connectionSnapshot, diagnostic, recordErrors: false };
            const raw = await f.m.namespace('core/requests.js').generateStructuredAnalysis(opts);
            assert.equal(raw, final);
            assert.equal(response.extractJsonObject(data).value, 'correct synthetic final');
            assert.equal(diagnostic.responseMetadata.visibleOutputChars, final.length);
            assert.equal(diagnostic.responseMetadata.reasoningOutputChars, draft.length);
            assert.equal(diagnostic.requestCount, 1);

            envelope.candidates[0].content.parts = [{ thought: true, text: draft }];
            f.env.responses([data]);
            assert.equal(response.extractTextFromGenerationData(data), '');
            assert.throws(() => response.extractJsonObject(data, 'No visible synthetic result.'));
            await assert.rejects(f.m.namespace('core/requests.js').generateStructuredAnalysis(opts),
                error => error.code === 'STORYBOOSTER_REASONING_ONLY_OUTPUT');
            assert.equal(diagnostic.responseMetadata.visibleOutputChars, 0);
            assert.equal(diagnostic.responseMetadata.reasoningOutputChars, draft.length);
        }
    }
    const f = await fixture();
    const response = f.m.namespace('core/responses.js');
    const openai = { choices: [{ message: { content: '{"valid":true}', reasoning_content: '{"valid":false}' } }] };
    assert.equal(response.extractJsonObject(openai).valid, true);
    assert.equal(response.extractJsonObject({ reasons: { synthetic: 'Already parsed JSON.' } }).reasons.synthetic, 'Already parsed JSON.');
    const parts = { content: { parts: [{ thought: true, text: '{"event":"wrong"}' }, { text: '{"event":"correct"}' }] } };
    assert.equal(response.extractJsonObject(parts).event, 'correct');
    const diagnostic = {};
    f.m.namespace('core/response-metadata.js').captureResponseMetadata(diagnostic, parts, '', 4800);
    assert.equal(diagnostic.responseMetadata.reasoningOutputChars, '{"event":"wrong"}'.length);
    assert.equal(diagnostic.responseMetadata.visibleOutputChars, '{"event":"correct"}'.length);
});

test('full legacy audit stores the final diagnosis, and never stores a thought-only diagnosis', async () => {
    for (const finalIncluded of [true, false]) {
        const f = await fixture(); f.settings.jevEnabled = false;
        const draft = legacyPayload(f, { char_agency: 'attention', char_agency_failure_evidence: [8],
            char_agency_reason: 'Synthetic draft incorrectly assumed a missed independent choice.' });
        const final = legacyPayload(f);
        const parts = [{ thought: true, text: JSON.stringify(draft) }, ...(finalIncluded ? [{ text: JSON.stringify(final) }] : [])];
        f.env.responses([{ response: { candidates: [{ finishReason: 'STOP', content: { parts } }] } }]);
        const row = await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: true, scope: 'combined' });
        assert.equal(row.metrics.resultSaved, finalIncluded);
        assert.equal(row.status, finalIncluded ? 'completed' : 'failed');
        assert.equal(f.state.genreAnchor.correctionCodes.length, 0);
        assert.equal(row.metrics.visibleOutputChars, finalIncluded ? JSON.stringify(final).length : 0);
    }
});

test('last-field editing preserves the revision; successful edits and missing-version recovery clear related character audits only', async () => {
    const f = await fixture(), character = f.m.namespace('features/character.js');
    const identity = f.m.namespace('core/context.js').getCurrentCharacterIdentity();
    const version = f.storage.createCharacterBaselineVersion(identity, { fields: {
        core_identity: { text: 'A synthetic revision with a single non-empty field.' },
    } }, { chatId: 'chat_A' });
    const other = f.storage.ensureChatState('chat_B');
    other.characterBoost.baselineVersionId = version.id;
    const audit = { id: 'synthetic-character-audit', status: 'pending', correctionCodes: ['char_agency'] };
    other.genreAnchor.lastCharacterAudit = audit; other.genreAnchor.lastAudit = audit;
    const target = { identity, chatId: 'chat_A', versionId: version.id };
    assert.equal(character.saveCharacterBaselineField('core_identity', '', { target }), false);
    assert.equal(f.storage.getCharacterBaselineVersion(identity.key, version.id).fields.core_identity.text,
        'A synthetic revision with a single non-empty field.');
    assert.equal(other.characterBoost.baselineVersionId, version.id);
    assert.equal(other.genreAnchor.lastCharacterAudit, audit);
    assert.equal(character.saveCharacterBaselineField('core_identity', 'Replacement text in the same revision.', { target }), true);
    assert.equal(f.storage.getCharacterBaselineVersion(identity.key, version.id).fields.core_identity.text, 'Replacement text in the same revision.');
    assert.equal(other.characterBoost.baselineVersionId, version.id);
    assert.equal(other.genreAnchor.lastCharacterAudit, null);

    const genreAudit = { id: 'synthetic-genre-audit', status: 'pending', correctionCodes: ['primary_genre'] };
    other.genreAnchor.lastGenreAudit = genreAudit;
    other.genreAnchor.lastCharacterAudit = audit; other.genreAnchor.lastAudit = audit;
    other.genreAnchor.correctionCodes = ['primary_genre', 'char_agency'];
    other.genreAnchor.correctionByCode = { primary_genre: 'Keep the synthetic primary direction.', char_agency: 'Stale synthetic character repair.' };
    other.genreAnchor.correctionRemaining = 1; other.genreAnchor.responseCount = 7;
    const store = f.storage.getCharacterBaselineVersionStore(identity.key, { create: true });
    delete store.versions[version.id]; // Simulate a legacy dangling selection.
    const recovered = f.storage.getCurrentCharacterBaseline('chat_B');
    assert.equal(recovered.versionId, ''); assert.ok(recovered.baseline);
    assert.equal(other.genreAnchor.lastCharacterAudit, null);
    assert.equal(other.genreAnchor.lastAudit, null);
    assert.equal(other.genreAnchor.lastGenreAudit.id, genreAudit.id);
    assert.deepEqual(copy(other.genreAnchor.correctionCodes), ['primary_genre']);
    assert.deepEqual(copy(other.genreAnchor.correctionByCode), { primary_genre: 'Keep the synthetic primary direction.' });
    assert.equal(other.genreAnchor.correctionRemaining, 1); assert.equal(other.genreAnchor.responseCount, 7);

    const original = await fixture();
    const originalIdentity = original.m.namespace('core/context.js').getCurrentCharacterIdentity();
    original.storage.writeCharacterBaselineVersion(originalIdentity, { fields: { core_identity: { text: 'Only original field.' } } }, '');
    assert.equal(original.m.namespace('features/character.js').saveCharacterBaselineField('core_identity', '', {
        target: { identity: originalIdentity, chatId: 'chat_A', versionId: '' },
    }), false);
    assert.equal(original.storage.getCharacterBaselineVersion(originalIdentity.key, '').fields.core_identity.text, 'Only original field.');

    const deleted = await fixture();
    const id = deleted.m.namespace('core/context.js').getCurrentCharacterIdentity();
    const record = deleted.storage.createCharacterBaselineVersion(id, { fields: { core_identity: { text: 'Explicitly deletable synthetic revision.' } } }, { chatId: 'chat_A' });
    const second = deleted.storage.ensureChatState('chat_B'); second.characterBoost.baselineVersionId = record.id;
    second.genreAnchor.lastCharacterAudit = audit; second.genreAnchor.lastAudit = audit;
    deleted.env.globals.confirm = () => true;
    deleted.m.namespace('features/character.js').deleteCurrentCharacterBaselineVersion();
    assert.equal(deleted.storage.getCharacterBaselineVersion(id.key, record.id), null);
    assert.equal(second.characterBoost.baselineVersionId, ''); assert.equal(second.genreAnchor.lastCharacterAudit, null);
});

test('mild baseline repairs retain selected fields; repetition-only and deferred repairs do not acquire them', async () => {
    const f = await fixture();
    const mild = parseLegacy(f, legacyPayload(f, { char_agency: 'attention', char_agency_failure_evidence: [8], character_focus_fields: ['goals_motives'] }));
    assert.deepEqual(copy(mild.correctionCodes), ['char_agency']);
    assert.deepEqual(copy(mild.characterFocusFields), ['goals_motives']);
    const repeat = parseLegacy(f, legacyPayload(f, { repetition: 'weak', repetition_evidence: [7, 8, 9], character_focus_fields: ['goals_motives'] }));
    assert.deepEqual(copy(repeat.correctionCodes), ['repetition']); assert.equal(repeat.characterFocusFields.length, 0);
    const deferred = parseLegacy(f, legacyPayload(f, { char_agency: 'attention', char_agency_failure_evidence: [],
        deferred_dimensions: ['char_agency'], character_focus_fields: ['goals_motives'] }));
    assert.ok(deferred.uncertain.includes('char_agency')); assert.equal(deferred.characterFocusFields.length, 0);
});

function attachPlotPopup(f) {
    const ids = ['rp-event-result-wrap', 'rp-event-result', 'rp-event-status', 'rp-event-generate-btn', 'rp-plot-idea'];
    const elements = Object.fromEntries(ids.map(id => [id, { value: '', dataset: {}, hidden: false, disabled: false,
        textContent: '', focus() {}, setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } }]));
    const root = { isConnected: true, dataset: { plotMode: 'free' }, classList: { toggle() {}, add() {}, remove() {} },
        querySelector: selector => elements[selector.slice(1)] || null, querySelectorAll: () => [], closest: () => null, getClientRects: () => [] };
    f.m.runtime.activeBoosterPopupRoot = root;
    return { root, elements };
}

test('manual surprise plots never auto-apply after messages, baseline, settings or chat epoch change; unchanged paths still generate', async () => {
    const changes = {
        unchanged() {},
        new_user: f => f.env.context.chat.push({ is_user: true, mes: 'Finish this synthetic investigation and continue quietly at home.' }),
        edited_reply: f => { f.env.context.chat.at(-1).mes = 'The synthetic scene has moved to another place.'; },
        baseline: f => {
            const identity = f.m.namespace('core/context.js').getCurrentCharacterIdentity();
            f.m.namespace('features/character.js').saveCharacterBaselineField('core_identity', 'A revised synthetic motivation.', {
                target: { identity, chatId: 'chat_A', versionId: '' },
            });
        },
        profile: f => { f.settings.plotProfileId = 'another-synthetic-profile'; },
        disabled: f => { f.settings.enabledFeatures.plot = false; },
        chat_round_trip: f => {
            const state = f.m.namespace('core/automatic-plot-state.js');
            f.env.context.chatId = 'chat_B'; state.cancelAutomaticPlot('chat_changed');
            f.env.context.chatId = 'chat_A'; state.cancelAutomaticPlot('chat_changed');
        },
    };
    for (const type of ['random', 'crazy', 'secret']) {
        for (const [change, mutate] of Object.entries(changes)) {
            const f = await fixture(), popup = attachPlotPopup(f);
            const plot = f.m.namespace('features/plot.js');
            if (type === 'secret') plot.setPlotSecretMode(true);
            let resolve, generated = 0;
            f.env.context.generateRawData = () => new Promise(done => { resolve = done; });
            f.env.context.generate = async () => { generated++; };
            const pending = plot.generateEventCandidate('generate', { surpriseType: type });
            for (let n = 0; n < 20 && !resolve; n++) await new Promise(done => setImmediate(done));
            assert.ok(resolve, `${type}/${change}: request started`);
            mutate(f);
            resolve(JSON.stringify({ event: 'An overlooked receipt reveals a discrepancy in the current investigation, leaving its source to be checked.' }));
            await pending;
            assert.equal(generated, change === 'unchanged' ? 1 : 0, `${type}/${change}`);
            assert.equal(f.m.runtime.plotPending, false);
            assert.equal(f.m.namespace('core/runtime.js').eventGenerationPendingTasks.size, 0);
            assert.equal(f.env.errors.length, 0, `${type}/${change}: ordinary cancellation is not an error`);
            if (!['unchanged', 'disabled'].includes(change)) {
                assert.equal(f.state.plotHistory.length, 1);
                assert.match(popup.elements['rp-event-status'].textContent, /자동 적용하지 않았어요/);
            }
        }
    }
    // An input can also arrive during a mobile popup's close animation, after
    // prompt registration but before generate(). The owned prompt must be cleared.
    const f = await fixture(), popup = attachPlotPopup(f), plot = f.m.namespace('features/plot.js');
    let generated = 0;
    f.env.context.generate = async () => { generated++; };
    popup.root.closest = () => {
        f.env.context.chat.push({ is_user: true, mes: 'A new synthetic direction during popup close.' });
        return null;
    };
    await plot.injectEventAndGenerateReply('A synthetic receipt provides an unresolved clue.');
    assert.equal(generated, 0); assert.equal(f.m.runtime.plotPending, false); assert.equal(f.m.runtime.currentPlotInjectionText, '');
});

test('genuinely inapplicable scene dimensions allow an independent plot check without authorizing an event', async () => {
    const f = await fixture(), auto = f.m.namespace('features/automatic-plot.js');
    const result = parseLegacy(f, legacyPayload(f, { relationship: 'na', relationship_evidence: [],
        relationship_reason: 'No relationship interaction occurs in this synthetic solo scene.' }));
    assert.ok(!result.uncertain.includes('relationship'));
    assert.ok(auto.healthyAuditForAutomaticPlot(f.selection(), result));
    for (const code of ['char_agency', 'continuity']) {
        assert.ok(auto.healthyAuditForAutomaticPlot(f.selection(), { ...result, ratings: { ...result.ratings, [code]: 'na' } }));
    }
    assert.equal(auto.healthyAuditForAutomaticPlot(f.selection(), { ...result,
        ratings: { ...result.ratings, character_consistency: 'unavailable' } }), false);
    assert.equal(auto.healthyAuditForAutomaticPlot(f.selection(), { ...result,
        ratings: { ...result.ratings, char_agency: 'attention' }, uncertain: [] }), false);
    assert.equal(auto.healthyAuditForAutomaticPlot(f.selection(), { ...result, correctionCodes: ['char_agency'] }), false);
    auto.setAutomaticPlotEnabled(true);
    f.decide((id, q) => {
        if (id === 'quiet_progress' || id.startsWith('plot_quiet_progress__') || id === 'insertion_safe' || id.startsWith('plot_insertion_safe__')) return 'yes';
        if (id.startsWith('stalled_') || Object.hasOwn(q.criteria, 'yes')) return 'no';
        return normalChoice(id, q);
    });
    await auto.prepareAutomaticPlot({ chatId: 'chat_A', selection: f.selection(), result,
        transcript: 'Quiet synthetic interaction moves the relationship forward.', count: 10, isCurrent: () => true });
    assert.ok(f.bodies.length > 0, 'independent need check actually ran');
    assert.equal(f.m.namespace('core/automatic-plot-state.js').automaticPlotRuntime.pending, null);
    assert.equal(f.state.automaticPlot.status, 'deferred');
});

test('correction-map contract remains unambiguous and both engines defer unmatched repetition', async () => {
    const f = await fixture();
    for (const scope of ['genre', 'character', 'combined']) {
        const selected = f.audit.getScopedAuditSelection(f.selection(), scope);
        const prompt = f.audit.buildGenreAuditPrompt(selected, scope, 'en');
        assert.match(prompt, /every requested dimension key/);
        assert.doesNotMatch(prompt, /object keyed by selected dimension IDs/);
        const schema = f.audit.buildGenreAuditJsonSchema(scope, 'en').schema;
        for (const group of ['corrections', 'next_corrections']) {
            assert.deepEqual(copy(schema.properties[group].required), Object.keys(schema.properties[group].properties));
        }
    }
    const legacy = parseLegacy(f, legacyPayload(f, { repetition: 'attention', repetition_evidence: [1] }));
    f.decide((id, q) => id === 'repetition__facet_wording' ? 'no' : id === 'repetition__1' ? 'failure' : normalChoice(id, q));
    const jev = await f.run('character');
    assert.ok(legacy.uncertain.includes('repetition')); assert.ok(jev.uncertain.includes('repetition'));
    const context = f.m.namespace('core/context.js');
    const input = context.getRoleplayTranscript({ assistantRepliesWithUserContext: 10, latestUserContextOnly: true,
        numberAssistantReplies: true, perMessageMaxChars: 6500, maxChars: 60000, chatSnapshot: f.env.context.chat });
    assert.equal((input.match(/\[USER_CONTEXT:/g) || []).length, 1);
    const paired = f.m.namespace('features/audit-context.js').buildJevAuditTranscript(f.env.context.chat).transcript;
    assert.equal((paired.match(/\[USER_CONTEXT:/g) || []).length, 10);
});
