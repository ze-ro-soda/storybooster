import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/diagnosis-fixture.mjs';
import { completeLegacyPolicyFixture } from './helpers/legacy-policy-fixture.mjs';

function payload(f, scope) {
    const p = f.diagnosis.createEmptyJevPayload(f.audit.buildGenreAuditJsonSchema(scope, 'en'));
    const normal = { primary_genre: 'present', genre_expression: 'present', support_texture: 'present', scene_density: 'present',
        character_consistency: 'stable', character_interpretation: 'stable', char_agency: 'present', relationship: 'present', continuity: 'present', repetition: 'stable' };
    for (const [code, rating] of Object.entries(normal)) if (code in p) p[code] = rating;
    for (const key of Object.keys(p)) {
        if (key.endsWith('_reason')) p[key] = 'The supplied synthetic observations consistently support the established scene and standard.';
        if (key.endsWith('_evidence') && !/failure|negative|consistency_evidence|interpretation_evidence/.test(key)) p[key] = [1, 2, 3, 4];
    }
    if ('support_texture_identifiable' in p) p.support_texture_identifiable = true;
    return completeLegacyPolicyFixture(p);
}

function useHost(f, route, answer) {
    const calls = [];
    const host = async (schema, tokens, messages) => {
        calls.push({ schema, tokens, messages });
        // Reproduce a host that fails before returning data when a native
        // output schema is supplied. The original error remains deliberately opaque.
        if (schema) throw new Error('API request failed');
        return answer;
    };
    delete f.env.context.generateRawData;
    if (route === 'rawData') f.env.context.generateRawData = opts => host(opts.jsonSchema, opts.responseLength, opts.prompt);
    if (route === 'raw') f.env.context.generateRaw = opts => host(opts.jsonSchema, opts.responseLength, opts.prompt);
    if (route === 'quiet') f.env.context.generateQuietPrompt = opts => host(opts.jsonSchema, opts.responseLength, opts.quietPrompt);
    if (route === 'profile') {
        f.settings.analysisProfileId = 'synthetic-profile';
        Object.assign(f.env.context.ConnectionManagerRequestService, {
            getSupportedProfiles: () => [{ id: 'synthetic-profile', name: 'Synthetic', api: 'fixture', model: 'synthetic-model' }],
            validateProfile: () => ({ selected: 'openai' }),
            sendRequest: (_id, messages, tokens, _options, overrides) => host(overrides.json_schema, tokens, messages),
        });
    }
    return calls;
}

test('basic diagnosis starts with validated plain JSON in every scope and host route', async () => {
    for (const route of ['rawData', 'raw', 'quiet', 'profile']) for (const scope of ['genre', 'character', 'combined']) {
        const f = await fixture(); f.settings.jevEnabled = false;
        const calls = useHost(f, route, JSON.stringify(payload(f, scope)));
        const row = await f.audit.runGenreDriftAudit('chat_A', f.audit.getScopedAuditSelection(f.selection(), scope), { manual: true, scope });
        assert.equal(row.status, 'completed', `${route}/${scope}`);
        assert.equal(row.metrics.requestCount, 1); assert.equal(row.metrics.retryCount, 0);
        assert.equal(row.metrics.attemptMode, 'plain_json'); assert.equal(row.metrics.compatibilityFallback, undefined);
        assert.equal(row.metrics.resultSaved, true); assert.equal(row.metrics.displayUpdated, true);
        assert.equal(calls.length, 1); assert.ok(!calls[0].schema); assert.equal(calls[0].tokens, 4800);
        const prompt = typeof calls[0].messages === 'string' ? calls[0].messages : calls[0].messages[0].content;
        assert.match(prompt, /OUTPUT FORMAT: Return the complete non-empty JSON object/);
        assert.match(prompt, /Each USER_CONTEXT block clarifies its following CHAR_RESPONSE/);
        assert.doesNotMatch(prompt, /COMPATIBILITY FALLBACK|One latest USER_CONTEXT/);
        assert.equal(row.events.some(e => e.stage === 'compatibility_retry'), false);
    }
});

