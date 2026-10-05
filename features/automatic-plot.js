import { buildFinalPlotAuditInput } from "./audit-context.js";
import { startAutomaticPlotTrace, recordAutomaticPlotTrace } from "../core/automatic-plot-trace.js";
import { auditTraceErrorKind } from "../core/audit-run-trace.js";
import { createOperationDiagnostic } from "../core/diagnostics.js";
import { throwIfRequestAborted } from "../core/request-lifecycle.js";
import { plotDecisionReason, plotAuditHoldReason } from './plot-status.js';
import { getBoosterElement } from '../core/dom.js';
import { automaticPlotRuntime, cancelAutomaticPlot } from '../core/automatic-plot-state.js';
import { getCurrentCharacterIdentity, getCurrentChatId, snapshotCurrentChatMessages } from '../core/context.js';
import { getJevKeyRevision, hasJevSessionKey, isJevUsageAllowed, requestJev } from '../core/jev-client.js';
import { requestStructuredJsonWithCompatibility, resolveBackgroundConnectionSnapshot, withRequestTimeout } from '../core/requests.js';
import { extractJsonObject } from '../core/responses.js';
import { eventGenerationPendingTasks, runtime } from '../core/runtime.js';
import { getContext, saveSettingsDebounced } from '../core/sillytavern.js';
import { ensureChatState, ensureModuleSettings, getGlobalAuditInterval, isBoosterFeatureEnabled } from '../core/storage.js';
import { hashStableText } from '../core/text.js';
import { triggerPlotEvent, requestHeadlessPlotEvent, recordPlotHistory, updatePlotHistoryUI } from './plot.js';
import { confidentChoice, createJevAuditState } from './jev-diagnosis.js';
import { getGenreSelectionSignature } from './genre-model.js';

export const PLOT_FIELDS = ['stagnation', 'quiet_progress', 'existing_thread_progress', 'insertion_safe', 'user_direction_blocks', 'duplicate'];
const CHECKS = {
    stagnation: 'Have the last several replies mechanically repeated interactions without meaningful changes in information, relationship, action or situation?',
    quiet_progress: 'Is quiet daily life or emotional interaction still meaningfully progressing? Quietness or lack of dramatic action alone is not stagnation.',
    existing_thread_progress: 'Does a current unresolved question, promise, action or conflict already provide a concrete next step that should be continued before adding an event?',
    insertion_safe: 'Can a modest ordinary random event begin in the next reply without interrupting a critical action, emotional payoff, or response the user is owed?',
    user_direction_blocks: 'Does the latest user input request a quiet scene, specify a competing direction, ask a question requiring a direct answer, or take an action requiring an immediate response before a new event?',
    duplicate: 'Would the proposed event repeat an unfinished event in the roleplay or a previous suggestion in history? The candidate itself is not a previous event. Suggestions are not proof that events occurred.',
};

// Independent timing observations, combined by explicit protective gates.
// A meaningful change in any progress channel prevents an automatic event.
export const PLOT_SUBCHECKS = {
    stagnation: [
        ['information_static', 'Have the recent replies added no meaningful information or discovery?'],
        ['action_static', 'Have relevant actions or goals made no meaningful progress?'],
        ['relationship_static', 'Have trust, distance, feelings and understanding remained meaningfully unchanged?'],
    ],
    quiet_progress: [
        ['daily_progress', 'Is ordinary daily interaction moving forward in a meaningful way?'],
        ['emotional_progress', 'Is emotional expression or processing still developing?'],
        ['understanding_progress', 'Is mutual understanding or relational distance changing meaningfully?'],
    ],
    existing_thread_progress: [
        ['unfinished_thread', 'Does an established unresolved thread provide a concrete next step?'],
        ['ongoing_action', 'Does an ongoing action need its immediate continuation before a new event?'],
        ['unresolved_exchange', 'Does an unresolved exchange need a response or payoff before a new event?'],
    ],
    insertion_safe: [
        ['critical_action_safe', 'Can a modest ordinary event begin without interrupting a critical action?'],
        ['emotional_payoff_safe', 'Can it begin without interrupting an emotional exchange or earned payoff?'],
        ['scene_transition_safe', 'Can it begin without forcing a scene transition or deciding user actions?'],
    ],
    user_direction_blocks: [
        ['competing_direction', 'Does the latest user input request quietness or a competing scene direction?'],
        ['answer_due', 'Does the latest user input ask a question that should be answered before a new event?'],
        ['reaction_due', 'Does the latest user action require an immediate response before a new event?'],
    ],
    duplicate: [
        ['unfinished_duplicate', 'Would the candidate repeat an unfinished event? Without a candidate judge only established event repetition; absent history alone is not a duplicate.'],
        ['history_duplicate', 'Would it repeat the content or function of a recent suggestion? Suggestions are not proof of actual events.'],
        ['beat_duplicate', 'Would it merely replay the same recent event beat without a meaningful new development?'],
    ],
};

