import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';
import { environment, loadModules } from './vm-harness.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const gate = () => {
    let release, start;
    const wait = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { start = resolve; });
    return { wait, entered, release, start };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(trace) {
    for (let n = 0; n < 100; n++) {
        const latest = trace.readAuditRuns()[0];
        if (latest && latest.status !== 'running') return latest;
        await tick();
    }
    assert.fail('Automatic event did not terminate');
}

// Actual MESSAGE_RECEIVED scheduling reaches diagnosis, history and display;
// the hidden test command uses the same automatic scope without synthetic RP.
{
    const commands = new Map();
    const f = await fixture({ configure: env => {
        env.context.SlashCommand = { fromProps: props => props };
        env.context.SlashCommandParser = { addCommandObject: props => commands.set(props.name, props) };
    } });
    const trace = f.m.namespace('core/audit-run-trace.js');
    assert.ok(commands.has('sb-debug'));
    assert.ok(!commands.has('sb-auto-test'));
    const mode = f.m.namespace('core/debug-mode.js');
    assert.equal(mode.unlockDeveloperMode('wrong-password'), false);
    assert.ok(!commands.has('sb-auto-test'));
    assert.equal(mode.unlockDeveloperMode('sb-debug'), true);
    assert.ok(commands.has('sb-auto-test'));
    f.settings.auditInterval = 1;
    f.env.responses([JSON.stringify(f.feedback())]);
    f.env.context.chat.push({ is_user: true, mes: 'Consider this option.' }, { is_user: false, mes: 'I choose a careful next step.' });
    f.env.listeners.get('MESSAGE_RECEIVED')[0](f.env.context.chat.length - 1);
    const received = await settle(trace);
    assert.equal(received.trigger, 'message_received');
    assert.equal(received.manual, false);
    assert.equal(received.status, 'completed');
    assert.equal(received.metrics.resultSaved, true);
    assert.equal(received.metrics.displayUpdated, true);
    assert.equal(received.metrics.requestCount, 1);
    for (const phase of ['jev_facets_request', 'jev_facets_received', 'jev_evidence_request', 'jev_evidence_received',
        'jev_reduced', 'feedback_request', 'feedback_received', 'saved', 'displayed']) assert.ok(received.events.some(e => e.stage === phase), phase);
    assert.equal(f.state.genreAnchor.lastAudit.mode, 'auto');
    assert.equal(f.state.genreAnchor.auditHistory.length, 1);
    const before = copy(f.env.context.chat), counter = f.state.genreAnchor.responseCount;
    const nextTime = f.env.globals.Date.now() + 1000;
    f.env.globals.Date.now = () => nextTime;
    f.env.responses([JSON.stringify(f.feedback())]);
    assert.equal(await commands.get('sb-auto-test').callback(), '');
    const test = trace.readAuditRuns()[0];
    assert.equal(test.status, 'completed');
    assert.equal(test.trigger, 'test');
    assert.equal(test.scope, received.scope);
    assert.equal(test.manual, false);
    assert.deepEqual(copy(f.env.context.chat), before);
    assert.equal(f.state.genreAnchor.responseCount, counter);
    assert.equal(f.state.genreAnchor.auditHistory.length, 2);
    assert.equal(f.bodies.length, 4);
    assert.equal(f.env.requests.length, 1);
    f.settings.auditInterval = 0;
    assert.equal(await f.audit.runAutomaticAuditTest(), null);
    assert.equal(trace.readAuditRuns().length, 2);
    assert.equal(f.bodies.length, 4);
}

