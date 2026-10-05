import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const normal = (id, q) => id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present';
const codes = ['primary_genre', 'genre_expression', 'support_texture', 'scene_density',
    'character_consistency', 'character_interpretation', 'char_agency', 'relationship', 'continuity', 'repetition'];
const stable = code => ['character_consistency', 'character_interpretation', 'repetition'].includes(code) ? 'stable' : 'present';

// Counterexample to dev.7: vague aggregate deferral + several uncertain or
// untested facets do not veto independently sufficient actual positive replies.
for (const code of codes) {
    for (const aggregate of ['normal', 'na', 'low-confidence']) {
        const f = await fixture();
        f.decide((id, q) => {
            if (id.startsWith(`${code}__facet_`)) {
                const keys = Object.keys(f.bodies[0].questions).filter(key => key.startsWith(`${code}__facet_`));
                return keys.indexOf(id) < 2 ? 'uncertain' : keys.indexOf(id) < 4 ? 'no_opportunity' : 'yes';
            }
            if (id === code && aggregate === 'na') return 'na';
            if (id === `${code}__1`) return 'uncertain';
            return normal(id, q);
        });
        if (aggregate === 'low-confidence') {
            const fetch = f.env.globals.fetch;
            f.env.globals.fetch = async (...args) => {
                const response = await fetch(...args), body = await response.json();
                if (body.answers[code]) body.answers[code].confidence = 0.2;
                return { ...response, json: async () => body };
            };
        }
        const r = await f.run('combined');
        assert.equal(r.ratings[code], stable(code), `${code}/${aggregate}`);
        assert.ok(!r.uncertain.includes(code));
        assert.equal(r.decisionTrace[code].route, 'clear_positive_evidence');
        assert.deepEqual(clone(r.decisionTrace[code].excludedReplies), [1]);
        assert.equal(r.correctionCodes.length, 0);
        assert.equal(f.bodies.length, 2);
        assert.ok(f.bodies[1].questions[code].criteria.context_missing);
        assert.ok(f.bodies[1].questions[code].criteria.conflict);
    }
}

// No forced health or invented repairs: all unclear/untested, explicit essential
// context missing, contradictory aggregate and unpaired evidence must defer.
for (const mode of ['all-uncertain', 'all-untested', 'essential', 'conflict', 'unpaired-facet', 'unpaired-reply']) {
    const f = await fixture();
    f.decide((id, q) => {
        if (id.startsWith('character_consistency__facet_')) {
            if (mode === 'all-uncertain') return 'uncertain';
            if (mode === 'all-untested') return 'no_opportunity';
            if (mode === 'unpaired-facet' && id.endsWith('motives')) return 'no';
        }
        if (id === 'character_consistency' && ['essential', 'conflict'].includes(mode)) return mode === 'essential' ? 'context_missing' : 'conflict';
        if (mode === 'unpaired-reply' && id === 'character_consistency__10') return 'failure';
        return normal(id, q);
    });
    const r = await f.run('character');
    assert.ok(r.uncertain.includes('character_consistency'), mode);
    assert.equal(r.correctionCodes.length, 0);
}

// Independently confirmed lapses win over aggregate na and unrelated unknowns;
// one mild lapse is attention, sustained failure/severe contradiction is drift.
for (const mode of ['mild', 'sustained', 'severe']) {
    const f = await fixture();
    f.decide((id, q) => {
        if (id === 'character_consistency__facet_motives') return 'no';
        if (id === 'character_consistency__facet_values') return 'uncertain';
        if (id === 'character_consistency') return 'na';
        if (id === 'character_consistency__10') return mode === 'severe' ? 'severe' : 'failure';
        if (id === 'character_consistency__9' && mode === 'sustained') return 'failure';
        return normal(id, q);
    });
    const r = await f.run('character');
    assert.equal(r.ratings.character_consistency, mode === 'mild' ? 'attention' : 'drifted');
    assert.ok(!r.uncertain.includes('character_consistency'));
    assert.deepEqual(clone(r.correctionCodes), ['character_consistency']);
    assert.equal(r.decisionTrace.character_consistency.aggregate, 'na');
    assert.equal(r.decisionTrace.character_consistency.route, 'confirmed_problem');
}

