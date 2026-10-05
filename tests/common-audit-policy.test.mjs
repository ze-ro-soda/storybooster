import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/diagnosis-fixture.mjs';
import { AUDIT_PROBLEM_IMPACT, hasSufficientCharacterFacets, reduceRepetitionEvidence, validateAuditCorrection } from '../core/audit-policy.js';

const clone = value => JSON.parse(JSON.stringify(value));
const normal = (id, q) => /^repetition__(match|pattern)_/.test(id) ? 'none' : id.includes('__facet_') ? 'yes'
    : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present';
const negative = { primary_genre: 'primary_genre_failure_evidence', genre_expression: 'genre_expression_failure_evidence',
    support_texture: 'support_texture_opportunity', scene_density: 'scene_density_failure_evidence', character_consistency: 'character_consistency_evidence',
    character_interpretation: 'character_interpretation_evidence', char_agency: 'char_agency_failure_evidence', relationship: 'relationship_failure_evidence',
    continuity: 'continuity_failure_evidence', repetition: 'repetition_evidence' };

function payload(f, scope = 'combined') {
    const schema = f.audit.buildGenreAuditJsonSchema(scope, 'en'), p = f.diagnosis.createEmptyJevPayload(schema);
    for (const code of Object.keys(AUDIT_PROBLEM_IMPACT).filter(code => code in p)) {
        p[code] = ['character_consistency', 'character_interpretation', 'repetition'].includes(code) ? 'stable' : 'present';
        p.problem_facets[code] = []; p.corrections[code] = ''; p.next_corrections[code] = '';
        p[`${code}_reason`] = 'The synthetic response fits the supplied scene and applicable standard.';
    }
    for (const key of ['primary_genre_evidence', 'genre_expression_evidence', 'support_texture_evidence', 'scene_density_evidence',
        'character_consistency_positive_evidence', 'character_interpretation_positive_evidence', 'char_agency_evidence', 'relationship_evidence', 'continuity_evidence']) {
        if (key in p) p[key] = [1, 2, 3, 4];
    }
    for (const code of ['character_consistency', 'character_interpretation']) {
        if (code in p) p[`${code}_facets`] = Object.fromEntries(Object.keys(AUDIT_PROBLEM_IMPACT[code]).map(id => [id, 'yes']));
    }
    if ('support_texture_identifiable' in p) p.support_texture_identifiable = true;
    return p;
}
const parse = (f, p, fallback = false, count = 10) => f.audit.parseGenreAuditResult(p, true, count, 'combined', 'en', true, fallback);
function markProblem(f, p, code, facet, replies = [8], rating = 'attention') {
    p[code] = rating; p[negative[code]] = replies; p.problem_facets[code] = [facet];
    const text = f.feedback('combined', [code]); p.corrections[code] = text.corrections[code]; p.next_corrections[code] = text.next_corrections[code];
}