export function ensureAutomaticPlotSettings(state = ensureChatState()) {
    if (!state.automaticPlot || typeof state.automaticPlot !== 'object' || Array.isArray(state.automaticPlot)) state.automaticPlot = {};
    const p = state.automaticPlot;
    if (typeof p.enabled !== 'boolean') p.enabled = false;
    delete p.cooldownReplies;
    if (!Number.isSafeInteger(p.lastAppliedCount) || p.lastAppliedCount < 0) p.lastAppliedCount = 0;
    if (!['idle', 'disabled', 'observing', 'deferred', 'preparing', 'ready', 'applied', 'error'].includes(p.status)) p.status = 'idle';
    // Older builds persisted a blanket hold message that no longer reflects
    // current plot gates. Do not invent a present cause from that old record.
    if (p.status === 'deferred' && typeof p.lastDecision === 'string' && /기다립니다\.$/.test(p.lastDecision)) {
        p.lastDecision = '이번에는 자동 랜덤박스를 준비하지 않았습니다.';
    }
    // Candidates and requests are intentionally not persisted across reloads.
    if (['observing', 'preparing', 'ready'].includes(p.status) && automaticPlotRuntime.state !== state) {
        p.status = 'idle'; p.lastDecision = '';
    }
    return p;
}

export function getAutomaticPlotStatusText(p = ensureAutomaticPlotSettings()) {
    if (!p.enabled || ['idle', 'disabled'].includes(p.status)) return '';
    const labels = { observing: '전개 정체 확인 중',
        deferred: '현재 흐름 유지 · 이번에는 사건을 넣지 않습니다', preparing: '사건 후보 준비 중',
        ready: '랜덤박스 준비됨 · 다음 응답 전에 최신 입력을 확인합니다', applied: '1회 반영 완료', error: '준비 실패 · 현재 흐름 유지' };
    if (p.status === 'deferred' && p.lastDecision) return p.lastDecision;
    const label = labels[p.status];
    return label ? [label, p.lastDecision].filter(Boolean).join(' · ') : '';
}

export function updateAutomaticPlotStatus() {
    const element = getBoosterElement('rp-automatic-plot-status');
    if (element) {
        const text = getAutomaticPlotStatusText();
        element.textContent = text;
        element.hidden = !text;
    }
    const cancel = getBoosterElement('rp-automatic-plot-cancel');
    if (cancel) {
        const canCancel = automaticPlotRuntime.state === ensureChatState() && Boolean(automaticPlotRuntime.pending || automaticPlotRuntime.checking);
        cancel.hidden = !canCancel; cancel.disabled = !canCancel;
    }
}

export function cancelPreparedAutomaticPlot() {
    if (automaticPlotRuntime.state !== ensureChatState() || !(automaticPlotRuntime.pending || automaticPlotRuntime.checking)) return false;
    cancelAutomaticPlot();
    const prefs = ensureAutomaticPlotSettings();
    prefs.status = 'deferred'; prefs.lastDecision = '이번 랜덤박스를 취소했습니다. 자동 랜덤박스 설정은 유지됩니다.';
    updateAutomaticPlotStatus(); saveSettingsDebounced();
    toastr?.info?.('이번 랜덤박스를 취소했어요.', '스토리부스터');
    return true;
}

export function automaticPlotEnabled(state = ensureChatState()) {
    return getCurrentChatId() !== 'no-chat-open' && isBoosterFeatureEnabled('plot') && ensureAutomaticPlotSettings(state).enabled && getGlobalAuditInterval() > 0;
}
export function assistantCount(messages = getContext()?.chat || []) {
    return messages.filter(m => m && !m.is_user && !m.is_system).length;
}
export function roleplayFingerprint(messages = getContext()?.chat || []) {
    return hashStableText(JSON.stringify(messages.map(m => [Boolean(m?.is_user), Boolean(m?.is_system), typeof m?.name === "string" ? m.name : "", typeof m?.mes === "string" ? m.mes : ""])));
}