test('basic test and message-received runs both use the first plain JSON path', async () => {
    for (const trigger of ['test', 'message_received']) {
        const f = await fixture({ developerMode: true }); f.settings.jevEnabled = false;
        const calls = useHost(f, 'rawData', JSON.stringify(payload(f, 'combined')));
        const row = trigger === 'test' ? await f.audit.runAutomaticAuditTest()
            : await f.audit.runGenreDriftAudit('chat_A', f.selection(), { trigger, manual: false, scope: 'combined' });
        assert.equal(row.status, 'completed'); assert.equal(row.trigger, trigger);
        assert.equal(row.metrics.requestCount, 1); assert.equal(calls.length, 1);
        assert.equal(row.metrics.resultSaved, true); assert.equal(row.metrics.displayUpdated, true);
    }
});

test('basic plain JSON keeps strict result checks and the three-attempt output budget', async () => {
    const f = await fixture(); f.settings.jevEnabled = false;
    f.env.responses(['{}', '{', JSON.stringify(payload(f, 'combined'))]);
    const row = await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: true, scope: 'combined' });
    assert.equal(row.status, 'completed'); assert.equal(row.metrics.requestCount, 3); assert.equal(row.metrics.retryCount, 2);
    assert.deepEqual(f.env.requests.map(args => args[0].responseLength), [4800, 4800, 4800]);
    assert.ok(f.env.requests.every(args => args[0].jsonSchema === null));
    const failures = row.events.filter(e => e.stage === 'compatibility_retry');
    assert.equal(failures[0].attemptMode, 'plain_json'); assert.equal(failures[1].attemptMode, 'plain_json');
    assert.equal(failures[0].failurePhase, 'response_validation'); assert.equal(failures[1].failurePhase, 'response_validation');
    assert.ok(failures.every(e => e.schemaRequested === false && e.requestError === 'response_invalid'));
    assert.equal(row.metrics.attemptMode, 'repair_json');
    // Invalid final output must never save a borrowed earlier result.
    const bad = await fixture(); bad.settings.jevEnabled = false;
    bad.env.responses(['{}', '{', '{}']);
    const failed = await bad.audit.runGenreDriftAudit('chat_A', bad.selection(), { manual: true, scope: 'combined' });
    assert.equal(failed.status, 'failed'); assert.equal(failed.metrics.resultSaved, false);
    assert.equal(failed.metrics.failurePhase, 'response_validation'); assert.equal(failed.metrics.schemaRequested, false);
});

test('shared default schema and Jev feedback remain unchanged', async () => {
    const f = await fixture({ developerMode: true }), requests = f.m.namespace('core/requests.js');
    f.env.responses(['{"event":"synthetic"}']);
    const result = await requests.requestStructuredJsonWithCompatibility({ prompt: 'Return an event.', transcript: 'Synthetic data.',
        jsonSchema: { name: 'synthetic', schema: { type: 'object' } }, responseLength: 1200, parseResult: JSON.parse });
    assert.equal(result.event, 'synthetic'); assert.ok(f.env.requests[0][0].jsonSchema);
    f.env.responses([JSON.stringify(f.feedback())]);
    const row = await f.audit.runAutomaticAuditTest();
    assert.equal(row.status, 'completed'); assert.equal(row.metrics.engine, 'jev');
    assert.equal(row.metrics.requestCount, 1); assert.equal(row.metrics.retryCount, 0);
    assert.equal(row.metrics.attemptMode, 'schema'); assert.ok(f.env.requests[0][0].jsonSchema);
});