// Previously silent exits now preserve the last good result, explain the
// exact guard, release the pending flag and allow a later automatic run.
for (const reason of ['messages_changed', 'chat_changed', 'key_changed', 'generation_stopped', 'selection_changed', 'correction_changed', 'automatic_disabled']) {
    const f = await fixture({ developerMode: true });
    const trace = f.m.namespace('core/audit-run-trace.js');
    f.env.responses([JSON.stringify(f.feedback())]);
    await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: true, scope: 'combined' });
    const previous = f.state.genreAnchor.lastAudit;
    const g = gate();
    f.env.context.generateRawData = async () => { g.start(); await g.wait; return JSON.stringify(f.feedback()); };
    const task = f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: false, scope: 'combined', trigger: 'test' });
    await g.entered;
    if (reason === 'messages_changed') f.env.context.chat.at(-1).mes += ' Translated or edited text.';
    if (reason === 'chat_changed') f.env.context.chatId = 'chat_B';
    if (reason === 'key_changed') f.client.setJevSessionKey('replacement-synthetic-key');
    if (reason === 'generation_stopped') f.m.namespace('core/automatic-plot-state.js').cancelAutomaticPlot('generation_stopped');
    if (reason === 'selection_changed') f.state.genreSelection.primaryId = 'fantasy';
    if (reason === 'correction_changed') f.state.genreAnchor.correctionRevision++;
    if (reason === 'automatic_disabled') f.settings.auditInterval = 0;
    g.release();
    const result = await task;
    assert.equal(result.status, 'cancelled', reason);
    assert.equal(result.reason, reason);
    assert.equal(result.metrics.resultSaved, false);
    assert.equal(f.state.genreAnchor.auditHistory.length, 1);
    if (!['correction_changed', 'automatic_disabled'].includes(reason)) assert.equal(f.state.genreAnchor.lastAudit, previous);
    if (reason === 'messages_changed') {
        assert.equal(result.metrics.changedMessages, 1);
        assert.equal(result.metrics.firstChangedIndex, f.env.context.chat.length - 1);
        assert.ok(f.env.notices.some(n => String(n[1]).includes('적용이 취소')));
    }
    if (reason === 'generation_stopped') assert.equal(result.metrics.epochCause, 'generation_stopped');
    assert.equal(f.m.namespace('core/runtime.js').genreAuditPendingChats.has('chat_A'), false);
    // Reset the changed environment. Normal follow-up execution must recover.
    f.env.context.chatId = 'chat_A'; f.settings.auditInterval = 5;
    const recovered = await f.audit.runAutomaticAuditTest();
    assert.equal(recovered.status, 'completed', reason);
}

// Low-confidence valid answers must save a deferred diagnosis, not abort it.
{
    const f = await fixture({ developerMode: true }); const original = f.env.globals.fetch;
    f.env.globals.fetch = async (...args) => {
        const response = await original(...args), data = await response.json();
        for (const [id, a] of Object.entries(data.answers)) if (/^repetition__\d+$/.test(id)) {
            a.choice = 'positive'; a.confidence = .24;
            a.probabilities = { positive: .39, failure: .02, uncertain: .02, none: .30, justified: .27 };
        }
        return { ok: true, json: async () => data };
    };
    f.env.responses([JSON.stringify(f.feedback())]);
    const result = await f.audit.runAutomaticAuditTest();
    assert.equal(result.status, 'completed');
    assert.equal(result.metrics.resultSaved, true);
    assert.equal(f.state.genreAnchor.lastAudit.status, 'deferred');
    assert.ok(f.state.genreAnchor.lastAudit.uncertain.includes('repetition'));
}

// Compatibility retries are visible, and a feedback timeout still records
// the Jev assessment using the established template fallback.
for (const mode of ['retry', 'timeout']) {
    const f = await fixture({ developerMode: true });
    if (mode === 'retry') f.env.responses(['', '', JSON.stringify(f.feedback())]);
    else f.env.context.generateRawData = async () => { throw Object.assign(new Error('synthetic timeout'), { code: 'STORYBOOSTER_REQUEST_TIMEOUT' }); };
    const row = await f.audit.runAutomaticAuditTest();
    assert.equal(row.status, 'completed');
    assert.equal(row.metrics.resultSaved, true);
    if (mode === 'retry') {
        assert.equal(row.metrics.retryCount, 2);
        assert.equal(row.metrics.requestCount, 3);
        assert.equal(row.events.filter(e => e.stage === 'compatibility_retry').length, 2);
    } else {
        assert.equal(row.metrics.feedbackFallback, true);
        assert.ok(row.events.some(e => e.stage === 'feedback_fallback' && e.errorKind === 'timeout'));
        assert.equal(f.state.genreAnchor.lastAudit.correctionGeneration, 'template_fallback');
    }
}