export function parsePlotDecision(value, count) {
    try {
        const p = typeof value === 'string' ? extractJsonObject(value).plot : value?.plot;
        if (!p || PLOT_FIELDS.some(k => !['yes', 'no', 'uncertain'].includes(p[k])) || !Array.isArray(p.stalled_replies)) return null;
        const evidence = [...new Set(p.stalled_replies)].filter(n => Number.isSafeInteger(n) && n >= 1 && n <= count).sort((a,b) => a-b);
        // Require all three latest observed replies to substantiate stagnation.
        const stalled = count >= 5 && [count-2, count-1, count].every(n => evidence.includes(n));
        return { ...Object.fromEntries(PLOT_FIELDS.map(k => [k, p[k]])), stalled_replies: evidence,
            eligible: stalled && p.stagnation === 'yes' && p.quiet_progress === 'no' && p.existing_thread_progress === 'no' && p.insertion_safe === 'yes' && p.user_direction_blocks === 'no' && p.duplicate === 'no' };
    } catch { return null; }
}

export function addPlotAuditSchema(schema) {
    const properties = Object.fromEntries(PLOT_FIELDS.map(k => [k, { type: 'string', enum: ['yes', 'no', 'uncertain'] }]));
    properties.stalled_replies = { type: 'array', items: { type: 'integer' }, maxItems: 10 };
    return { ...schema, schema: { ...schema.schema,
        properties: { ...schema.schema.properties, plot: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } },
        required: [...schema.schema.required, 'plot'] } };
}

export function plotAuditPrompt() {
    return [
        'ADDITIONAL AUTOMATIC PLOT DIAGNOSIS: Judge only the need for an event, not an event itself. Confirmed genre/character problems require correction first. Deferred genre/character judgments alone neither block nor authorize an event. Independently establish actual stagnation and safe insertion from the supplied scene; if relevant scene context or user intent is unclear, use uncertain.',
        ...PLOT_FIELDS.map(k => `${k}: ${CHECKS[k]} Use yes/no/uncertain.`),
        'Return these values in a plot object, plus stalled_replies as actual CHAR_RESPONSE integer IDs demonstrating no meaningful progress. Do not fabricate evidence. An unanswered user action/question takes priority. Uncertain evidence never authorizes an event.',
    ].join('\n');
}

