import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const parse = raw => JSON.parse(raw);

// Every existing transport preserves provider metadata when supplied, without
// changing extraction options, retry count, budgets or the validated result.
for (const route of ['generateRawData', 'generateRaw', 'generateQuietPrompt', 'profile']) {
    const f = await fixture();
    f.env.context.generateQuietPrompt = f.env.context.generateRawData;
    f.env.context.generateRaw = f.env.context.generateRawData;
    if (route === 'generateRaw' || route === 'generateQuietPrompt') delete f.env.context.generateRawData;
    if (route === 'generateQuietPrompt') delete f.env.context.generateRaw;
    const diagnostic = f.m.namespace('core/diagnostics.js').createOperationDiagnostic({ task: 'synthetic_metadata' });
    const failures = [];
    f.env.responses([
        { choices: [{ finish_reason: 'stop', message: { content: '' } }], usage: { completion_tokens: 90 } },
        { response: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [
            { thought: true, text: 'Synthetic private reasoning.' }, { text: '{"reasons":' },
        ] } }], usageMetadata: { candidatesTokenCount: 5, thoughtsTokenCount: 100 } } },
        '{"reasons":{"synthetic":"A valid complete explanation."}}',
    ]);
    const result = await f.m.namespace('core/requests.js').requestStructuredJsonWithCompatibility({
        prompt: 'Return synthetic JSON.', transcript: 'Synthetic transcript.', responseLength: 1200,
        jsonSchema: { name: 'synthetic', schema: { type: 'object' } }, diagnostic,
        connectionSnapshot: { source: route === 'profile' ? 'profile' : 'main', profileId: 'profile_A', apiType: 'openai' },
        parseResult: parse, onFallback: () => failures.push(copy(diagnostic.responseMetadata)),
    });
    assert.equal(result.reasons.synthetic, 'A valid complete explanation.');
    assert.equal(diagnostic.requestCount, 3); assert.equal(diagnostic.retryCount, 2);
    assert.equal(diagnostic.method, route === 'profile' ? 'connection_profile' : route);
    assert.equal(failures[0].responseFinish, 'stop'); assert.equal(failures[0].visibleOutputChars, 0);
    assert.equal(failures[0].providerOutputTokens, 90);
    assert.equal(failures[1].responseFinish, 'length');
    assert.equal(failures[1].reasoningOutputChars, 'Synthetic private reasoning.'.length);
    assert.equal(failures[1].visibleOutputChars, '{"reasons":'.length);
    assert.equal(failures[1].providerReasoningTokens, 100);
    assert.equal(diagnostic.responseMetadata.requestedOutputTokens, 4800);
    assert.equal(diagnostic.responseMetadata.responseFinish, 'unavailable');
    assert.equal(diagnostic.responseMetadata.responseEnvelope, 'text');
    assert.equal(diagnostic.responseMetadata.providerReasoningTokens, undefined);
    if (route === 'profile') {
        assert.deepEqual(f.env.requests.map(args => args[2]), [1200, 1200, 4800]);
        assert.equal(f.env.requests[0][3].extractData, true);
    } else assert.deepEqual(f.env.requests.map(args => args[0].responseLength), [1200, 1200, 4800]);
}