test('both engines and Jev recovery use the same paired, bounded, renumbered audit input in every scope', async () => {
    for (const scope of ['genre', 'character', 'combined']) {
        const expected = [], requested = [];
        for (const engine of ['legacy', 'jev', 'recovery']) {
            const f = await fixture(); f.settings.jevEnabled = engine !== 'legacy';
            const input = f.m.namespace('features/audit-context.js').buildAuditTranscript(f.env.context.chat);
            assert.equal(input.reviewedResponses, 10); assert.equal((input.transcript.match(/\[USER_CONTEXT:/g) || []).length, 10);
            expected.push(input.transcript);
            if (engine === 'recovery') f.env.globals.fetch = async () => { throw Object.assign(new Error('Synthetic unavailable provider.'), { code: 'STORYBOOSTER_JEV_TIMEOUT' }); };
            f.env.responses([JSON.stringify(engine === 'jev' ? f.feedback(scope) : payload(f, scope))]);
            const selected = f.audit.getScopedAuditSelection(f.selection(), scope);
            const row = await f.audit.runGenreDriftAudit('chat_A', selected, { manual: true, scope });
            assert.equal(row.status, 'completed'); assert.equal(row.metrics.reviewedResponses, 10);
            const userInput = f.env.requests[0][0].prompt.find(message => message.role === 'user').content;
            assert.equal(userInput, input.transcript); requested.push(userInput);
            if (engine === 'jev') { assert.equal(f.bodies[0].state.roleplay, userInput); assert.equal(f.bodies.length, 2); }
            assert.equal(f.env.requests.length, 1);
        }
        assert.equal(new Set(expected).size, 1); assert.equal(new Set(requested).size, 1);
    }
    const f = await fixture(), builder = f.m.namespace('features/audit-context.js');
    const messages = Array.from({ length: 10 }, (_, i) => [{ is_user: true, mes: `Synthetic request ${i}: ${'u'.repeat(6200)}` },
        { is_user: false, mes: `Synthetic answer ${i}: ${'a'.repeat(6200)}` }]).flat();
    const bounded = builder.buildAuditTranscript(messages);
    assert.ok(bounded.transcript.length <= 60000); assert.ok(bounded.reviewedResponses > 0 && bounded.reviewedResponses < 10);
    assert.equal((bounded.transcript.match(/\[USER_CONTEXT:/g) || []).length, bounded.reviewedResponses);
    assert.equal((bounded.transcript.match(/\[CHAR_RESPONSE_\d+:/g) || []).length, bounded.reviewedResponses);
    assert.match(bounded.transcript, /\[CHAR_RESPONSE_1:/); assert.match(bounded.transcript, /Synthetic request 9:/);
    assert.equal(builder.buildJevAuditTranscript(messages).transcript, bounded.transcript);
    assert.equal(builder.buildAuditTranscript(messages, 20).reviewedResponses, 0);
});

test('repetition needs a supported comparator, and only the same repeated facet escalates in both engines', async () => {
    const cases = [
        { label: 'one', failures: [2], pairs: [], hold: true },
        { label: 'unmatched', failures: [2, 3, 4], pairs: [], hold: true },
        { label: 'pair', failures: [2, 3], pairs: [[2, 3, 'pattern', 'wording']], rating: 'attention' },
        { label: 'sustained', failures: [2, 3, 4], pairs: [[2, 3, 'pattern', 'wording'], [3, 4, 'pattern', 'wording']], rating: 'weak' },
        { label: 'exact', failures: [2, 3], pairs: [[2, 3, 'near_verbatim', 'wording']], rating: 'weak' },
        { label: 'different facets', failures: [2, 3, 4, 5], pairs: [[2, 3, 'pattern', 'wording'], [4, 5, 'pattern', 'structure']], rating: 'attention' },
        { label: 'unproven counterpart', failures: [2], pairs: [[2, 3, 'near_verbatim', 'wording']], hold: true },
    ];
    for (const c of cases) {
        const f = await fixture(), p = payload(f);
        markProblem(f, p, 'repetition', 'wording', c.failures, 'weak');
        p.repetition_matches = c.pairs.map(([left, right, kind, facet]) => ({ left, right, kind, facet }));
        p.repetition_exact = c.pairs.some(pair => pair[2] === 'near_verbatim');
        const basic = parse(f, p);
        const patterns = new Map(c.pairs.flatMap(([left, right, _kind, facet]) => [[left, facet], [right, facet]]));
        f.decide((id, q) => {
            if (id.startsWith('repetition__facet_')) return ['wording', 'structure'].includes(id.split('__facet_')[1]) ? 'no' : 'yes';
            const match = /^repetition__match_(\d+)$/.exec(id);
            if (match) {
                const n = Number(match[1]), pair = c.pairs.find(pair => pair[0] === n || pair[1] === n);
                return pair ? `${pair[2] === 'near_verbatim' ? 'exact' : 'pattern'}_${pair[0] === n ? pair[1] : pair[0]}` : 'none';
            }
            const pattern = /^repetition__pattern_(\d+)$/.exec(id);
            if (pattern) return patterns.get(Number(pattern[1])) || 'none';
            const reply = /^repetition__(\d+)$/.exec(id);
            if (reply) return c.failures.includes(Number(reply[1])) ? 'failure' : 'positive';
            return id === 'repetition' ? 'weak' : normal(id, q);
        });
        const jev = await f.run('combined');
        for (const result of [basic, jev]) {
            assert.equal(result.uncertain.includes('repetition'), Boolean(c.hold), c.label);
            assert.equal(result.correctionCodes.includes('repetition'), !c.hold, c.label);
            if (!c.hold) assert.equal(result.ratings.repetition, c.rating, c.label);
            assert.deepEqual(clone(result.characterFocusFields), []);
        }
        assert.equal(f.bodies.length, 2, 'Comparators do not add a paid request round trip.');
    }
    // Neither a self-pair nor an out-of-window ID nor different facet chains
    // establishes the requested strong same-pattern evidence.
    assert.equal(reduceRepetitionEvidence([1], [{ left: 1, right: 1, kind: 'near_verbatim', facet: 'wording' }]).confirmed, false);
    assert.equal(reduceRepetitionEvidence([1, 11], [{ left: 1, right: 11, kind: 'near_verbatim', facet: 'wording' }], 10).confirmed, false);
    assert.equal(reduceRepetitionEvidence([1, 2, 3], [{ left: 1, right: 2, kind: 'pattern', facet: 'wording' },
        { left: 2, right: 3, kind: 'pattern', facet: 'structure' }]).rating, 'attention');
});

test('ordinary prose and voice stay healthy; low-confidence comparison never arms a repetition repair', async () => {
    const f = await fixture(); const healthy = await f.run('combined');
    assert.equal(healthy.ratings.repetition, 'stable'); assert.equal(healthy.uncertain.length, 0);
    assert.equal(Object.keys(f.bodies[1].questions).filter(id => /^repetition__(match|pattern)_/.test(id)).length, 0);
    f.decide((id, q) => id === 'repetition__facet_wording' ? 'no' : /^repetition__[23]$/.test(id) ? 'failure'
        : /^repetition__match_[23]$/.test(id) ? `exact_${id.endsWith('_2') ? 3 : 2}` : /^repetition__pattern_[23]$/.test(id) ? 'wording' : normal(id, q));
    const fetch = f.env.globals.fetch;
    f.env.globals.fetch = async (...args) => {
        const response = await fetch(...args), body = await response.json();
        for (const id of ['repetition__match_2', 'repetition__match_3']) if (body.answers[id]) body.answers[id].confidence = 0.2;
        return { ...response, json: async () => body };
    };
    const uncertain = await f.run('character');
    assert.ok(uncertain.uncertain.includes('repetition')); assert.ok(!uncertain.correctionCodes.includes('repetition'));
    const basic = payload(f); basic.repetition = 'stable';
    assert.equal(parse(f, basic).ratings.repetition, 'stable');
    const one = parse(f, basic, false, 1); assert.ok(one.uncertain.includes('repetition'));
});

test('normal character evidence covers applicable facets, without requiring traits absent from a quiet scene', async () => {
    for (const code of ['character_consistency', 'character_interpretation']) {
        for (const c of [
            { verdicts: ['yes', 'no_opportunity', 'no_opportunity', 'no_opportunity', 'no_opportunity', 'no_opportunity'], normal: true },
            { verdicts: ['yes', 'uncertain', 'no_opportunity', 'no_opportunity', 'no_opportunity', 'no_opportunity'], normal: false },
            { verdicts: ['yes', 'justified', 'uncertain', 'uncertain', 'no_opportunity', 'no_opportunity'], normal: true },
            { verdicts: Array(6).fill('no_opportunity'), normal: false },
        ]) {
            const f = await fixture(), p = payload(f), ids = Object.keys(AUDIT_PROBLEM_IMPACT[code]);
            p[`${code}_facets`] = Object.fromEntries(ids.map((id, i) => [id, c.verdicts[i]]));
            const basic = parse(f, p);
            f.decide((id, q) => id.startsWith(`${code}__facet_`) ? p[`${code}_facets`][id.split('__facet_')[1]] : normal(id, q));
            const jev = await f.run('character');
            for (const result of [basic, jev]) {
                assert.equal(result.uncertain.includes(code), !c.normal, `${code}/${c.verdicts}`);
                assert.ok(!result.correctionCodes.includes(code));
                if (c.normal) assert.equal(result.ratings[code], 'stable');
            }
            assert.equal(hasSufficientCharacterFacets(ids.map((id, i) => ({ id, verdict: c.verdicts[i] }))), c.normal);
        }
    }
    const f = await fixture(), selected = { ...f.audit.getScopedAuditSelection(f.selection(), 'character'), characterBaseline: '' };
    const absent = await f.diagnosis.runJevDiagnosis({ selection: selected, transcript: 'Synthetic scene.', reviewedResponses: 10,
        schema: f.audit.buildGenreAuditJsonSchema('character', 'en'), parseResult: p => f.audit.parseGenreAuditResult(p, false, 10, 'character', 'en', false) });
    assert.equal(absent.ratings.character_consistency, 'unavailable'); assert.equal(absent.ratings.character_interpretation, 'unavailable');
    assert.ok(!absent.correctionCodes.includes('character_consistency'));
});

test('actual problem facets give both engines the same repair priorities; severity still comes first', async () => {
    for (const c of [
        { facets: { character_consistency: 'voice', relationship: 'boundaries', primary_genre: 'core' }, ratings: {}, expected: ['relationship', 'primary_genre'] },
        { facets: { character_consistency: 'motives', relationship: 'trust', primary_genre: 'core' }, ratings: {}, expected: ['character_consistency', 'relationship'] },
        { facets: { character_consistency: 'voice', relationship: 'boundaries', primary_genre: 'core' }, ratings: { character_consistency: 'drifted' }, expected: ['character_consistency', 'relationship'] },
    ]) {
        const f = await fixture(), p = payload(f);
        for (const [code, facet] of Object.entries(c.facets)) markProblem(f, p, code, facet, c.ratings[code] ? [7, 8] : [8], c.ratings[code] || 'attention');
        const basic = parse(f, p);
        f.decide((id, q) => {
            const facet = /^(.+)__facet_(.+)$/.exec(id);
            if (facet && c.facets[facet[1]] === facet[2]) return 'no';
            const reply = /^(.+)__(\d+)$/.exec(id);
            if (reply && c.facets[reply[1]] && (Number(reply[2]) === 8 || (c.ratings[reply[1]] && Number(reply[2]) === 7))) return 'failure';
            if (c.facets[id]) return c.ratings[id] || 'attention';
            return normal(id, q);
        });
        const jev = await f.run('combined');
        assert.deepEqual(clone(basic.correctionCodes), c.expected); assert.deepEqual(clone(jev.correctionCodes), c.expected);
    }
    const f = await fixture(), p = payload(f); p.problem_facets.character_consistency = ['invented_score_100'];
    assert.throws(() => parse(f, p), error => error.code === 'STORYBOOSTER_INVALID_FIELDS');
    for (const code of Object.keys(AUDIT_PROBLEM_IMPACT)) {
        const actual = f.m.namespace('features/jev-facets.js').JEV_FACETS[code].map(row => row[0]);
        assert.deepEqual([...actual].sort(), Object.keys(AUDIT_PROBLEM_IMPACT[code]).sort(), `Shared facet registry: ${code}`);
    }
});

test('both writers enforce the same selected repair length and summary bounds without losing healthy dimensions', async () => {
    for (const c of [
        { text: 'Keep the motive.', code: 'field_too_short' },
        { text: 'x'.repeat(79), code: 'field_too_short' },
        { text: 'x'.repeat(80), code: null },
        { text: 'x'.repeat(1800), code: null },
        { text: 'x'.repeat(1801), code: 'field_too_long' },
    ]) {
        const f = await fixture(), p = payload(f); markProblem(f, p, 'char_agency', 'judgment');
        p.corrections.char_agency = c.text;
        const summary = p.next_corrections.char_agency;
        if (c.code) assert.throws(() => parse(f, p), error => error.validationCode === c.code && error.validationField === 'corrections.char_agency');
        else assert.equal(parse(f, p).correctionGeneration, 'generated');
        const fixed = parse(f, p, true), feedback = f.feedback('combined', ['char_agency']); feedback.corrections.char_agency = c.text;
        const writer = () => f.diagnosis.writeJevFeedback(fixed, f.selection(), 'Synthetic scene.', async options => options.parseResult(feedback), 'en');
        if (c.code) await assert.rejects(writer(), error => error.validationCode === c.code && error.validationField === 'corrections.char_agency');
        else { const written = (await writer()).correctionByCode.char_agency; assert.equal(written, parse(f, p).correctionByCode.char_agency); assert.ok(written.length <= 1800); }
        if (c.code) assert.throws(() => validateAuditCorrection(c.text, summary, 'char_agency'), error => error.validationCode === c.code);
    }
    const f = await fixture(), p = payload(f); markProblem(f, p, 'char_agency', 'judgment');
    for (const summary of ['', 'short', 'x'.repeat(141)]) {
        p.next_corrections.char_agency = summary;
        assert.throws(() => parse(f, p), error => error.validationField === 'next_corrections.char_agency');
    }
    const healthy = payload(f); healthy.corrections.char_agency = ''; healthy.next_corrections.char_agency = '';
    assert.equal(parse(f, healthy).correctionCodes.length, 0);
});

test('both full audit routes retry short repairs at 4800 tokens, then retain validated findings with an explicit template fallback', async () => {
    for (const engine of ['legacy', 'jev']) for (const recover of [true, false]) {
        const f = await fixture(); f.settings.jevEnabled = engine === 'jev';
        f.decide((id, q) => id === 'char_agency__facet_judgment' ? 'no' : id === 'char_agency__8' ? 'failure' : id === 'char_agency' ? 'attention' : normal(id, q));
        const good = engine === 'legacy' ? payload(f) : f.feedback('combined', ['char_agency']);
        if (engine === 'legacy') markProblem(f, good, 'char_agency', 'judgment');
        const short = clone(good); short.corrections.char_agency = 'Keep the motive.';
        f.env.responses([JSON.stringify(short), JSON.stringify(short), JSON.stringify(recover ? good : short)]);
        const row = await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: true, scope: 'combined' });
        assert.equal(row.status, 'completed'); assert.equal(row.metrics.resultSaved, true); assert.equal(row.metrics.displayUpdated, true);
        assert.equal(row.metrics.requestCount, 3); assert.equal(row.metrics.retryCount, 2);
        assert.deepEqual(f.env.requests.map(args => args[0].responseLength), [4800, 4800, 4800]);
        assert.equal(f.state.genreAnchor.lastAudit.correctionGeneration, recover ? 'generated' : 'template_fallback');
        assert.deepEqual(clone(f.state.genreAnchor.lastAudit.correctionCodes), ['char_agency']);
        assert.equal(f.state.genreAnchor.correctionRemaining, 1);
        assert.equal(f.bodies.length, engine === 'jev' ? 2 : 0);
        assert.equal(row.events.some(event => event.stage === 'feedback_fallback'), !recover);
    }
    // A malformed final diagnosis or a timeout must not borrow an older
    // diagnosis just because an earlier attempt only had a short repair.
    const f = await fixture(); f.settings.jevEnabled = false;
    const short = payload(f); markProblem(f, short, 'char_agency', 'judgment'); short.corrections.char_agency = 'Keep the motive.';
    f.env.responses([JSON.stringify(short), JSON.stringify(short), '{}']);
    const row = await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: true, scope: 'combined' });
    assert.equal(row.status, 'failed'); assert.equal(row.metrics.resultSaved, false); assert.equal(f.state.genreAnchor.correctionRemaining, 0);
});