export async function diagnoseAutomaticPlot({ selection, transcript, count, candidate = '', preferJev = true, signal, history = [], traceId = '' }) {
    throwIfRequestAborted(signal);
    if (preferJev && isJevUsageAllowed() && hasJevSessionKey()) {
        const questions = Object.fromEntries(PLOT_FIELDS.map(k => [k, { type: 'choice', instructions: CHECKS[k], criteria: { yes: 'Clearly supported by supplied context.', no: 'Clearly not the case in supplied context.', uncertain: 'Insufficient or ambiguous context.' } }]));
        for (const [field, checks] of Object.entries(PLOT_SUBCHECKS)) for (const [id, question] of checks) {
            questions[`plot_${field}__${id}`] = { type: 'choice', instructions: question,
                criteria: { yes: 'Clearly supported by supplied context.', no: 'Clearly not the case.', uncertain: 'Relevant context is ambiguous or insufficient.' } };
        }
        for (let n = Math.max(1, count-2); n <= count; n++) questions[`stalled_${n}`] = {
            type: 'choice', instructions: `In CHAR_RESPONSE_${n}, is the same interaction mechanically repeated without meaningful change in information, action, situation or relationship? Use adjacent replies for comparison.`,
            criteria: { yes: 'Clearly stalled repetition without meaningful progress.', no: 'Meaningful progress, including quiet or emotional progress.', uncertain: 'Insufficient comparison context.' },
        };
        if (candidate) {
            questions.candidate_fit = { type: 'choice', instructions: 'Is the supplied candidate a modest, coherent ordinary random event compatible with known facts, characterization, genre and the latest user input?', criteria: { yes: 'Compatible without invented retroactive facts or forced scene changes.', no: 'Conflicting or disruptive.', uncertain: 'Compatibility cannot be established.' } };
            questions.user_agency = { type: 'choice', instructions: 'Does the candidate leave the user\'s dialogue, feelings, consent, decisions and actions entirely undecided?', criteria: { yes: 'User can freely respond.', no: 'Prescribes or assumes a user reaction or decision.', uncertain: 'Ambiguous.' } };
        }
        recordAutomaticPlotTrace(traceId, candidate ? 'checking' : 'deciding', { engine: 'jev', reviewedResponses: count });
        const result = await requestJev({ ...createJevAuditState(selection, transcript), candidate, previous_suggestions: history }, questions, { signal, timeoutMs: candidate ? 10000 : 25000 });
        const p = Object.fromEntries(PLOT_FIELDS.map(k => [k, confidentChoice(result.answers[k]) ? result.answers[k].choice : 'uncertain']));
        for (const [field, checks] of Object.entries(PLOT_SUBCHECKS)) {
            const values = checks.map(([id]) => { const a = result.answers[`plot_${field}__${id}`]; return confidentChoice(a) ? a.choice : 'uncertain'; });
            if (values.includes('uncertain')) p[field] = 'uncertain';
            else if (['stagnation', 'insertion_safe'].includes(field)) {
                if (values.includes('no')) p[field] = 'no';
            } else if (values.includes('yes')) p[field] = 'yes';
        }
        p.stalled_replies = Object.keys(questions).filter(k => k.startsWith('stalled_') && confidentChoice(result.answers[k]) && result.answers[k].choice === 'yes').map(k => Number(k.slice(8)));
        if (candidate && (!confidentChoice(result.answers.candidate_fit) || result.answers.candidate_fit.choice !== 'yes' || !confidentChoice(result.answers.user_agency) || result.answers.user_agency.choice !== 'yes')) p.insertion_safe = 'uncertain';
        return parsePlotDecision({ plot: p }, count);
    }
    const properties = Object.fromEntries(PLOT_FIELDS.map(k => [k, { type: 'string', enum: ['yes', 'no', 'uncertain'] }]));
    properties.stalled_replies = { type: 'array', items: { type: 'integer' }, maxItems: 10 };
    if (candidate) {
        properties.candidate_fit = { type: 'boolean' };
        properties.user_agency_preserved = { type: 'boolean' };
    }
    const diagnostic = createOperationDiagnostic({ task: 'automatic_plot_check', responseLength: 900 });
    recordAutomaticPlotTrace(traceId, candidate ? 'checking' : 'deciding', { engine: 'legacy', reviewedResponses: count });
    const result = await requestStructuredJsonWithCompatibility({
        prompt: `${plotAuditPrompt()}\n${candidate ? 'Also return plot.candidate_fit and plot.user_agency_preserved. Both must be true only when this modest event fits supplied facts and the latest user input and leaves every user action, feeling and choice undecided.' : ''}\nSelected baseline: ${selection.characterBaseline || ''}\nPrimary genre: ${selection.primaryGenre?.label || ''}\nCandidate: ${candidate}\nRecent events: ${JSON.stringify(history)}`,
        transcript, responseLength: 900,
        connectionSnapshot: await resolveBackgroundConnectionSnapshot(ensureModuleSettings().analysisProfileId),
        task: 'automatic_plot_check', diagnostic, signal,
        onFallback: ({ error }) => recordAutomaticPlotTrace(traceId, 'retry', { engine: 'legacy', requestCount: diagnostic.requestCount, retryCount: diagnostic.retryCount, errorKind: auditTraceErrorKind(error) }),
        jsonSchema: { name: 'storybooster_automatic_plot_check', strict: true, schema: { type: 'object', properties: { plot: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } }, required: ['plot'], additionalProperties: false } },
        parseResult: raw => {
            throwIfRequestAborted(signal);
            const data = extractJsonObject(raw);
            const decision = parsePlotDecision(data, count);
            if (!decision) throw Object.assign(new Error('자동 플롯 판정 항목이 누락되거나 잘못됐습니다.'), { code: 'STORYBOOSTER_INVALID_FIELDS' });
            if (candidate && (data.plot.candidate_fit !== true || data.plot.user_agency_preserved !== true)) decision.eligible = false;
            return decision;
        },
    });
    return result;
}

