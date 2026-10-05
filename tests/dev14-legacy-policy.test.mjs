import { completeLegacyPolicyFixture } from './helpers/legacy-policy-fixture.mjs';
import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const repair = 'In the next reply, let the investigator make the small character-owned choice already available in the conversation. Use the established motive and decision style, preserve the warm relationship and ongoing action, and leave the partner free to choose their own response. Do not introduce a new event or reset healthy behavior.';
function payload(f, overrides = {}, scope = 'combined') {
    const schema = f.audit.buildGenreAuditJsonSchema(scope, 'en');
    const value = Object.fromEntries(Object.entries(schema.schema.properties).map(([key, p]) => [key,
        p.type === 'array' ? [] : p.type === 'object' ? {} : p.type === 'boolean' ? false : p.enum?.includes('na') ? 'na' : '']));
    const normal = { primary_genre: 'present', genre_expression: 'present', support_texture: 'present', scene_density: 'present', character_consistency: 'stable', character_interpretation: 'stable', char_agency: 'present', relationship: 'present', continuity: 'present', repetition: 'stable' };
    const positives = ['primary_genre_evidence','genre_expression_evidence','support_texture_evidence','scene_density_evidence','character_consistency_positive_evidence','character_interpretation_positive_evidence','char_agency_evidence','relationship_evidence','continuity_evidence'];
    for (const [key, rating] of Object.entries(normal)) if (Object.hasOwn(value, key)) value[key] = rating;
    for (const key of positives) if (Object.hasOwn(value, key)) value[key] = [1,2,3,4];
    for (const key of Object.keys(value)) if (key.endsWith('_reason')) value[key] = 'The observed behavior consistently fits the scene and established standard.';
    if (Object.hasOwn(value,'support_texture_identifiable')) value.support_texture_identifiable = true;
    for(const field of ['corrections','next_corrections']) value[field]=Object.fromEntries(Object.keys(schema.schema.properties[field].properties).map(code=>[code,'']));
    return completeLegacyPolicyFixture({ ...value, ...overrides });
}
const parse = (f, p, scope = 'combined') => f.audit.parseGenreAuditResult(JSON.stringify(p), true, 10, scope, 'en');