// Jev timeout followed by legacy failure records both the switch and terminal
// failure; no phantom diagnosis is marked saved.
{
    const f = await fixture({ developerMode: true });
    f.env.globals.fetch = async () => { throw Object.assign(new Error('synthetic Jev timeout'), { code: 'STORYBOOSTER_JEV_TIMEOUT' }); };
    f.env.context.generateRawData = async () => { throw Object.assign(new Error('synthetic request timeout'), { code: 'STORYBOOSTER_REQUEST_TIMEOUT' }); };
    const row = await f.audit.runAutomaticAuditTest();
    assert.equal(row.status, 'failed'); assert.equal(row.reason, 'request_timeout');
    assert.ok(row.events.some(e => e.stage === 'jev_fallback' && e.errorKind === 'timeout'));
    assert.equal(row.metrics.resultSaved, false);
    assert.equal(row.stage, 'legacy_request');
    assert.equal(f.m.namespace('core/runtime.js').genreAuditPendingChats.size, 0);
}

// Busy admission is explicit and cannot start a duplicate request or erase
// the live record when terminal logs are cleared.
{
    const f = await fixture({ developerMode: true }), trace = f.m.namespace('core/audit-run-trace.js'), g = gate();
    f.env.context.generateRawData = async () => { g.start(); await g.wait; return JSON.stringify(f.feedback()); };
    const running = f.audit.runAutomaticAuditTest(); await g.entered;
    const busy = await f.audit.runAutomaticAuditTest();
    assert.equal(busy.status, 'skipped'); assert.equal(busy.reason, 'busy');
    assert.equal(f.bodies.length, 2);
    trace.clearAuditRuns();
    assert.equal(trace.readAuditRuns().length, 1); assert.equal(trace.readAuditRuns()[0].status, 'running');
    g.release(); assert.equal((await running).status, 'completed');
}

// A post-save UI failure keeps the committed diagnosis and records its phase.
{
    const f = await fixture({ developerMode: true }); f.env.responses([JSON.stringify(f.feedback())]);
    const originalPush = f.env.prompts.push;
    f.env.prompts.push = () => { throw new Error('Synthetic UI/injection failure'); };
    const row = await f.audit.runAutomaticAuditTest();
    assert.equal(row.status, 'failed'); assert.equal(row.reason, 'post_save_failed');
    assert.equal(row.metrics.resultSaved, true); assert.equal(row.stage, 'displaying');
    assert.equal(f.state.genreAnchor.lastAudit.status, 'stable');
    assert.equal(f.state.genreAnchor.auditHistory.length, 1);
    f.env.prompts.push = originalPush;
}

// A late legacy error after new input is cancellation, not a replacement error result.
{
    const f = await fixture({ developerMode: true }), g = gate(); f.settings.jevEnabled = false;
    f.env.context.generateRawData = async () => { g.start(); await g.wait; throw Object.assign(new Error('late timeout'), { code: 'STORYBOOSTER_REQUEST_TIMEOUT' }); };
    const task = f.audit.runAutomaticAuditTest(); await g.entered;
    f.env.context.chat.push({ is_user: true, mes: 'A new direction.' }); g.release();
    const row = await task;
    assert.equal(row.status, 'cancelled'); assert.equal(row.reason, 'messages_changed');
    assert.equal(row.metrics.appendedUserMessages, 1);
    assert.equal(f.state.genreAnchor.lastAudit, null);
}