export function healthyAuditForAutomaticPlot(selection, result) {
    // A deferred diagnostic is not a confirmed defect or a healthy verdict.
    // Any dimension may be deferred; the independent plot checks must still
    // establish stagnation, scene fit and user intent before preparing an event.
    if (!result || result.correctionCodes?.length) return false;
    const deferred = new Set(result.uncertain || []);
    if (Object.entries(result.ratings || {}).some(([code, rating]) =>
        ['weak', 'drifted', 'biased'].includes(rating) || (rating === 'attention' && !deferred.has(code)))) return false;
    const genre = selection.primaryGenre ? ['primary_genre', 'genre_expression', 'scene_density'] : [];
    const character = selection.characterEnabled ? ['character_consistency', 'character_interpretation', 'char_agency', 'relationship', 'continuity', 'repetition'] : [];
    // These dimensions explicitly allow na when their interaction/scene
    // opportunity does not exist. That is neither a defect nor a plot decision.
    const canBeInapplicable = new Set(['char_agency', 'relationship', 'continuity']);
    const acceptable = (code, normalRatings) => normalRatings.includes(result.ratings?.[code]) ||
        (result.ratings?.[code] === 'na' && canBeInapplicable.has(code)) ||
        (deferred.has(code) && ['attention', 'na'].includes(result.ratings?.[code]));
    return [...genre, ...character].every(code => acceptable(code, ['present', 'stable'])) &&
        (!selection.supportGenre || acceptable('support_texture', ['present', 'dormant']));
}

export async function prepareAutomaticPlot({ chatId, selection, result, transcript, count, isCurrent, parentAuditId = '' }) {
    const state = ensureChatState(chatId);
    const prefs = ensureAutomaticPlotSettings(state);
    const traceId = automaticPlotEnabled(state) && isCurrent() ? startAutomaticPlotTrace(parentAuditId) : '';
    if (!automaticPlotEnabled(state) || !isCurrent() || !healthyAuditForAutomaticPlot(selection, result)) {
        recordAutomaticPlotTrace(traceId, 'blocked', { reason: 'confirmed_problem' });
        if (chatId === getCurrentChatId()) cancelAutomaticPlot();
        prefs.status = 'deferred'; prefs.lastDecision = plotAuditHoldReason(result); updateAutomaticPlotStatus(); saveSettingsDebounced(); return;
    }
    if (automaticPlotRuntime.generating || automaticPlotRuntime.pending || runtime.plotPending || eventGenerationPendingTasks.size) { recordAutomaticPlotTrace(traceId, 'blocked', { reason: 'busy' }); return; }
    if (prefs.lastAppliedCount && assistantCount() - prefs.lastAppliedCount < getGlobalAuditInterval()) { recordAutomaticPlotTrace(traceId, 'blocked', { reason: 'cooldown' }); prefs.status = 'deferred'; prefs.lastDecision = '랜덤박스가 최근 반영되어 이번에는 자동 랜덤박스를 준비하지 않습니다.'; updateAutomaticPlotStatus(); saveSettingsDebounced(); return; }
    const epoch = automaticPlotRuntime.epoch;
    const keyRevision = getJevKeyRevision();
    const current = () => isCurrent() && epoch === automaticPlotRuntime.epoch && keyRevision === getJevKeyRevision() && automaticPlotEnabled(state) && !runtime.plotPending && !eventGenerationPendingTasks.size;
    automaticPlotRuntime.generating = true;
    automaticPlotRuntime.state = state;
    const controller = new AbortController();
    automaticPlotRuntime.controller = controller;
    automaticPlotRuntime.preparingTraceId = traceId;
    prefs.status = 'observing'; updateAutomaticPlotStatus();
    try {
        let decision = result.plotDecision;
        if (!decision) {
            const preferJev = isJevUsageAllowed() && hasJevSessionKey();
            try { decision = await diagnoseAutomaticPlot({ selection, transcript, count, preferJev, signal: controller.signal, history: state.plotHistory?.slice(0, 3), traceId }); }
            catch (error) { if (!current()) return; if (!preferJev || controller.signal.aborted) throw error; recordAutomaticPlotTrace(traceId, 'legacy_fallback', { errorKind: auditTraceErrorKind(error) }); decision = await diagnoseAutomaticPlot({ selection, transcript, count, preferJev: false, signal: controller.signal, history: state.plotHistory?.slice(0, 3), traceId }); }
        }
        if (!current()) return;
        prefs.lastDecision = plotDecisionReason(decision);
        if (!decision?.eligible || !current()) { recordAutomaticPlotTrace(traceId, 'blocked', { reason: 'not_eligible' }); prefs.status = 'deferred'; return; }
        recordAutomaticPlotTrace(traceId, 'generating');
        prefs.status = 'preparing'; updateAutomaticPlotStatus();
        const candidate = await requestHeadlessPlotEvent({ chatId, selection, isCurrent: current, signal: controller.signal });
        if (!candidate || !current()) return;
        const snapshot = snapshotCurrentChatMessages();
        automaticPlotRuntime.pending = { chatId, epoch, traceId, selection, selectionSignature: getGenreSelectionSignature(selection),
            characterKey: getCurrentCharacterIdentity()?.key || '', keyRevision,
            snapshotLength: snapshot.length, fingerprint: roleplayFingerprint(snapshot), count,
            createdAt: Date.now(), candidate };
        prefs.status = 'ready';
        recordAutomaticPlotTrace(traceId, 'prepared');
        try { toastr?.info?.('랜덤박스가 준비됐어요. 플롯 부스터에서 취소할 수 있어요.', '스토리부스터'); } catch { /* Notification is optional. */ }
    } catch (error) { recordAutomaticPlotTrace(traceId, 'failed', { errorKind: auditTraceErrorKind(error) }); if (current()) { prefs.status = 'error'; prefs.lastDecision = '자동 사건 준비 실패 · 현재 롤플 유지'; } }
    finally { if (automaticPlotRuntime.controller === controller) automaticPlotRuntime.controller = null; automaticPlotRuntime.preparingTraceId = null; automaticPlotRuntime.generating = false; updateAutomaticPlotStatus(); saveSettingsDebounced(); }
}

