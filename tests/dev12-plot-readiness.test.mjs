import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';
const clone = value => JSON.parse(JSON.stringify(value));
const event = 'A misplaced receipt exposes a small discrepancy in the ongoing investigation.';
const positivePlot = new Set(['stagnation', 'insertion_safe', 'candidate_fit', 'user_agency']);
function deferredDiagnosisWithPlot(block = '') {
    return (id, q) => {
        if (id.startsWith('plot_') || id.startsWith('stalled_') || positivePlot.has(id) ||
            ['quiet_progress', 'existing_thread_progress', 'user_direction_blocks', 'duplicate'].includes(id)) {
            const field = id.startsWith('plot_') ? id.split('__')[0].slice(5) : id;
            if (field === block) return 'uncertain';
            return positivePlot.has(field) || id.startsWith('stalled_') ? 'yes' : 'no';
        }
        return Object.hasOwn(q.criteria, 'na') ? 'na' : 'uncertain';
    };
}
// Each selected dimension may be genuinely deferred without authorizing an
// event. Missing ratings and confirmed defects still fail the preliminary gate.
{
    const f = await fixture(); const result = await f.run('combined');
    const auto = f.m.namespace('features/automatic-plot.js'), selected = f.selection();
    const codes = f.diagnosis.getJevDimensions(selected).map(d => d.id);
    assert.equal(codes.length, 10);
    for (const code of codes) {
        for (const rating of ['attention', 'na']) {
            const deferred = clone(result); deferred.uncertain = [code]; deferred.ratings[code] = rating;
            assert.equal(auto.healthyAuditForAutomaticPlot(selected, deferred), true, `${code}: ${rating}`);
            for (const problem of ['weak', 'drifted', 'biased']) {
                const invalid = clone(deferred); invalid.ratings[code] = problem;
                assert.equal(auto.healthyAuditForAutomaticPlot(selected, invalid), false);
            }
        }
        const confirmed = clone(result); confirmed.ratings[code] = 'attention';
        assert.equal(auto.healthyAuditForAutomaticPlot(selected, confirmed), false);
        const missing = clone(result); delete missing.ratings[code];
        assert.equal(auto.healthyAuditForAutomaticPlot(selected, missing), false);
    }
    const allDeferred = clone(result); allDeferred.uncertain = codes;
    for (const code of codes) allDeferred.ratings[code] = 'attention';
    assert.equal(auto.healthyAuditForAutomaticPlot(selected, allDeferred), true);
    allDeferred.correctionCodes = ['continuity'];
    assert.equal(auto.healthyAuditForAutomaticPlot(selected, allDeferred), false);
    assert.equal(auto.healthyAuditForAutomaticPlot(selected, null), false);
}
// Actual automatic diagnosis: all ten genre/character judgments are deferred,
// but a separate plot check can establish stagnation and prepare one candidate.
// Conversely, relevant plot uncertainty prevents generation with the same audit.
for (const blockedField of ['', 'insertion_safe', 'user_direction_blocks', 'existing_thread_progress']) {
    const f = await fixture();
    const auto = f.m.namespace('features/automatic-plot.js');
    const rt = f.m.namespace('core/automatic-plot-state.js').automaticPlotRuntime;
    const runtime = f.m.namespace('core/runtime.js').runtime;
    let rpTurns = 0; f.env.context.generate = () => { rpTurns++; throw new Error('No automatic RP turn'); };
    auto.setAutomaticPlotEnabled(true);
    f.decide(deferredDiagnosisWithPlot(blockedField));
    f.env.responses([JSON.stringify(f.feedback()), JSON.stringify({ event })]);
    await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: false, scope: 'combined' });
    assert.equal(f.state.genreAnchor.lastAudit.uncertain.length, 10);
    assert.equal(f.state.genreAnchor.lastAudit.correctionCodes.length, 0);
    assert.equal(f.bodies.length, 3, 'Separate plot judgment follows deferred diagnosis');
    assert.equal(rpTurns, 0); assert.equal(runtime.plotPending, false);
    if (blockedField) {
        assert.equal(rt.pending, null); assert.equal(f.env.requests.length, 1, 'No event generation');
        assert.match(f.state.automaticPlot.lastDecision, /삽입 시점|판단/);
    } else {
        assert.ok(rt.pending); assert.equal(f.env.requests.length, 2);
        assert.ok(f.env.notices.some(n => String(n[1]).includes('랜덤박스가 준비됐어요')));
        f.env.context.chat.push({ is_user: true, mes: 'Keep the scene quiet and answer my question first.' });
        f.decide((id, q) => id === 'user_direction_blocks' || id === 'plot_user_direction_blocks__answer_due'
            ? 'yes' : deferredDiagnosisWithPlot()(id, q));
        await auto.automaticPlotGenerationInterceptor([], 2048, () => {}, 'normal');
        assert.equal(rt.pending, null); assert.equal(runtime.plotPending, false);
        assert.equal(f.state.plotHistory?.length || 0, 0);
    }
}
// Ready labels do not issue connection tests or persist a previously verified
// connection across reloads. Disable/re-enable preserves an accurate status.
{
    const f = await fixture();
    assert.equal(f.client.getJevConnectionBadge(true).text, 'Jev 사용 준비됨');
    assert.match(f.client.getJevConnectionStatus(), /사용 준비됨/);
    assert.equal(f.bodies.length, 0);
    f.client.setJevUsageConsent(false);
    assert.equal(f.client.getJevConnectionBadge(false).hidden, true);
    f.client.setJevUsageConsent(true);
    assert.match(f.client.getJevConnectionStatus(), /사용 준비됨/);
    assert.equal(f.bodies.length, 0);
}
console.log('dev.12: all deferred dimensions, confirmed-problem priority, independent plot uncertainty, latest user direction and ready-without-test status passed.');