// Actual audit callbacks preserve each attempt's metadata in exported and
// reloaded reports; unknown provider strings and payloads never enter them.
{
    const f = await fixture({ developerMode: true });
    f.env.responses([
        { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
        { choices: [{ finish_reason: 'STOP', message: { content: '{"reasons":' } }] },
        JSON.stringify(f.feedback()),
    ]);
    const row = await f.audit.runAutomaticAuditTest();
    assert.equal(row.status, 'completed'); assert.equal(row.metrics.resultSaved, true);
    const retries = row.events.filter(e => e.stage === 'compatibility_retry');
    assert.equal(retries[0].validationCode, 'output_empty'); assert.equal(retries[0].responseFinish, 'stop');
    assert.equal(retries[1].validationCode, 'json_incomplete'); assert.equal(retries[1].responseFinish, 'stop');
    const success = row.events.find(e => e.stage === 'feedback_received');
    assert.equal(success.requestedOutputTokens, 4800); assert.equal(success.responseFinish, 'unavailable');
    const meta = f.m.namespace('core/response-metadata.js');
    const diagnostic = {};
    meta.captureResponseMetadata(diagnostic, { finishReason: 'private-finish-value' }, '{}', 1200);
    assert.equal(diagnostic.responseMetadata.responseFinish, 'other');
    const trace = f.m.namespace('core/audit-run-trace.js'), run = trace.beginAuditRun({ trigger: 'test' });
    trace.traceAuditStage(run, 'feedback_received', { responseFinish: 'private-finish-value', responseEnvelope: 'private-envelope',
        providerReasoningTokens: 'private-token-value', visibleOutputChars: -5, rawResponse: 'private-response' });
    trace.finishAuditRun(run, 'completed');
    assert.ok(!trace.buildAuditRunReport().includes('private-'));
    const saved = JSON.parse(f.env.globals.sessionStorage.getItem('storybooster.audit-runs.v1'));
    saved[0].metrics.responseFinish = 'private-finish-value'; saved[0].events[0].responseEnvelope = 'private-envelope';
    const reloaded = await fixture({ configure: env => env.globals.sessionStorage.setItem('storybooster.audit-runs.v1', JSON.stringify(saved)) });
    assert.ok(!reloaded.m.namespace('core/audit-run-trace.js').buildAuditRunReport().includes('private-'));
    assert.equal(meta.filterResponseMetadata({ providerOutputTokens: Infinity }).providerOutputTokens, undefined);
    assert.equal(meta.pendingResponseMetadata(1200).visibleOutputChars, undefined);
    meta.captureResponseMetadata(diagnostic, { reasoning: 'Synthetic private reasoning.' }, 'Synthetic private reasoning.', 1200);
    assert.equal(diagnostic.responseMetadata.visibleOutputChars, 0);
    assert.equal(diagnostic.responseMetadata.reasoningOutputChars, 'Synthetic private reasoning.'.length);
    // A transport failure on a later request cannot reuse the previous
    // provider STOP or usage counters as if this attempt returned a response.
    f.env.context.generateRawData = async () => { throw new Error('Synthetic transport failure.'); };
    await assert.rejects(f.m.namespace('core/requests.js').generateStructuredAnalysis({
        prompt: 'Synthetic.', transcript: 'Synthetic.', responseLength: 1200, diagnostic,
        connectionSnapshot: { source: 'main' }, recordErrors: false,
    }));
    assert.equal(diagnostic.responseMetadata.responseEnvelope, 'pending');
    assert.equal(diagnostic.responseMetadata.responseFinish, 'unavailable');
    assert.equal(diagnostic.responseMetadata.reasoningOutputChars, undefined);
}

// Compact feedback retains actual facet questions/IDs/verdicts, exclusions,
// decision routes and evidence, without rescoring or changing output contracts.
{
    const f = await fixture();
    f.decide((id, q) => id.startsWith('char_agency__facet_') ? 'no'
        : id.startsWith('char_agency__') ? 'failure' : id.includes('__facet_') ? 'yes'
        : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present');
    const result = await f.run('character'), before = copy(result);
    assert.ok(result.correctionCodes.includes('char_agency'));
    const context = copy(f.diagnosis.buildJevFeedbackContext(result));
    assert.deepEqual(context.ratings, before.ratings); assert.deepEqual(context.evidence, before.evidence);
    assert.deepEqual(context.uncertain, before.uncertain); assert.deepEqual(context.excludedReplies, before.excludedReplies);
    for (const [code, observations] of Object.entries(before.observations)) {
        assert.deepEqual(context.observations[code], observations.map(({ id, question, verdict }) => ({ id, question, verdict })));
        for (const key of ['route', 'positiveReplies', 'failedReplies']) assert.deepEqual(context.decisionTrace[code][key], before.decisionTrace[code][key]);
    }
    const full = { ratings: before.ratings, evidence: before.evidence, uncertain: before.uncertain,
        observations: before.observations, excludedReplies: before.excludedReplies, decisionTrace: before.decisionTrace };
    assert.ok(JSON.stringify(context).length < JSON.stringify(full).length);
    assert.ok(!JSON.stringify(context).includes('probability')); assert.ok(!JSON.stringify(context).includes('confidence'));
    let options;
    await f.diagnosis.writeJevFeedback(result, f.audit.getScopedAuditSelection(f.selection(), 'character'), 'Synthetic transcript.', async opts => {
        options = opts; return opts.parseResult(JSON.stringify(f.feedback('character', result.correctionCodes)));
    }, 'en');
    assert.equal(options.responseLength, 4800); assert.equal(options.repairResponseLength, 4800); assert.equal(options.transcript, 'Synthetic transcript.');
    assert.deepEqual(copy(result), before);
    assert.match(options.prompt, /Never cite those excluded observations/);
    assert.ok(options.prompt.includes(JSON.stringify(context)));
}

console.log('dev.17 provider/text metadata, per-attempt reset and privacy, all transports, fixed budgets and grounded compact feedback passed.');