// The mobile-friendly log tool updates, copies and clears the same report;
// a live run remains available after clearing completed history.
{
    const f = await fixture({ developerMode: true }), trace = f.m.namespace('core/audit-run-trace.js'), tools = f.m.namespace('ui/tools.js');
    const actions = new Map(), textarea = { value: '' }, status = { textContent: '' };
    let popupId = '', html = '', copied = '';
    const root = { querySelector: selector => ({ addEventListener: (_event, callback) => actions.set(selector, callback) }) };
    f.env.globals.document.getElementById = id => id === 'rp-audit-run-status' ? status : id === popupId ? root : null;
    f.env.globals.document.querySelectorAll = selector => selector === '[data-rp-audit-run-report]' ? [textarea] : [];
    f.env.globals.navigator = { clipboard: { writeText: async text => { copied = text; } } };
    f.env.context.POPUP_TYPE = { TEXT: 1 };
    f.env.context.callGenericPopup = value => { html = value; popupId = value.match(/id="([^"]+)"/)[1]; };
    const run = trace.beginAuditRun({ trigger: 'test' });
    tools.openAuditRunTraceLog();
    assert.ok(html.includes('진단 진행 기록'));
    trace.traceAuditStage(run, 'jev_evidence_request', { questionCount: 100, timeoutMs: 25000 });
    assert.ok(textarea.value.includes('Jev 항목·답변 근거 요청')); assert.ok(status.textContent.includes('진행 중'));
    await actions.get('.rp-audit-run-copy')();
    assert.equal(copied, trace.buildAuditRunReport());
    actions.get('.rp-audit-run-clear')(); assert.equal(trace.readAuditRuns().length, 1);
    trace.finishAuditRun(run, 'completed'); actions.get('.rp-audit-run-clear')();
    assert.equal(trace.readAuditRuns().length, 0); assert.ok(textarea.value.includes('아직 진단 실행 기록'));
}

// Strict export allowlists, bounded retention, blocked session storage and
// refresh interruption survive without persisting keys, names or RP strings.
{
    const env = environment(); let clock = env.globals.Date.now();
    env.globals.Date.now = () => clock;
    const m = await loadModules(env), trace = m.namespace('core/audit-run-trace.js');
    const secret = 'arbitrary-secret-without-recognizable-prefix';
    const run = trace.beginAuditRun({ trigger: 'test' });
    clock += 1200;
    trace.traceAuditStage(run, 'feedback_request', { transcript: secret, apiKey: secret, model: secret, chatId: secret,
        promptChars: 120, errorKind: secret, contextChanges: ['messages_changed', secret] });
    clock += 300;
    trace.finishAuditRun(run, 'cancelled', 'messages_changed');
    const report = trace.buildAuditRunReport();
    const measured = trace.readAuditRuns()[0];
    assert.equal(measured.startedAt, clock - 1500);
    assert.equal(measured.endedAt - measured.startedAt, 1500);
    assert.equal(measured.events.find(e => e.stage === 'feedback_request').elapsedMs, 1200);
    assert.match(trace.auditRunStatusText(measured), / · 1\.5초 · /);
    assert.ok(!report.includes(secret));
    assert.ok(!JSON.stringify(trace.readAuditRuns()).includes(secret));
    for (let n = 0; n < 30; n++) trace.finishAuditRun(trace.beginAuditRun(), 'completed');
    assert.equal(trace.readAuditRuns().length, 12);
    const longRun = trace.beginAuditRun();
    for (let n = 0; n < 100; n++) trace.traceAuditStage(longRun, 'feedback_request');
    assert.equal(trace.readAuditRuns().find(r => r.id === longRun.id).events.length, 60);
    assert.equal(trace.readAuditRuns().length, 12);
    // A fresh module instance must not misreport stale running entries as live.
    const saved = env.globals.sessionStorage.getItem('storybooster.audit-runs.v1');
    const reload = environment(); reload.globals.sessionStorage.setItem('storybooster.audit-runs.v1', saved);
    const fresh = await loadModules(reload), restored = fresh.namespace('core/audit-run-trace.js').readAuditRuns();
    assert.ok(restored.every(r => r.status !== 'running'));
    assert.ok(restored.some(r => r.reason === 'page_reloaded'));
    const unavailable = environment();
    unavailable.globals.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const mem = await loadModules(unavailable), memoryTrace = mem.namespace('core/audit-run-trace.js');
    memoryTrace.finishAuditRun(memoryTrace.beginAuditRun(), 'completed');
    assert.equal(memoryTrace.readAuditRuns()[0].status, 'completed');
}

console.log('Audit trace: real automatic event/command, unchanged RP/counters, guarded exits, retries/timeouts, saved-result protection, busy recovery, privacy, reload and unavailable storage passed.');