// Real pipeline includes each preceding user turn; after budget trimming,
// request questions and analysis metadata use the retained contiguous numbers.
{
    const f = await fixture();
    f.env.responses([JSON.stringify(f.feedback('character'))]);
    await f.audit.runGenreDriftAudit('chat_A', f.audit.getScopedAuditSelection(f.selection(), 'character'), { manual: true, scope: 'character' });
    const transcript = f.bodies[0].state.roleplay;
    for (let n = 0; n < 10; n++) assert.ok(transcript.includes(`The partner offers an option ${n}.`));
    assert.equal((transcript.match(/\[USER_CONTEXT:/g) || []).length, 10);
    const saved = f.state.genreAnchor.lastCharacterAudit;
    assert.equal(saved.analysis.reviewedResponses, 10);
    assert.deepEqual(clone(f.storage.normalizeGenreAuditRecord(saved).decisionTrace), clone(saved.decisionTrace));
    assert.equal(f.env.requests.length, 1, 'Same single feedback call');
    const feedbackPrompt = JSON.stringify(f.env.requests[0]);
    assert.match(feedbackPrompt, /decisionTrace/);
    assert.match(feedbackPrompt, /specific observed action/);
    const trace = f.m.namespace('core/jev-trace.js').normalizeJevDecisionTrace({
        ...saved.decisionTrace, apiKey: 'never-store',
        character_consistency: { ...saved.decisionTrace.character_consistency, prompt: 'private', facets: [{ verdict: 'yes', question: 'private', confidence: Infinity }] },
    });
    assert.doesNotMatch(JSON.stringify(trace), /never-store|private|question|apiKey/);
    assert.equal(trace.character_consistency.facets[0].confidence, null);
}
{
    const f = await fixture();
    f.env.context.chat.forEach(message => { message.mes += 'x'.repeat(7000); });
    f.env.responses([JSON.stringify(f.feedback('character'))]);
    await f.audit.runGenreDriftAudit('chat_A', f.audit.getScopedAuditSelection(f.selection(), 'character'), { manual: true, scope: 'character' });
    const transcript = f.bodies[0].state.roleplay;
    const numbers = [...transcript.matchAll(/\[CHAR_RESPONSE_(\d+):/g)].map(m => Number(m[1]));
    assert.ok(numbers.length < 10 && numbers.length > 0);
    assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1));
    assert.equal((transcript.match(/\[USER_CONTEXT:/g) || []).length, numbers.length);
    assert.ok(transcript.length <= 60000);
    assert.equal(f.state.genreAnchor.lastCharacterAudit.analysis.reviewedResponses, numbers.length);
    for (const code of codes.slice(4)) {
        assert.ok(f.bodies[1].questions[`${code}__${numbers.length}`]);
        assert.ok(!f.bodies[1].questions[`${code}__${numbers.length + 1}`]);
    }
}

// Repeated, scene-specific normal reactions remain in the persistent boosting
// prompt even when a later diagnosis genuinely defers additional correction.
{
    const f = await fixture();
    const before = f.audit.buildGenrePromptText(f.selection());
    f.decide((id, q) => id === 'character_consistency' ? 'context_missing' : normal(id, q));
    f.env.responses([JSON.stringify(f.feedback('character'))]);
    await f.audit.runGenreDriftAudit('chat_A', f.audit.getScopedAuditSelection(f.selection(), 'character'), { manual: true, scope: 'character' });
    assert.ok(f.state.genreAnchor.lastCharacterAudit.uncertain.includes('character_consistency'));
    assert.equal(f.state.genreAnchor.correctionRemaining, 0);
    assert.equal(f.audit.buildGenrePromptText(f.selection()), before);
    const created = [];
    f.env.globals.document.createElement = () => { const node = { dataset: {}, append: () => {} }; created.push(node); return node; };
    f.m.namespace('ui/panels.js').renderAuditDetailPanel({ replaceChildren() {}, append() {} }, f.state.genreAnchor.lastCharacterAudit,
        { code: 'character_consistency', label: 'Character' }, f.state);
    assert.ok(created.some(node => node.hidden === false && /기존 부스팅을 끄지/.test(node.textContent || '')));
}

console.log('Scene judgment: ten dimensions, partial facets, vague/weak aggregate, real missing context, conflicts, confirmed repairs, paired/bounded input, trace privacy/persistence and continued boosting passed.');
