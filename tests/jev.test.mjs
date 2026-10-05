import assert from 'node:assert/strict';
import { environment, loadModules } from './vm-harness.mjs';
const clone = x => JSON.parse(JSON.stringify(x));
const env = environment();
const fetches = [];
env.context.getRequestHeaders = () => ({ 'X-CSRF-Token': 'csrf-fixture' });
let responder;
env.globals.fetch = async (url, options) => {
    fetches.push({ url, options, body: JSON.parse(options.body) });
    return responder(url, options);
};
const m = await loadModules(env);
await env.ready[0]();
assert.deepEqual(env.errors, []);
const client = m.namespace('core/jev-client.js');
const auto = m.namespace('features/automatic-plot.js');
const diagnosis = m.namespace('features/jev-diagnosis.js');
const rt = m.namespace('core/automatic-plot-state.js');
const audit = m.namespace('features/audit.js');
const storage = m.namespace('core/storage.js');
const settings = storage.ensureModuleSettings();
assert.equal(settings.jevEnabled, false);
assert.equal(settings.settingsSchemaVersion, 25);
assert.equal(auto.ensureAutomaticPlotSettings().enabled, false);
assert.ok(!Object.hasOwn(auto.ensureAutomaticPlotSettings(), 'cooldownReplies')); 
const key = 'test-only-secret';
client.setJevSessionKey(key);
assert.equal(client.getJevConnectionBadge(true).text, 'Jev 사용 준비됨');
assert.ok(client.getJevConnectionBadge(false).hidden);
assert.ok(client.hasJevSessionKey());
assert.ok(!JSON.stringify(settings).includes(key));
assert.throws(() => client.setJevSessionKey('bad\r\nkey'));
function answersFor(body, decide) {
    return { model: 'jev-fixture', answers: Object.fromEntries(Object.entries(body.questions).map(([id,q]) => {
        const selected = decide(id,q);
        const choice = /^repetition__(match|pattern)_/.test(id) && !Object.hasOwn(q.criteria, selected) ? 'none' : selected;
        return [id, q.type === 'noul' ? { type:'noul', noul: 0.9 } : {
            type:'choice', choice, confidence: 0.9,
            probabilities: Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0])) }];
    })) };
}
await assert.rejects(client.testJevConnection(), e => e.code === 'STORYBOOSTER_JEV_CONSENT_REQUIRED');
assert.equal(fetches.length, 0);
client.setJevUsageConsent(true);
responder = async (_url, options) => ({ ok:true, json:async()=>answersFor(JSON.parse(JSON.parse(options.body).custom_include_body), ()=> 'yes') });
await client.testJevConnection();
assert.equal(client.getJevConnectionBadge(true).text, 'Jev 사용 준비됨');
assert.equal(fetches.length,1);
assert.equal(fetches[0].url,'/api/backends/chat-completions/generate');
assert.equal(fetches[0].options.credentials,'same-origin');
assert.equal(fetches[0].body.custom_url,'https://api.typesafe.ai/v1/systemone?via=');
assert.equal(JSON.parse(fetches[0].body.custom_include_headers).Authorization,`Bearer ${key}`);
assert.equal(JSON.parse(fetches[0].body.custom_include_body).state.purpose,'connection_test');
assert.equal(env.requests.length,0);
const invalid = { answers: { x: { type:'choice',choice:'yes', confidence:1,probabilities:{yes:2,no:0} } } };
assert.throws(()=>client.validateJevAnswers(invalid,{x:{type:'choice',criteria:{yes:'',no:''}}}));
responder=async()=>({ok:false,status:404});
await assert.rejects(client.testJevConnection(), e=>e.code==='STORYBOOSTER_JEV_HTTP_ERROR');
assert.equal(client.getJevConnectionBadge(true).text, 'Jev 연결 실패');
assert.equal(fetches.length,2,'Relay failure never tries a direct URL or proxy');
responder=async()=>({ok:true,json:async()=>({error:{message:`do not leak ${key}`}})});
await assert.rejects(client.testJevConnection(), e=>!e.message.includes(key)&&e.code==='STORYBOOSTER_JEV_UPSTREAM_ERROR');
client.setJevSessionKey('');
assert.equal(client.getJevConnectionBadge(true).text, 'Jev 미연결');
assert.ok(!client.hasJevSessionKey());
await assert.rejects(client.testJevConnection(),e=>e.code==='STORYBOOSTER_JEV_KEY_MISSING');
client.setJevSessionKey(key);
settings.jevEnabled=true;settings.jevConsentVersion=1;
const state=storage.ensureChatState();
state.genreSelection.primaryId='romance';
state.genreSelection.supportIds=[];
for(let i=0;i<9;i++) env.context.chat.push({is_user:true,mes:`Input ${i}`},{is_user:false,mes:`Reply ${i}`});
const selection=audit.getBoosterSelection(state);
let rounds=0;
responder=async(_url,options)=>{
    rounds++;
    const b=JSON.parse(JSON.parse(options.body).custom_include_body);
    return {ok:true,json:async()=>answersFor(b,(id,q)=> id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive' : 'present')};
};
const schema=audit.buildGenreAuditJsonSchema('genre','ko');
const parseResult=raw=>audit.parseGenreAuditResult(raw,false,10,'genre','ko',false);
const result=await diagnosis.runJevDiagnosis({selection,transcript:'Numbered generic test replies',reviewedResponses:10,schema,parseResult});
assert.equal(rounds,2);
assert.equal(result.engine,'jev');
assert.equal(result.ratings.primary_genre,'present');
assert.deepEqual(clone(result.correctionCodes),[]);
assert.equal(result.evidence.primary.length,4);
assert.equal(result.jev.questions,51,'Only active genre dimensions are examined');
assert.ok(auto.healthyAuditForAutomaticPlot(selection,result));
const weak=clone(result);weak.correctionCodes=['scene_density'];
assert.ok(!auto.healthyAuditForAutomaticPlot(selection,weak));
const unknown=clone(result);unknown.uncertain=['primary_genre'];unknown.ratings.primary_genre='attention';
assert.ok(auto.healthyAuditForAutomaticPlot(selection,unknown),'Deferred genre judgment allows an independent plot check');
const stalled={plot:{stagnation:'yes',quiet_progress:'no',existing_thread_progress:'no',insertion_safe:'yes',user_direction_blocks:'no',duplicate:'no',stalled_replies:[8,9,10]}};
assert.ok(auto.parsePlotDecision(stalled,10).eligible);
assert.ok(!auto.parsePlotDecision({...stalled,plot:{...stalled.plot,quiet_progress:'yes'}},10).eligible);
assert.ok(!auto.parsePlotDecision({...stalled,plot:{...stalled.plot,user_direction_blocks:'yes'}},10).eligible);
assert.ok(!auto.parsePlotDecision({...stalled,plot:{...stalled.plot,stalled_replies:[8,8,9,99]}},10).eligible);
assert.ok(!auto.parsePlotDecision(stalled,4).eligible);
assert.equal(auto.parsePlotDecision({plot:{}},10),null);
// Full manual path uses Jev, retains the existing reducer, and persists engine.
env.responses([JSON.stringify({reasons:{primary_genre:'관계의 선택과 반응에 로맨스의 흐름이 이어집니다.',genre_expression:'장면에 맞는 감정 표현이 이어집니다.',scene_density:'공간과 행동이 자연스럽게 연결됩니다.'},corrections:{},next_corrections:{},character_focus_fields:[]})]);
await audit.runGenreDriftAudit('chat_A',audit.getScopedAuditSelection(selection,'genre'),{manual:true,scope:'genre'});
assert.equal(state.genreAnchor.lastAudit.engine,'jev');
assert.equal(env.requests.length,1,'Reasons are written in one model call even without a repair');
assert.match(state.genreAnchor.lastAudit.reasons.primary_genre,/관계의 선택/);
// Failure recovers through the existing diagnosis, exactly once when successful.
responder=async()=>({ok:false,status:503});
const healthyRaw=diagnosis.createEmptyJevPayload(schema);
for(const k of ['primary_genre','genre_expression','scene_density']) {
    healthyRaw[k]='present';healthyRaw[k+'_evidence']=[1,2,3,4];healthyRaw[k+'_reason']='Concrete supporting evidence.';
}
env.responses([JSON.stringify(healthyRaw)]);
await audit.runGenreDriftAudit('chat_A',audit.getScopedAuditSelection(selection,'genre'),{manual:true,scope:'genre'});
assert.equal(state.genreAnchor.lastAudit.engine,'legacy');
assert.equal(state.genreAnchor.lastAudit.jevFallback,true);
assert.equal(env.requests.length,1);
assert.ok(!JSON.stringify(env.settings).includes(key));
// Character correction is written only for a supported selected target,
// leaving the baseline and already healthy dimensions unchanged.
settings.enabledFeatures.genre=false;
settings.enabledFeatures.character=true;
settings.outputLanguage='en';
const identity=m.namespace('core/context.js').getCurrentCharacterIdentity();
storage.writeCharacterBaselineVersion(identity,{fields:{core_identity:{text:'A reserved independent investigator with firm boundaries.',pinned:true},relationship_response:{text:'A trusted investigative partner.'}},boostAnchor:'Preserve deliberate choices and restrained dialogue.',sourceHash:identity.sourceHash,updatedAt:Date.now()},'');
const savedBaseline=JSON.stringify(settings.characterBaselines);
responder=async(_url,options)=> {
    const b=JSON.parse(JSON.parse(options.body).custom_include_body);
    return {ok:true,json:async()=>answersFor(b,(id)=>id.includes('__facet_') ? (id==='character_consistency__facet_motives' ? 'no':'yes') : id==='character_consistency' ? 'drifted'
        : id.startsWith('character_consistency__') ? (Number(id.split('__')[1])>=9 ? 'failure':'none')
        : id.includes('__') ? 'positive' : ['character_interpretation','repetition'].includes(id) ? 'stable':'present')};
};
env.responses([JSON.stringify({reasons:{character_consistency:'The investigator repeatedly abandons established independent judgment.',character_interpretation:'The investigator retains context-appropriate facets.',char_agency:'The investigator takes purposeful action.',relationship:'The partnership remains specific to its shared history.',continuity:'The immediate situation is carried forward.',repetition:'The observed expressions vary with the scene.'}, corrections:{character_consistency:'Ground the next decision in the investigator’s established independence and firm personal boundaries. Express disagreement through restrained, deliberate dialogue while preserving the partner’s freedom to respond.'},next_corrections:{character_consistency:'Ground the next decision in independent judgment and restrained dialogue.'},character_focus_fields:['core_identity']})]);
await audit.runGenreDriftAudit('chat_A',audit.getScopedAuditSelection(audit.getBoosterSelection(state),'character'),{manual:true,scope:'character'});
assert.equal(state.genreAnchor.lastAudit.engine,'jev');
assert.deepEqual(clone(state.genreAnchor.correctionCodes),['character_consistency']);
assert.equal(state.genreAnchor.lastAudit.correctionGeneration,'generated');
assert.equal(env.requests.length,1);
assert.match(state.genreAnchor.correctionText,/established independence/);
assert.equal(JSON.stringify(settings.characterBaselines),savedBaseline);
assert.ok(!/[가-힣]/.test(state.genreAnchor.lastAudit.reasons.character_consistency),'English output uses English diagnostic explanations');
// Ambiguous secondary-genre screening is retained as uncertainty rather than
// causing a whole-diagnosis failure on the legacy support enum.
settings.enabledFeatures.genre=true;
state.genreSelection.supportIds=['mystery'];
const supportSelection=audit.getScopedAuditSelection(audit.getBoosterSelection(state),'genre');
responder=async(_url,options)=> {
    const b=JSON.parse(JSON.parse(options.body).custom_include_body);
    return {ok:true,json:async()=>answersFor(b,id=>id.includes('__facet_')?'yes':id==='support_texture' ? 'attention':id.includes('__')?'positive':'present')};
};
const supportResult=await diagnosis.runJevDiagnosis({selection:supportSelection,transcript:'Generic numbered replies',reviewedResponses:10,schema:audit.buildGenreAuditJsonSchema('genre','en'),outputLanguage:'en',parseResult:raw=>audit.parseGenreAuditResult(raw,true,10,'genre','en',false)});
assert.equal(supportResult.ratings.support_texture,'dormant');
assert.ok(supportResult.uncertain.includes('support_texture'));
assert.ok(auto.healthyAuditForAutomaticPlot(supportSelection,supportResult),'Deferred support lens allows an independent plot check');
// Requests cancelled by key replacement cannot apply a stale answer.
let release;
responder=async()=>new Promise(resolve=>{release=resolve;});
const pending=client.testJevConnection();
await new Promise(resolve => setImmediate(resolve));
assert.equal(typeof release, 'function');
client.setJevSessionKey('replacement-test-only');
release({ok:true,json:async()=>({answers:{connection_test:{type:'noul',noul:1}}})});
await assert.rejects(pending,e=>e.code==='STORYBOOSTER_JEV_CANCELLED');
console.log('Jev transport, evidence, manual diagnosis and legacy fallback tests passed.');