// No defect: remain normal. Lack of affirmative samples alone is deferred;
// independently healthy dimensions remain decided.
{
    const f = await fixture();
    let result = parse(f,payload(f)); assert.deepEqual(clone(result.uncertain),[]); assert.deepEqual(clone(result.correctionCodes),[]);
    result = parse(f,payload(f,{char_agency:'attention',char_agency_evidence:[1],char_agency_reason:'There are too few applicable choices to judge.'}));
    assert.ok(result.uncertain.includes('char_agency')); assert.equal(result.ratings.relationship,'present'); assert.deepEqual(clone(result.correctionCodes),[]);
    assert.equal(f.m.namespace('ui/panels.js').getGenreAuditDisplayStatus({...result,engine:'legacy'},'char_agency').text,'판단 보류');
    assert.equal(f.m.namespace('features/automatic-plot.js').healthyAuditForAutomaticPlot(f.selection(),result),true);
}
// One concrete minor defect is actionable, including a mild support-lens miss.
// Multiple confirmed cautions remain visible but at most two are selected.
{
    const f = await fixture();
    const result = parse(f,payload(f,{char_agency:'attention',char_agency_failure_evidence:[8],char_agency_reason:'The investigator hands their own choice back to the partner.',
        relationship:'attention',relationship_failure_evidence:[7],scene_density:'attention',scene_density_failure_evidence:[6],
        deferred_dimensions:['char_agency'],corrections:{char_agency:repair,relationship:repair},next_corrections:{char_agency:'Let the investigator make the available choice themselves.',relationship:'Let the established relationship affect the next reaction.'},character_focus_fields:['goals_motives']}));
    assert.equal(result.ratings.char_agency,'attention'); assert.ok(!result.uncertain.includes('char_agency'));
    assert.deepEqual(clone(result.correctionCodes),['char_agency','relationship']); assert.match(result.correctionByCode.char_agency,/one small local repair/);
    assert.match(result.reasons.char_agency,/hands their own choice/); assert.ok(!result.correctionByCode.scene_density);
    assert.equal(f.m.namespace('features/automatic-plot.js').healthyAuditForAutomaticPlot(f.selection(),result),false);
    const support = parse(f,payload(f,{support_texture:'attention',support_texture_opportunity:[8],support_texture_reason:'An established clue was briefly ignored despite a natural opening.'}));
    assert.match(support.reasons.support_texture,/established clue/);
    assert.equal(support.ratings.support_texture,'attention'); assert.deepEqual(clone(support.correctionCodes),['support_texture']);
    const limitedSupport = parse(f,payload(f,{support_texture:'weak',support_texture_opportunity:[8]}));
    assert.equal(limitedSupport.ratings.support_texture,'attention');
    const dormant = parse(f,payload(f,{support_texture:'dormant',support_texture_evidence:[],support_texture_identifiable:false}));
    assert.deepEqual(clone(dormant.correctionCodes),[]); assert.ok(!dormant.uncertain.includes('support_texture'));
}
// Severity precedes mild caution and severe state breaks precede all others.
{
    const f = await fixture();
    const result = parse(f,payload(f,{character_consistency:'attention',character_consistency_evidence:[6],character_focus_fields:['core_identity'],
        primary_genre:'weak',primary_genre_failure_evidence:[3,6,8],continuity:'weak',continuity_failure_evidence:[9],continuity_severe:true}));
    assert.deepEqual(clone(result.correctionCodes),['continuity','primary_genre']); assert.deepEqual(clone(result.characterFocusFields),[]);
    assert.ok(!result.correctionByCode.character_consistency); assert.equal(result.correctionText,'');
}
// Repetition needs a comparator. An emerging pair gets a small repair;
// ordinary wording and signature voice need no artificial novelty.
{
    const f = await fixture();
    const one = parse(f,payload(f,{repetition:'attention',repetition_evidence:[4]}));
    assert.ok(one.uncertain.includes('repetition')); assert.deepEqual(clone(one.correctionCodes),[]);
    const pair = parse(f,payload(f,{repetition:'attention',repetition_evidence:[4,8],character_focus_fields:['core_identity']}));
    assert.deepEqual(clone(pair.correctionCodes),['repetition']); assert.deepEqual(clone(pair.characterFocusFields),[]);
}
// Explicit essential context/conflict is deferred; malformed policy fields
// enter structured-output recovery rather than silently arming a repair.
{
    const f = await fixture();
    const result = parse(f,payload(f,{deferred_dimensions:['continuity'],continuity_reason:'The prior state needed to interpret this response is absent.'}));
    assert.ok(result.uncertain.includes('continuity')); assert.deepEqual(clone(result.correctionCodes),[]);
    for (const invalid of [{deferred_dimensions:['invented']},{deferred_dimensions:'continuity'},{corrections:[]},{next_corrections:{char_agency:42}}]) {
        assert.throws(()=>parse(f,payload(f,invalid)),e=>e.code==='STORYBOOSTER_INVALID_FIELDS');
    }
    for(const scope of ['genre','character','combined']) {
        const schema=f.audit.buildGenreAuditJsonSchema(scope,'en');
        for(const field of ['corrections','next_corrections']) assert.deepEqual(clone(schema.schema.properties[field].required),Object.keys(schema.schema.properties[field].properties));
        assert.ok(schema.schema.required.includes('corrections')); assert.ok(schema.schema.required.includes('deferred_dimensions'));
        assert.deepEqual(clone(parse(f,payload(f,{},scope),scope).correctionCodes),[]);
    }
}
// Manual and actual MESSAGE_RECEIVED automatic routes each use ONE legacy
// request for the judgment, reason and repair, persist it and arm one reply.
for (const trigger of ['manual','event']) {
    const f = await fixture();f.settings.jevEnabled=false;
    const raw=payload(f,{char_agency:'attention',char_agency_failure_evidence:[8],char_agency_reason:'The investigator leaves their own choice to the partner.',
        corrections:{char_agency:repair},next_corrections:{char_agency:'Let the investigator choose from their own established motive.'},character_focus_fields:['goals_motives']});
    f.env.responses([JSON.stringify(raw)]);
    if(trigger==='manual') await f.audit.runManualGenreAudit('combined');
    else {
        f.state.genreAnchor.responseCount=f.settings.auditInterval-1;
        f.env.context.chat.push({is_user:true,mes:'Which route do you choose?'},{is_user:false,mes:'The investigator considers the route.'});
        await f.env.listeners.get('MESSAGE_RECEIVED')[0](f.env.context.chat.length-1);
        for(let n=0;n<100&&!f.state.genreAnchor.lastAudit;n++) await new Promise(resolve=>setTimeout(resolve,5));
    }
    for(let n=0;n<100&&!f.state.genreAnchor.lastAudit;n++) await new Promise(resolve=>setTimeout(resolve,5));
    const record=f.state.genreAnchor.lastAudit;
    assert.ok(record,`${trigger} stores a result`);assert.equal(record.engine,'legacy');assert.equal(record.status,'pending');
    assert.equal(f.env.requests.length,1);assert.equal(f.bodies.length,0);assert.equal(f.state.genreAnchor.correctionRemaining,1);
    assert.equal(f.env.requests[0][0].responseLength,4800);
    assert.match(record.correctionSummaries.char_agency,/choose/); assert.equal(record.correctionGeneration,'generated');
    const prompt=f.env.requests[0][0].prompt.find(row=>row.role==='system').content;
    assert.match(prompt,/attention means a confirmed concrete mild problem/);
    assert.doesNotMatch(prompt,/Ignore attention|Use attention for mixed, borderline|Use attention when positive realization/);
    const saved=f.storage.normalizeGenreAuditRecord(clone(record));
    assert.equal(saved.status,'pending');assert.equal(saved.correctionByCode.char_agency,record.correctionByCode.char_agency);
    assert.equal(f.env.errors.length,0);
}
// Deferred legacy results stay deferred across saving/loading and the UI.
{
    const f=await fixture();f.settings.jevEnabled=false;
    f.env.responses([JSON.stringify(payload(f,{char_agency:'attention',char_agency_evidence:[],deferred_dimensions:['char_agency'],char_agency_reason:'No applicable choice can be interpreted from the available context.'}))]);
    f.audit.runManualGenreAudit('combined');
    for(let n=0;n<100&&!f.state.genreAnchor.lastAudit;n++) await new Promise(resolve=>setTimeout(resolve,5));
    const record=f.state.genreAnchor.lastAudit;assert.equal(record.status,'deferred');assert.equal(f.state.genreAnchor.correctionRemaining,0);
    const saved=f.storage.normalizeGenreAuditRecord(clone(record));assert.deepEqual(clone(saved.uncertain),['char_agency']);assert.equal(saved.status,'deferred');
}
console.log('dev.14: normal/deferred/mild/severe policy, shared priority, scope schemas, UI/persistence, independent plot gate and one-call manual/automatic legacy repair passed.');
