import { completeLegacyPolicyFixture } from './helpers/legacy-policy-fixture.mjs';
import assert from 'node:assert/strict';
import { environment, loadModules } from './vm-harness.mjs';
const event = 'An overlooked receipt reveals a discrepancy in the current investigation.';
const plot = { stagnation:'yes', quiet_progress:'no', existing_thread_progress:'no', insertion_safe:'yes', user_direction_blocks:'no', duplicate:'no', stalled_replies:[8,9,10] };
async function fixture({ jev = true } = {}) {
    const env = environment();
    env.context.chat = Array.from({length:10}, (_,i) => [{is_user:true,mes:`Generic input ${i}`},{is_user:false,mes:`The investigator repeats checking the same drawer ${i}.`}]).flat();
    let generated = 0;
    env.context.generate = () => { generated++; throw new Error('Automatic plot must never generate an RP turn'); };
    env.context.getRequestHeaders=()=>({'X-CSRF-Token':'test-csrf'});
    let decide = id => ['stagnation','insertion_safe','candidate_fit','user_agency'].includes(id) || id.startsWith('stalled_') ? 'yes' : 'no';
    let fetchOverride;
    const fetched=[];
    env.globals.fetch=async(url,options)=> {
        const body=JSON.parse(JSON.parse(options.body).custom_include_body);
        fetched.push(body);
        if (fetchOverride) return fetchOverride(body);
        return {ok:true,json:async()=>({answers:Object.fromEntries(Object.entries(body.questions).map(([id,q])=>{
            const canonical=id.startsWith('plot_') ? id.split('__')[0].slice(5) : id;
            const choice=decide(canonical,q,body,id);return [id,{type:'choice',choice,confidence:0.95,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))}];
        }))})};
    };
    const m=await loadModules(env);await env.ready[0]();
    const auto=m.namespace('features/automatic-plot.js'), audit=m.namespace('features/audit.js'), stateModule=m.namespace('core/automatic-plot-state.js');
    const storage=m.namespace('core/storage.js'), client=m.namespace('core/jev-client.js'), plotModule=m.namespace('features/plot.js');
    const settings=storage.ensureModuleSettings(), state=storage.ensureChatState();
    settings.enabledFeatures.genre=false;settings.enabledFeatures.character=false;settings.enabledFeatures.plot=true;
    settings.outputLanguage='en';settings.jevEnabled=jev;settings.jevConsentVersion=jev?1:0;settings.auditInterval=10;
    if(jev) client.setJevSessionKey('test-key-only');
    auto.setAutomaticPlotEnabled(true);
    const selection=()=>audit.getBoosterSelection(state);
    const schema=audit.buildGenreAuditJsonSchema('combined','en');
    const healthy=m.namespace('features/jev-diagnosis.js').createEmptyJevPayload(schema);
    const baselineResponse=()=>JSON.stringify(completeLegacyPolicyFixture({...healthy,plot}));
    const prepare=async()=>{
        env.responses(jev ? [JSON.stringify({event})] : [baselineResponse(),JSON.stringify({event})]);
        await audit.runGenreDriftAudit('chat_A',selection(),{manual:false,scope:'combined'});
    };
    const next=()=>auto.automaticPlotGenerationInterceptor([],2048,()=>{},'normal');
    return {env,m,auto,audit,rt:stateModule.automaticPlotRuntime,cancel:stateModule.cancelAutomaticPlot,storage,client,plotModule,settings,state,selection,prepare,next,fetched,generated:()=>generated,decide:fn=>{decide=fn;},override:fn=>{fetchOverride=fn;},baselineResponse};
}
// Actual entry point and full audit -> generation -> next-turn interceptor ->
// response consumption. No RP generation occurs as a side effect.
{
    const f=await fixture();
    assert.equal(f.env.globals.storyboosterAutomaticPlotInterceptor,f.auto.automaticPlotGenerationInterceptor);
    await f.prepare();
    assert.ok(f.rt.pending,'Automatic audit stores a pending candidate');
    assert.equal(f.m.runtime.plotPending,false);
    assert.equal(f.generated(),0);
    assert.equal(f.env.requests.length,1);
    assert.equal(f.state.plotHistory?.length || 0,0,'Prepared candidates do not become applied history');
    const calls=f.fetched.length;
    f.env.context.chat.push({is_user:true,mes:'Please continue naturally without deciding my reaction.'});
    await f.auto.automaticPlotGenerationInterceptor([],2048,()=>{},'quiet');
    assert.ok(f.rt.pending);assert.equal(f.fetched.length,calls);
    await f.next();
    assert.equal(f.rt.pending,null);assert.ok(f.rt.armed);
    assert.ok(f.m.runtime.plotPending);
    assert.match(f.m.runtime.currentPlotInjectionText,/overlooked receipt/);
    assert.match(f.fetched.at(-1).state.roleplay,/Please continue naturally/);
    assert.equal(f.state.plotHistory.length,1);
    assert.equal(f.state.plotHistory[0].text,event);
    assert.equal(f.generated(),0);
    f.env.context.chat.push({is_user:false,mes:'The investigator notices the overlooked receipt.'});
    await f.env.listeners.get('MESSAGE_RECEIVED')[0](f.env.context.chat.length-1);
    assert.equal(f.m.runtime.plotPending,false);assert.equal(f.rt.armed,null);
    assert.equal(f.state.automaticPlot.lastAppliedCount,11);
    const requests=f.env.requests.length, count=f.fetched.length;
    await f.auto.prepareAutomaticPlot({chatId:'chat_A',selection:f.selection(),result:{ratings:{},correctionCodes:[],uncertain:[]},transcript:'test',count:10,isCurrent:()=>true});
    assert.equal(f.env.requests.length,requests);assert.equal(f.fetched.length,count,'Cooldown avoids another classification call');
}
// New user direction wins even if the earlier window justified a candidate.
{
    const f=await fixture();await f.prepare();
    f.env.context.chat.push({is_user:true,mes:'Keep this quiet scene; answer my question first.'});
    f.decide(id=>id==='user_direction_blocks' ? 'yes' : ['stagnation','insertion_safe','candidate_fit','user_agency'].includes(id)||id.startsWith('stalled_') ? 'yes':'no');
    await f.next();assert.equal(f.m.runtime.plotPending,false);assert.equal(f.rt.pending,null);assert.equal(f.generated(),0);
}
// Quiet/emotional progress and unresolved threads never cause automatic events.
for(const protectedDimension of ['quiet_progress','existing_thread_progress']) {
    const f=await fixture();
    f.decide(id=>id===protectedDimension ? 'yes' : ['stagnation','insertion_safe'].includes(id)||id.startsWith('stalled_') ? 'yes':'no');
    await f.prepare();assert.equal(f.rt.pending,null);assert.equal(f.env.requests.length,0);
}
// Mutation and selection changes invalidate prepared candidates without a call.
for(const mutation of [
    f=>{f.env.context.chat[1].mes='Edited previous reply';},
    f=>{f.auto.setAutomaticPlotEnabled(false);},
    f=>{f.client.setJevSessionKey('changed-test-key');},
    f=>{f.state.genreAnchor.correctionRemaining=1;},
    f=>{f.m.namespace('core/runtime.js').eventGenerationPendingTasks.set('manual',true);},
]) {
    const f=await fixture();await f.prepare();const calls=f.fetched.length;
    mutation(f);await f.next();assert.equal(f.m.runtime.plotPending,false);assert.equal(f.fetched.length,calls);
}
// Leave and return to the same chat: an identity-only comparison is insufficient.
{
    const f=await fixture();await f.prepare();
    for(const id of ['chat_B','chat_A']) {f.env.context.chatId=id;await f.env.listeners.get('CHAT_CHANGED')[0]();}
    await f.next();assert.equal(f.rt.pending,null);assert.equal(f.m.runtime.plotPending,false);
}
// Manual events take priority; disabling automatic plot cannot erase them.
{
    const f=await fixture();await f.prepare();
    f.plotModule.triggerPlotEvent('A manually chosen letter arrives.','manual');
    assert.equal(f.rt.pending,null);const prompt=f.m.runtime.currentPlotInjectionText;
    f.auto.setAutomaticPlotEnabled(false);assert.equal(f.m.runtime.currentPlotInjectionText,prompt);
}
// A new unhealthy audit clears an old automatic candidate rather than reviving it.
{
    const f=await fixture();await f.prepare();
    await f.auto.prepareAutomaticPlot({chatId:'chat_A',selection:f.selection(),result:{correctionCodes:['continuity'],ratings:{}},transcript:'test',count:10,isCurrent:()=>true});
    assert.equal(f.rt.pending,null);
}
// Late validation cannot inject after chat cancellation, and failed generation
// does not reuse an already armed instruction on the next request.
{
    const f=await fixture();await f.prepare();let release;
    f.override(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.next();await new Promise(resolve=>setImmediate(resolve));
    await f.env.listeners.get('GENERATION_STOPPED')[0]();release({ok:false,status:503});await pending;
    assert.equal(f.m.runtime.plotPending,false);
}
for(const cancelMethod of ['stop','next-generation']) {
    const f=await fixture();await f.prepare();await f.next();assert.ok(f.rt.armed);
    if(cancelMethod==='stop') await f.env.listeners.get('GENERATION_STOPPED')[0](); else await f.next();
    assert.equal(f.rt.armed,null);assert.equal(f.m.runtime.plotPending,false);
}
// Manual combined diagnosis judges plot need but never prepares an event.
{
    const f=await fixture();f.env.responses([]);
    await f.audit.runGenreDriftAudit('chat_A',f.selection(),{manual:true,scope:'combined'});
    assert.equal(f.rt.pending,null);assert.equal(f.env.requests.length,0);
    assert.match(f.state.automaticPlot.lastDecision,/수동 진단/);
    assert.ok(f.fetched.length>0);
}
// The optional automatic feature also works without Jev using the existing
// analysis connection, including the final user-agency gate.
{
    const f=await fixture({jev:false});await f.prepare();assert.ok(f.rt.pending);
    assert.equal(f.env.requests.length,2);assert.equal(f.fetched.length,0);
    f.env.context.chat.push({is_user:true,mes:'Continue naturally.'});
    f.env.responses([JSON.stringify({plot:{...plot,candidate_fit:true,user_agency_preserved:true}})]);
    await f.next();assert.ok(f.rt.armed);assert.equal(f.fetched.length,0);assert.equal(f.generated(),0);
}
// Headless generation uses the same bounded JSON -> tag -> repair policy.
{
    const f=await fixture();f.env.responses(['{}','<plot_event>',`<plot_event>${event}</plot_event>`]);
    const result=await f.plotModule.requestHeadlessPlotEvent({chatId:'chat_A',selection:f.selection(),isCurrent:()=>true});
    assert.equal(result.event,event);assert.equal(f.env.requests.length,3);assert.equal(f.generated(),0);
}
console.log('Automatic plot preparation, user priority, single use, cooldown, cancellation and legacy transport tests passed.');

// A protective subcheck can veto a broad "safe/stalled" judgment independently.
for (const rawId of ['plot_quiet_progress__emotional_progress', 'plot_user_direction_blocks__answer_due']) {
    const f = await fixture();
    f.decide((id, _q, _body, raw) => raw === rawId ? 'yes'
        : ['stagnation', 'insertion_safe'].includes(id) || id.startsWith('stalled_') ? 'yes' : 'no');
    await f.prepare();
    assert.equal(f.rt.pending, null);
    assert.equal(f.env.requests.length, 0, 'A protective subcheck prevents candidate generation');
}
// One global diagnosis interval replaces the old independent cooldown.
{
    const f = await fixture();
    f.state.automaticPlot.cooldownReplies = 30;
    f.auto.ensureAutomaticPlotSettings();
    assert.ok(!Object.hasOwn(f.state.automaticPlot, 'cooldownReplies'));
    f.settings.auditInterval = 5;
    f.state.automaticPlot.lastAppliedCount = 6; // Four replies since application.
    await f.prepare(); assert.equal(f.rt.pending, null);
    f.state.automaticPlot.lastAppliedCount = 5; // Exactly one interval.
    await f.prepare(); assert.ok(f.rt.pending);
}

// Preparation announces a candidate; cancel preserves opt-in and never creates
// history, injects a prompt or revives the candidate on the next generation.
{
    const f = await fixture(); await f.prepare();
    assert.ok(f.env.notices.some(n => String(n[1]).includes('랜덤박스가 준비됐어요')));
    const calls = f.fetched.length;
    assert.equal(f.auto.cancelPreparedAutomaticPlot(), true);
    assert.equal(f.state.automaticPlot.enabled, true); assert.equal(f.rt.pending, null);
    assert.match(f.state.automaticPlot.lastDecision, /취소/);
    await f.next(); assert.equal(f.fetched.length, calls); assert.equal(f.m.runtime.plotPending, false);
    assert.equal(f.state.plotHistory?.length || 0, 0);
}
// A cancellation during the asynchronous final check cannot be overwritten by
// that check's late response and cannot affect a manually prepared event.
{
    const f = await fixture(); await f.prepare(); let release;
    f.override(() => new Promise(resolve => { release = resolve; }));
    const pending = f.next(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.auto.cancelPreparedAutomaticPlot(), true);
    release({ ok: false, status: 503 }); await pending;
    assert.match(f.state.automaticPlot.lastDecision, /이번 랜덤박스를 취소/);
    assert.equal(f.m.runtime.plotPending, false); assert.equal(f.rt.armed, null);
    f.plotModule.triggerPlotEvent('A manually selected event.', 'manual');
    const manual = f.m.runtime.currentPlotInjectionText;
    assert.equal(f.auto.cancelPreparedAutomaticPlot(), false); assert.equal(f.m.runtime.currentPlotInjectionText, manual);
}