test('request and parser failures are separate, controlled and retained before retry', async () => {
    const f = await fixture(), requests = f.m.namespace('core/requests.js');
    const diagnostic = f.m.namespace('core/diagnostics.js').createOperationDiagnostic({ task: 'synthetic', responseLength: 4800 });
    const failures = []; let count = 0;
    f.env.context.ConnectionManagerRequestService.sendRequest = async () => {
        if (++count === 1) throw Object.assign(new Error('API request failed: private-content'), {
            cause: Object.assign(new Error('Invalid response_schema: private-content'), { status: 400 }) });
        return '{"value":1}';
    };
    const result = await requests.requestStructuredJsonWithCompatibility({ prompt: 'Return JSON.', transcript: 'Synthetic data.',
        jsonSchema: { name: 'synthetic', schema: { type: 'object' } }, responseLength: 4800,
        connectionSnapshot: { source: 'profile', profileId: 'synthetic', apiType: 'openai' }, diagnostic,
        parseResult: JSON.parse, onFallback: event => failures.push({ ...diagnostic.requestFailure, attemptMode: event.attemptMode }) });
    assert.equal(result.value, 1); assert.equal(count, 2);
    assert.equal(failures[0].failurePhase, 'dispatch'); assert.equal(failures[0].requestMethod, 'connection_profile');
    assert.equal(failures[0].requestError, 'schema_unsupported'); assert.equal(failures[0].httpStatus, 400);
    assert.equal(failures[0].schemaRequested, true); assert.equal(failures[0].attemptMode, 'schema');
    assert.equal(diagnostic.requestFailure, null); assert.ok(!JSON.stringify(failures).includes('private-content'));
    f.settings.jevEnabled = false;
    const p = payload(f, 'combined'); p.corrections.char_agency = 'short'; p.next_corrections.char_agency = 'short';
    p.char_agency = 'attention'; p.char_agency_failure_evidence = [1];
    f.env.responses([JSON.stringify(p), JSON.stringify(payload(f, 'combined'))]);
    const row = await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: true, scope: 'combined' });
    assert.equal(row.status, 'completed');
    const event = row.events.find(e => e.stage === 'compatibility_retry');
    assert.equal(event.failurePhase, 'result_validation'); assert.equal(event.requestError, 'response_invalid');
    assert.equal(event.validationField, 'corrections.char_agency'); assert.equal(event.schemaRequested, false);
});

test('failure filters, authentication stops and restored reports never preserve provider text', async () => {
    const f = await fixture(), validation = f.m.namespace('core/response-validation.js');
    const categories = [[{ status: 401 }, 'authentication'], [{ status: 429 }, 'rate_limit'], [{ status: 503 }, 'provider_error'],
        [new Error('Failed to fetch private-content'), 'network'], [new Error('API request failed private-content'), 'host_request_failed']];
    for (const [error, expected] of categories) assert.equal(validation.requestFailureDetails(error).requestError, expected);
    assert.equal(Object.keys(validation.filterRequestFailureDetails({ failurePhase: 'private', requestError: 'private', requestMethod: 'private', httpStatus: 999, schemaRequested: 'private' })).length, 0);
    const trace = f.m.namespace('core/audit-run-trace.js'), row = trace.beginAuditRun({ trigger: 'test' });
    trace.traceAuditStage(row, 'compatibility_retry', { failurePhase: 'dispatch', requestError: 'host_request_failed',
        requestMethod: 'connection_profile', schemaRequested: false, httpStatus: 400, message: 'private-content', stack: 'private-content', response: 'private-content' });
    trace.finishAuditRun(row, 'completed');
    assert.ok(!trace.buildAuditRunReport().includes('private-content')); assert.ok(trace.buildAuditRunReport().includes('host_request_failed'));
    const saved = f.env.globals.sessionStorage.getItem('storybooster.audit-runs.v1');
    const next = await fixture({ configure: env => env.globals.sessionStorage.setItem('storybooster.audit-runs.v1', saved) });
    assert.equal(next.m.namespace('core/audit-run-trace.js').readAuditRuns()[0].events[1].requestError, 'host_request_failed');
    assert.ok(!next.m.namespace('core/audit-run-trace.js').buildAuditRunReport().includes('private-content'));
    const requests = f.m.namespace('core/requests.js'); let calls = 0;
    f.env.context.generateRawData = async () => { calls++; throw Object.assign(new Error('Unauthorized private-content'), { status: 401 }); };
    await assert.rejects(requests.requestStructuredJsonWithCompatibility({ prompt: 'JSON.', transcript: 'Synthetic.',
        initialAttemptMode: 'plain_json', responseLength: 4800, parseResult: JSON.parse }), e => e.status === 401);
    assert.equal(calls, 1);
    for (const status of [401, 403, 429, 503]) {
        calls = 0;
        f.env.context.ConnectionManagerRequestService.sendRequest = async () => { calls++;
            throw Object.assign(new Error('API request failed'), { cause: Object.assign(new Error('private-content'), { status }) }); };
        await assert.rejects(requests.requestStructuredJsonWithCompatibility({ prompt: 'JSON.', transcript: 'Synthetic.',
            connectionSnapshot: { source: 'profile', profileId: 'synthetic', apiType: 'openai' },
            initialAttemptMode: 'plain_json', responseLength: 4800, parseResult: JSON.parse }));
        assert.equal(calls, 1, `wrapped ${status} must not become a format retry`);
    }
});
