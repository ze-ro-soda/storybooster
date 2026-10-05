import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';
const clone = value => JSON.parse(JSON.stringify(value));
const normal = (id, q) => id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present';
const failure = (id, q) => id.startsWith('char_agency__facet_') ? 'no' : /^char_agency__[12]$/.test(id) ? 'failure' : id === 'char_agency' ? 'weak' : normal(id, q);

// Full diagnosis → actual one-shot application → next nonoverlapping window.
for (const repeated of [false, true]) {
    const f = await fixture(), h = f.m.namespace('core/audit-history.js');
    let sequence = 1; f.env.globals.Math.random = () => ++sequence / 100;
    const run = async targets => {
        f.env.responses([JSON.stringify(f.feedback('character', targets))]);
        const before = f.bodies.length;
        await f.audit.runGenreDriftAudit('chat_A', f.audit.getScopedAuditSelection(f.selection(), 'character'), { manual: true, scope: 'character' });
        assert.equal(f.bodies.length - before, 2); assert.equal(f.env.requests.length, 1, 'No extra comparison request');
        return f.state.genreAnchor.lastCharacterAudit;
    };
    f.decide(failure);
    const first = await run(['char_agency']);
    assert.equal(first.analysis.reviewedResponses, 10); assert.equal(first.analysis.baselineLabel, '원본');
    assert.equal(first.analysis.startMessageId, 1); assert.equal(first.analysis.endMessageId, 19);
    assert.match(h.auditAnalysisLabel(first), /10개.*원본/);
    f.storage.armPendingGenreCorrectionForNextResponse(f.state);
    f.env.context.chat.push({ is_user: true, mes: 'Continue with the selected choice.' }, { is_user: false, mes: 'A new response after correction.' });
    assert.equal(f.storage.markArmedGenreCorrectionApplied(f.state.genreAnchor, 21), true);
    const applied = clone(f.state.genreAnchor.auditHistory);
    assert.deepEqual(applied[0].appliedCodes, ['char_agency']); assert.equal(applied[0].appliedMessageId, 21);
    for (let i = 1; i < 10; i++) f.env.context.chat.push({ is_user: true, mes: `New request ${i}` }, { is_user: false, mes: `New response ${i}` });
    f.decide(repeated ? failure : normal);
    const next = await run(repeated ? ['char_agency'] : []);
    assert.equal(next.comparison.char_agency, repeated ? 'repeated' : 'clear');
    assert.match(h.auditComparisonText(next, 'char_agency'), repeated ? /다시 감지/ : /안정/);
    assert.equal(f.state.genreAnchor.auditHistory.length, 2);
    const reload = f.storage.normalizeGenreAuditRecord(clone(next));
    assert.deepEqual(clone(reload.analysis), clone(next.analysis)); assert.deepEqual(clone(reload.comparison), clone(next.comparison));
    const anchor = { auditHistory: applied };
    for (const mutate of [
        r => { r.analysis.baselineVersionId = 'different-version'; },
        r => { r.analysis.signature = 'different-standards'; },
        r => { r.analysis.characterKey = 'other-character'; },
        r => { r.engine = 'legacy'; },
        r => { r.connection.model = 'other-model'; },
        r => { r.scope = 'genre'; },
        r => { r.analysis.startMessageId = 19; },
    ]) {
        const record = clone(next); mutate(record);
        assert.deepEqual(clone(h.compareAuditHistory(anchor, record, f.env.context.chat)), {});
    }
    const edited = clone(f.env.context.chat); edited[21].mes = 'Swiped alternative';
    assert.deepEqual(clone(h.compareAuditHistory(anchor, next, edited)), {});
    const deferred = clone(next); deferred.uncertain = ['char_agency'];
    assert.equal(h.compareAuditHistory(anchor, deferred, f.env.context.chat).char_agency, 'deferred');
    const cancelled = clone(applied); cancelled[0].appliedCodes = []; cancelled[0].appliedMessageId = null;
    assert.deepEqual(clone(h.compareAuditHistory({ auditHistory: cancelled }, next, f.env.context.chat)), {});
    for (let i = 0; i < 20; i++) h.rememberAudit(f.state.genreAnchor, { ...next, id: `audit-${i}` });
    assert.equal(f.state.genreAnchor.auditHistory.length, 6);
    assert.equal(JSON.stringify(f.state.genreAnchor.auditHistory).includes('New response'), false, 'No chat text retained');
    assert.deepEqual(clone(h.normalizeAuditHistory([null, [], { analysis: {} }])), []);
    assert.deepEqual(clone(h.normalizeAuditComparison({ char_agency: 'untrusted text' })), {});
    assert.equal(h.auditAnalysisLabel({}), '', 'Old records do not invent a version or range');
}

// Each automatic-plot hold uses existing decision values, not a prose API call.
{
    const f = await fixture(), plot = f.m.namespace('features/automatic-plot.js'), status = f.m.namespace('features/plot-status.js');
    const healthy = await f.run('combined');
    const base = { stagnation: 'yes', quiet_progress: 'no', existing_thread_progress: 'no', insertion_safe: 'yes',
        user_direction_blocks: 'no', duplicate: 'no', eligible: false, stalled_replies: [8, 9, 10] };
    const cases = [ ['quiet_progress', 'yes', /일상이나 감정/], ['existing_thread_progress', 'yes', /다음 단계/],
        ['user_direction_blocks', 'yes', /유저가 제시/], ['duplicate', 'yes', /최근 사건/],
        ['insertion_safe', 'no', /적절하지/], ['stagnation', 'uncertain', /확실히 판단/], ['stagnation', 'no', /뚜렷한 전개 정체/],
        ['stagnation', 'yes', /근거가 부족/] ];
    f.state.automaticPlot.enabled = true;
    for (const [field, value, pattern] of cases) {
        const decision = { ...base, [field]: value };
        assert.match(status.plotDecisionReason(decision), pattern);
        const calls = f.bodies.length;
        await plot.prepareAutomaticPlot({ chatId: 'chat_A', selection: f.selection(), result: { ...healthy, plotDecision: decision },
            transcript: '', count: 10, isCurrent: () => true });
        assert.match(plot.getAutomaticPlotStatusText(), pattern);
        assert.equal(f.bodies.length, calls); assert.equal(f.env.requests.length, 0);
    }
    assert.match(status.plotAuditHoldReason({ correctionCodes: ['char_agency'] }), /캐릭터 보정/);
    assert.match(status.plotAuditHoldReason({ correctionCodes: ['primary_genre'] }), /장르 보정/);
    assert.match(status.plotAuditHoldReason({ uncertain: ['continuity'] }), /진단 결과를 충분히 확인하지 못해/);
    assert.match(status.plotDecisionReason(null), /근거가 부족/);
}
console.log('Usability: diagnosis/apply/comparison flow, unchanged calls, comparable windows, changed criteria/model, swipes, storage cap, metadata reload and specific automatic-plot reasons passed.');
