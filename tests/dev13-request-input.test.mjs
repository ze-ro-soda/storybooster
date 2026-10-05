import assert from 'node:assert/strict';
import { environment, loadModules } from './vm-harness.mjs';
import { fixture as diagnosisFixture } from './helpers/diagnosis-fixture.mjs';
import { runAbortableRequest } from '../core/request-lifecycle.js';

const plot = { stagnation:'yes', quiet_progress:'no', existing_thread_progress:'no', insertion_safe:'yes', user_direction_blocks:'no', duplicate:'no', stalled_replies:[8,9,10], candidate_fit:true, user_agency_preserved:true };
const valid = JSON.stringify({plot});
async function setup() {
    const env=environment(); const m=await loadModules(env); await env.ready[0]();
    return {env,m,auto:m.namespace('features/automatic-plot.js'),requests:m.namespace('core/requests.js')};
}
// The actual legacy classifier and the shared API both recover without a
// caller-provided diagnostic, including missing rather than truncated fields.
for (const first of ['', '{', '{}']) {
    const f=await setup(); f.env.responses([first,valid]);
    const result=await f.auto.diagnoseAutomaticPlot({selection:{},transcript:'Synthetic evidence',count:10,preferJev:false});
    assert.equal(result.eligible,true); assert.equal(f.env.requests.length,2);
}
{
    const f=await setup(); f.env.responses(['',valid]);
    const result=await f.requests.requestStructuredJsonWithCompatibility({prompt:'test',transcript:'test',task:'test',parseResult:raw=>JSON.parse(raw)});
    assert.equal(result.plot.stagnation,'yes'); assert.equal(f.env.requests.length,2);
}
// Cancellation reaches all host routes and terminates even a host that ignores
// its signal. A late result must not create a retry or invoke parsing.
for (const route of ['rawData','raw','quiet','profile']) {
    const f=await setup(); const outer=new AbortController(); let providerSignal,release,calls=0,parsed=0;
    const pending=options=>{calls++;providerSignal=options.signal;return new Promise(resolve=>{release=resolve;});};
    delete f.env.context.generateRawData;
    if(route==='rawData') f.env.context.generateRawData=pending;
    if(route==='raw') f.env.context.generateRaw=pending;
    if(route==='quiet') f.env.context.generateQuietPrompt=pending;
    if(route==='profile') f.env.context.ConnectionManagerRequestService.sendRequest=(_id,_messages,_length,options)=>pending(options);
    const request=f.requests.requestStructuredJsonWithCompatibility({prompt:'test',transcript:'test',task:'test',signal:outer.signal,
        connectionSnapshot:route==='profile'?{source:'profile',profileId:'synthetic',apiType:'openai'}:{source:'main'},
        parseResult:raw=>{parsed++;return raw;}});
    await new Promise(resolve=>setImmediate(resolve)); assert.ok(providerSignal);
    outer.abort();
    await assert.rejects(request,error=>error.name==='AbortError'&&error.code==='STORYBOOSTER_REQUEST_ABORTED');
    assert.equal(providerSignal.aborted,true);release(valid);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(parsed,0);
}
// Aborted before dispatch: no paid request. Timeout uses the same cleanup.
{
    const f=await setup();f.env.responses([valid]);const controller=new AbortController();controller.abort();
    await assert.rejects(f.auto.diagnoseAutomaticPlot({selection:{},transcript:'test',count:10,preferJev:false,signal:controller.signal}),error=>error.name==='AbortError');
    assert.equal(f.env.requests.length,0);
    let signal;
    await assert.rejects(runAbortableRequest(s=>{signal=s;return new Promise(()=>{});},{timeoutMs:5,timeoutMessage:'synthetic timeout'}),error=>error.code==='STORYBOOSTER_REQUEST_TIMEOUT');
    assert.equal(signal.aborted,true);
}
async function preparedFixture(messages) {
    const f=await setup();const storage=f.m.namespace('core/storage.js'),audit=f.m.namespace('features/audit.js');
    const settings=storage.ensureModuleSettings();settings.enabledFeatures.genre=false;settings.enabledFeatures.character=false;settings.enabledFeatures.plot=true;settings.outputLanguage='en';
    f.env.context.chat=messages;f.auto.setAutomaticPlotEnabled(true);
    const state=storage.ensureChatState(),selection=audit.getBoosterSelection(state);
    f.env.responses([JSON.stringify({event:'An overlooked receipt reveals a small discrepancy in the current investigation.'})]);
    await f.auto.prepareAutomaticPlot({chatId:'chat_A',selection,result:{ratings:{},correctionCodes:[],uncertain:[],plotDecision:{...plot,eligible:true}},transcript:'test',count:10,isCurrent:()=>true,parentAuditId:'SBA-SYNTHETIC'});
    assert.ok(f.m.namespace('core/automatic-plot-state.js').automaticPlotRuntime.pending);
    return {...f,state,selection,trace:f.m.namespace('core/automatic-plot-trace.js')};
}
const ordinary=()=>Array.from({length:10},(_,i)=>[{is_user:true,mes:`Input ${i}`},{is_user:false,mes:`The same drawer is checked again ${i}.`}]).flat();
// A long final instruction stays intact; its returned blocking verdict wins.
{
    const f=await preparedFixture(ordinary());const tail='Do not insert an event. Answer my question first.';
    f.env.context.chat.push({is_user:true,mes:'a'.repeat(5001)+tail});
    f.env.responses([JSON.stringify({plot:{...plot,user_direction_blocks:'yes'}})]);
    await f.auto.automaticPlotGenerationInterceptor([],2048,()=>{},'normal');
    const sent=f.env.requests[0][0].prompt.find(row=>row.role==='user').content;
    assert.ok(sent.endsWith(tail));assert.equal(f.m.runtime.plotPending,false);
    const events=f.trace.readAutomaticPlotTraces()[0].events;
    assert.ok(events.some(e=>e.latestInputComplete===true&&e.latestInputChars>5000));
    assert.equal(events.at(-1).stage,'check_rejected');
}
// Too large to inspect fully: skip before calling the classifier, not crop.
{
    const f=await preparedFixture(ordinary());f.env.context.chat.push({is_user:true,mes:'u'.repeat(60000)});f.env.responses([]);
    await f.auto.automaticPlotGenerationInterceptor([],2048,()=>{},'normal');
    assert.equal(f.env.requests.length,0);assert.equal(f.m.runtime.plotPending,false);
    assert.equal(f.trace.readAutomaticPlotTraces()[0].events.at(-1).stage,'input_incomplete');
}
// Final evidence count is taken from the paired transcript sent right now.
{
    const messages=Array.from({length:10},()=>[{is_user:true,mes:'u'.repeat(1000)},{is_user:false,mes:'r'.repeat(9000)}]).flat();
    const f=await preparedFixture(messages);
    const input=f.m.namespace('features/audit-context.js').buildFinalPlotAuditInput(messages,[]);
    assert.equal(input.reviewedResponses,9);
    f.env.responses([JSON.stringify({plot:{...plot,stalled_replies:[7,8,9]}})]);
    await f.auto.automaticPlotGenerationInterceptor([],2048,()=>{},'normal');
    const sent=f.env.requests[0][0].prompt.find(row=>row.role==='user').content;
    assert.equal([...sent.matchAll(/\[CHAR_RESPONSE_\d+:/g)].length,9);
    assert.equal(f.m.runtime.plotPending,true);
    const n=f.env.context.chat.push({is_user:false,mes:'The receipt is noticed.'})-1;
    await f.env.listeners.get('MESSAGE_RECEIVED')[0](n);assert.equal(f.m.runtime.plotPending,false);
    assert.equal(f.trace.readAutomaticPlotTraces()[0].events.at(-1).stage,'applied');
    assert.equal(f.trace.readAutomaticPlotTraces()[0].parentAuditId,'SBA-SYNTHETIC');
}
// Exhausted legacy recovery stops at three attempts and leaves a private trace.
{
    const f=await preparedFixture(ordinary());let providerSignal,release,calls=0;
    f.env.context.generateRawData=options=>{providerSignal=options.signal;calls++;return new Promise(resolve=>{release=resolve;});};
    const checking=f.auto.automaticPlotGenerationInterceptor([],2048,()=>{},'normal');
    await new Promise(resolve=>setImmediate(resolve));assert.ok(providerSignal);
    await f.env.listeners.get('GENERATION_STOPPED')[0]();
    await checking;assert.equal(providerSignal.aborted,true);assert.equal(f.m.runtime.plotPending,false);
    release(valid);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(f.m.runtime.plotPending,false);
    assert.ok(f.trace.readAutomaticPlotTraces()[0].events.some(e=>e.stage==='cancelled'&&e.reason==='generation_stopped'));
}
// Jev asks only for IDs actually present in the final shortened window too.
{
    const f=await diagnosisFixture();const healthy=await f.run('combined');
    const auto=f.m.namespace('features/automatic-plot.js');
    f.env.context.chat=Array.from({length:10},()=>[{is_user:true,mes:'u'.repeat(1000)},{is_user:false,mes:'r'.repeat(9000)}]).flat();
    auto.setAutomaticPlotEnabled(true);f.env.responses([JSON.stringify({event:'An overlooked receipt reveals a small discrepancy in the current investigation.'})]);
    await auto.prepareAutomaticPlot({chatId:'chat_A',selection:f.selection(),result:{...healthy,plotDecision:{...plot,eligible:true}},transcript:'test',count:10,isCurrent:()=>true});
    f.decide(id=>{
        const field=id.startsWith('plot_')?id.split('__')[0].slice(5):id;
        return ['stagnation','insertion_safe','candidate_fit','user_agency'].includes(field)||id.startsWith('stalled_')?'yes':'no';
    });
    await auto.automaticPlotGenerationInterceptor([],2048,()=>{},'normal');
    const questions=f.bodies.at(-1).questions;
    assert.deepEqual(Object.keys(questions).filter(k=>k.startsWith('stalled_')),['stalled_7','stalled_8','stalled_9']);
    assert.equal(f.m.runtime.plotPending,true);
}
{
    const f=await setup();const storage=f.m.namespace('core/storage.js');const settings=storage.ensureModuleSettings();settings.enabledFeatures.genre=false;settings.enabledFeatures.character=false;
    f.env.context.chat=ordinary();f.auto.setAutomaticPlotEnabled(true);f.env.responses(['','', '']);
    await f.auto.prepareAutomaticPlot({chatId:'chat_A',selection:{},result:{ratings:{},correctionCodes:[]},transcript:'test',count:10,isCurrent:()=>true});
    assert.equal(f.env.requests.length,3);
    const trace=f.m.namespace('core/automatic-plot-trace.js');const events=trace.readAutomaticPlotTraces()[0].events;
    assert.equal(events.at(-1).errorKind,'response_validation');
    const id=trace.readAutomaticPlotTraces()[0].id;
    let refreshes=0;
    const unsubscribe=f.m.namespace('core/audit-run-trace.js').onAuditRunTraceChange(()=>{refreshes++;});
    trace.recordAutomaticPlotTrace(id,'failed',{prompt:'PRIVATE_RP',key:'PRIVATE_KEY',errorKind:'PRIVATE_ERROR'});
    assert.equal(refreshes,1);unsubscribe();
    const report=f.m.namespace('core/audit-run-trace.js').buildAuditRunReport();
    assert.ok(!report.includes('PRIVATE_'));assert.ok(report.includes('[자동 랜덤박스 실행 기록]'));
    f.m.namespace('core/audit-run-trace.js').clearAuditRuns();assert.equal(trace.readAutomaticPlotTraces().length,0);
}
// Repetition/continuity-only repairs cannot request unrelated baseline fields.
{
    const f=await diagnosisFixture();const result=await f.run('combined');result.correctionCodes=['repetition'];
    const feedback=f.feedback('combined',['repetition']);feedback.character_focus_fields=['core_identity'];
    await assert.rejects(f.diagnosis.writeJevFeedback(result,f.selection(),'test',options=>{
        assert.equal(options.jsonSchema.schema.properties.character_focus_fields.maxItems,0);
        return options.parseResult(JSON.stringify(feedback));
    }),error=>error.code==='STORYBOOSTER_INVALID_FIELDS');
}
console.log('dev.13: real retries, cancellation on all four host routes, intact latest input, final evidence numbering, private plot lifecycle logs and correction focus bounds passed.');