export async function automaticPlotGenerationInterceptor(_chat, _contextSize, _abort, type) {
    // Never create RP turns. Quiet/internal requests, swipes and continuations
    // cannot consume or trigger an automatic random box.
    if (type !== 'normal') return;
    // A failed/aborted prior generation must not reuse its automatic instruction.
    if (automaticPlotRuntime.armed) cancelAutomaticPlot();
    const pending = automaticPlotRuntime.pending;
    if (!pending || automaticPlotRuntime.checking) return;
    automaticPlotRuntime.pending = null;
    const state = ensureChatState();
    const prefs = ensureAutomaticPlotSettings(state);
    const snapshot = snapshotCurrentChatMessages();
    const prefixMatches = snapshot.length >= pending.snapshotLength && roleplayFingerprint(snapshot.slice(0, pending.snapshotLength)) === pending.fingerprint;
    const newMessages = snapshot.slice(pending.snapshotLength);
    const valid = () => pending.chatId === getCurrentChatId() && pending.epoch === automaticPlotRuntime.epoch &&
        pending.characterKey === (getCurrentCharacterIdentity()?.key || '') && getJevKeyRevision() === pending.keyRevision &&
        automaticPlotEnabled(state) && !runtime.plotPending && !eventGenerationPendingTasks.size &&
        !(state.genreAnchor?.correctionRemaining > 0) && Date.now() - pending.createdAt < 10 * 60 * 1000;
    if (!valid() || !prefixMatches || newMessages.length > 1 || newMessages.some(m => !m.is_user || m.is_system)) { recordAutomaticPlotTrace(pending.traceId, 'cancelled', { reason: 'context_changed' }); prefs.status = 'deferred'; prefs.lastDecision = '대화나 설정이 바뀌었거나 후보가 만료되어 준비한 사건을 취소했습니다.'; updateAutomaticPlotStatus(); saveSettingsDebounced(); return; }
    // Fetch current selection without importing audit.js (avoid a cycle).
    if (!automaticPlotRuntime.getSelection || getGenreSelectionSignature(automaticPlotRuntime.getSelection()) !== pending.selectionSignature) { recordAutomaticPlotTrace(pending.traceId, 'cancelled', { reason: 'context_changed' }); prefs.status = 'deferred'; prefs.lastDecision = '진단 기준이 바뀌어 준비한 사건을 취소했습니다.'; updateAutomaticPlotStatus(); saveSettingsDebounced(); return; }
    automaticPlotRuntime.checking = true;
    automaticPlotRuntime.checkingTraceId = pending.traceId;
    const controller = new AbortController();
    automaticPlotRuntime.controller = controller;
    const freshFingerprint = roleplayFingerprint(snapshot);
    try {
        const input = buildFinalPlotAuditInput(snapshot, newMessages);
        recordAutomaticPlotTrace(pending.traceId, 'checking', { reviewedResponses: input.reviewedResponses,
            transcriptChars: input.transcript.length, latestInputChars: input.latestInputChars,
            latestInputComplete: input.latestInputComplete, transcriptTrimmed: input.transcriptTrimmed, timeoutMs: 12000 });
        if (!input.latestInputComplete || input.reviewedResponses < 5) {
            prefs.status = 'deferred'; prefs.lastDecision = '최신 입력과 비교할 답변을 충분히 확인할 수 없어 이번 사건을 건너뜁니다.';
            recordAutomaticPlotTrace(pending.traceId, 'input_incomplete', { reason: 'insufficient_input' });
            return;
        }
        const decision = await withRequestTimeout(diagnoseAutomaticPlot({ selection: pending.selection,
            transcript: input.transcript, count: input.reviewedResponses, traceId: pending.traceId,
            candidate: pending.candidate.event, history: state.plotHistory?.slice(0, 3), signal: controller.signal }),
            '자동 사건 확인 시간이 초과되어 이번 응답은 그대로 진행합니다.', 12000, () => controller.abort());
        const contextChanged = !valid() || controller.signal.aborted || roleplayFingerprint() !== freshFingerprint ||
            getGenreSelectionSignature(automaticPlotRuntime.getSelection()) !== pending.selectionSignature;
        if (!decision?.eligible || contextChanged) {
            recordAutomaticPlotTrace(pending.traceId, contextChanged ? 'cancelled' : 'check_rejected', { reason: contextChanged ? 'context_changed' : 'not_eligible' });
            if (pending.epoch === automaticPlotRuntime.epoch && pending.chatId === getCurrentChatId()) {
                prefs.status = 'deferred';
                prefs.lastDecision = contextChanged ? '대화나 설정이 바뀌어 준비한 사건을 취소했습니다.' : plotDecisionReason(decision, { prepared: true });
                try { toastr?.info?.('최신 입력을 확인해 이번 랜덤박스는 적용하지 않았어요.', '스토리부스터'); } catch { /* Optional. */ }
            }
            return;
        }
        triggerPlotEvent(pending.candidate.event, 'automatic_random');
        automaticPlotRuntime.armed = { chatId: pending.chatId, traceId: pending.traceId, prompt: runtime.currentPlotInjectionText, count: assistantCount(), cancelled: false };
        recordPlotHistory({ text: pending.candidate.event, categoryId: pending.candidate.category.id, mode: 'free', surpriseType: 'random', chatId: pending.chatId, updateUi: false });
        updatePlotHistoryUI();
        prefs.status = 'ready';
        recordAutomaticPlotTrace(pending.traceId, 'armed');
    } catch (error) {
        recordAutomaticPlotTrace(pending.traceId, 'failed', { errorKind: auditTraceErrorKind(error) });
        if (pending.epoch === automaticPlotRuntime.epoch && pending.chatId === getCurrentChatId()) {
            prefs.status = 'deferred'; prefs.lastDecision = '최종 확인에 실패하거나 시간이 초과되어 이번 사건을 건너뜁니다.';
        }
    }
    finally { controller.abort(); automaticPlotRuntime.controller = null; automaticPlotRuntime.checking = false; automaticPlotRuntime.checkingTraceId = null; updateAutomaticPlotStatus(); saveSettingsDebounced(); }
}

export function consumeAutomaticPlot(messageId) {
    const armed = automaticPlotRuntime.armed;
    if (!armed || armed.chatId !== getCurrentChatId()) return;
    const message = getContext()?.chat?.[Number(messageId)];
    if (!message || message.is_user || message.is_system) return;
    if (!armed.cancelled) {
        recordAutomaticPlotTrace(armed.traceId, 'applied');
        const p = ensureAutomaticPlotSettings();
        p.lastAppliedCount = assistantCount(); p.status = 'applied'; updateAutomaticPlotStatus();
        saveSettingsDebounced();
    }
    automaticPlotRuntime.armed = null;
}

export function setAutomaticPlotEnabled(value) {
    ensureAutomaticPlotSettings().enabled = Boolean(value);
    cancelAutomaticPlot(); updateAutomaticPlotStatus(); saveSettingsDebounced();
}
