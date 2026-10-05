import { filterResponseMetadata } from './response-metadata.js';
import { filterResponseValidationDetails, filterRequestFailureDetails, requestFailureDetails } from './response-validation.js';
import { buildAutomaticPlotTraceReport, clearAutomaticPlotTraces, onAutomaticPlotTraceChange } from "./automatic-plot-trace.js";
import { STORYBOOSTER_VERSION } from './constants.js';

const STORAGE_KEY = 'storybooster.audit-runs.v1';
const MAX_RUNS = 12;
const MAX_EVENTS = 60;
const STAGES = {
    credential_restore: 'Jev 키 복원 확인', credential_ready: 'Jev 키 준비 확인 완료',
    admitted: '실행 요청', snapshot: '진단 입력 준비',
    jev_facets_request: 'Jev 세부 질문 요청', jev_facets_received: 'Jev 세부 판정 수신',
    jev_evidence_request: 'Jev 항목·답변 근거 요청', jev_evidence_received: 'Jev 항목·답변 근거 수신',
    jev_reduced: 'Jev 최종 판정 정리', jev_fallback: '기존 진단으로 전환',
    legacy_connection: '기존 진단 연결 확인', legacy_request: '기존 진단 요청',
    feedback_connection: '이유·보정문 연결 확인', feedback_request: '이유·보정문 요청',
    compatibility_retry: '응답 형식 재시도', feedback_received: '이유·보정문 검증 완료',
    feedback_fallback: '기본 보정문으로 전환', result_ready: '진단 결과 준비',
    context_changed: '진행 중 상태 변경 감지', saving: '결과·기록 저장', saved: '결과·기록 저장 요청 완료',
    displaying: '화면·주입문 갱신', displayed: '화면·주입문 갱신 완료',
    plot_check: '자동 랜덤박스 확인', plot_finished: '자동 랜덤박스 확인 종료', ended: '실행 종료',
};
const REASONS = {
    completed: '완료', busy: '같은 채팅의 진단이 이미 실행 중입니다.',
    chat_changed: '진단 중 채팅이 바뀌었습니다.', plot_epoch_changed: '자동 플롯 취소·설정 변경으로 작업 상태가 바뀌었습니다.',
    profile_changed: '진단 중 진단 연결 프로필이 바뀌었습니다.', language_changed: '진단 중 출력 언어가 바뀌었습니다.',
    character_changed: '진단 중 캐릭터가 바뀌었습니다.', generation_stopped: '진단 중 응답 생성이 중단되어 작업 상태가 바뀌었습니다.',
    key_changed: '진단 중 Jev 키 상태가 바뀌었습니다.', messages_changed: '진단 중 대화 내용이나 메시지 수가 바뀌었습니다.',
    selection_changed: '진단 중 장르·캐릭터 기준 또는 부스터 설정이 바뀌었습니다.',
    correction_changed: '진단 중 1회 보강 선택이 바뀌었습니다.', automatic_disabled: '자동 진단이 꺼졌습니다.',
    state_missing: '저장할 채팅 상태를 찾지 못했습니다.', request_timeout: '요청 시간이 초과됐습니다.',
    request_failed: '요청 또는 응답 검증에 실패했습니다.', setup_failed: '진단 입력을 준비하지 못했습니다.',
    post_save_failed: '결과 저장 후 화면 갱신 또는 후속 처리에 실패했습니다.',
    unexpected_exit: '완료 단계에 도달하지 못했습니다.', page_reloaded: '완료 전에 페이지가 다시 열렸거나 실행이 중단됐습니다.',
};
const STATUS = { running: '진행 중', completed: '완료', cancelled: '취소', failed: '실패', skipped: '실행 안 함', interrupted: '중단' };
// Ordinary notifications name the guard that fired; detailed traces stay in
// the hidden tools. Only controlled reason text can enter this notification.
export function auditCancellationMessage(reason, epochCause = '') {
    const cause = reason === 'plot_epoch_changed' && epochCause === 'generation_stopped'
        ? '진단 중 응답 생성이 중단되어 작업 상태가 바뀌었습니다.'
        : reason === 'plot_epoch_changed' && epochCause === 'key_changed'
            ? REASONS.key_changed
            : Object.hasOwn(REASONS, reason) ? REASONS[reason] : '진단을 완료하지 못했습니다.';
    return `${cause} 이번 진단 결과 적용이 취소됐어요.`;
}
const NUMBERS = ['messageCount', 'reviewedResponses', 'transcriptChars', 'questionCount', 'timeoutMs',
    'requestCount', 'retryCount', 'promptChars', 'inputChars', 'responseChars', 'responseLength',
    'inputTokens', 'outputTokens', 'interval', 'changedMessages', 'firstChangedIndex',
    'appendedUserMessages', 'appendedAssistantMessages', 'messageCountDelta', 'correctionCount', 'deferredCount'];
const FLAGS = ['credentialReady', 'resultSaved', 'displayUpdated', 'jevFallback', 'feedbackFallback', 'compatibilityFallback'];
const ERROR_KINDS = new Set(['timeout', 'transport', 'response_validation', 'cancelled', 'unknown']);
const EPOCH_CAUSES = new Set(['chat_changed', 'key_changed', 'generation_stopped', 'plot_state_changed', 'profile_changed', 'language_changed', 'genre_changed', 'character_changed']);
const listeners = new Set();
onAutomaticPlotTraceChange(() => {
    for (const listener of listeners) { try { listener(); } catch { /* Optional diagnostics. */ } }
});
const CREDENTIAL_STORAGE_KEY = 'storybooster.credential-events.v1';
const CREDENTIAL_EVENTS = new Set(['restore_started', 'restore_retry', 'restored', 'missing', 'restore_failed', 'save_started', 'save_verified', 'save_failed', 'deleted', 'delete_failed', 'tab_changed', 'tab_deleted', 'disabled', 'unsupported']);
const CREDENTIAL_REASONS = new Set(['account', 'storage', 'decrypt', 'changed', 'unsupported', 'cancelled', 'unknown']);
let credentialEvents = null;
let entries = null;
let sequence = 0;

function storage() { try { return globalThis.sessionStorage || null; } catch { return null; } }
export function readCredentialEvents() {
    if (!credentialEvents) {
        try { credentialEvents = JSON.parse(storage()?.getItem(CREDENTIAL_STORAGE_KEY) || '[]'); } catch { credentialEvents = []; }
    }
    credentialEvents = (Array.isArray(credentialEvents) ? credentialEvents : []).filter(e =>
        CREDENTIAL_EVENTS.has(e?.event) && Number.isSafeInteger(e.at)).slice(-30).map(e => ({
            event: e.event, at: e.at, ...(CREDENTIAL_REASONS.has(e.reason) ? { reason: e.reason } : {}),
        }));
    return credentialEvents.map(e => ({ ...e }));
}
export function recordCredentialEvent(event, reason = '') {
    if (!CREDENTIAL_EVENTS.has(event)) return;
    readCredentialEvents();
    credentialEvents.push({ event, at: Date.now(), ...(CREDENTIAL_REASONS.has(reason) ? { reason } : {}) });
    credentialEvents = credentialEvents.slice(-30);
    try { storage()?.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credentialEvents)); } catch { /* Memory trace remains available. */ }
    for (const listener of listeners) { try { listener(); } catch { /* Optional diagnostics. */ } }
}
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(-Number.MAX_SAFE_INTEGER, value)) : null; }
function metadata(value = {}) {
    const out = { ...filterResponseValidationDetails(value), ...filterResponseMetadata(value), ...filterRequestFailureDetails(value) };
    for (const k of NUMBERS) if (number(value[k]) !== null) out[k] = number(value[k]);
    for (const k of FLAGS) if (typeof value[k] === 'boolean') out[k] = value[k];
    if (['schema', 'plain_json', 'repair_json'].includes(value.attemptMode)) out.attemptMode = value.attemptMode;
    if (ERROR_KINDS.has(value.errorKind)) out.errorKind = value.errorKind;
    if (EPOCH_CAUSES.has(value.epochCause)) out.epochCause = value.epochCause;
    if (['jev', 'legacy'].includes(value.engine)) out.engine = value.engine;
    if (['idle', 'disabled', 'observing', 'deferred', 'preparing', 'ready', 'applied', 'error'].includes(value.plotStatus)) out.plotStatus = value.plotStatus;
    if (Array.isArray(value.contextChanges)) out.contextChanges = [...new Set(value.contextChanges.filter(k => Object.hasOwn(REASONS, k)))];
    return out;
}
function normalize(row) {
    if (!row || typeof row !== 'object' || !/^SBA-[A-Z0-9-]{1,60}$/.test(row.id || '')) return null;
    const startedAt = number(row.startedAt);
    if (startedAt === null) return null;
    return {
        id: row.id, version: /^\d+\.\d+\.\d+(?:-(?:dev|beta)\.\d+)?$/.test(row.version || '') ? row.version : 'unknown',
        startedAt, endedAt: number(row.endedAt), manual: row.manual === true,
        scope: ['genre', 'character', 'combined'].includes(row.scope) ? row.scope : 'combined',
        trigger: ['manual', 'message_received', 'test', 'direct'].includes(row.trigger) ? row.trigger : 'direct',
        status: Object.hasOwn(STATUS, row.status) ? row.status : 'interrupted',
        reason: Object.hasOwn(REASONS, row.reason) ? row.reason : 'unexpected_exit',
        stage: Object.hasOwn(STAGES, row.stage) ? row.stage : 'admitted',
        metrics: metadata(row.metrics),
        events: (Array.isArray(row.events) ? row.events : []).filter(e => Object.hasOwn(STAGES, e?.stage))
            .slice(-MAX_EVENTS).map(e => ({ stage: e.stage, elapsedMs: Math.max(0, number(e.elapsedMs) || 0), ...metadata(e) })),
    };
}
function load() {
    if (entries) return entries;
    try {
        const raw = JSON.parse(storage()?.getItem(STORAGE_KEY) || '[]');
        entries = (Array.isArray(raw) ? raw : []).map(normalize).filter(Boolean).slice(0, MAX_RUNS);
    } catch { entries = []; }
    for (const row of entries) if (row.status === 'running') {
        row.status = 'interrupted'; row.reason = 'page_reloaded'; row.endedAt = Date.now();
    }
    persist();
    return entries;
}
function persist() {
    try { storage()?.setItem(STORAGE_KEY, JSON.stringify(entries || [])); } catch { /* The in-memory trace remains usable. */ }
    for (const listener of listeners) { try { listener(); } catch { /* Diagnostics must never break RP. */ } }
}
export function auditTraceErrorKind(error) {
    const code = String(error?.code || '').toUpperCase();
    if (code.includes('TIMEOUT')) return 'timeout';
    if (code.includes('CANCELLED') || error?.name === 'AbortError') return 'cancelled';
    if (/NETWORK|HTTP|TRANSPORT|UPSTREAM/.test(code)) return 'transport';
    if (/JSON|RESPONSE|OUTPUT|FIELDS|PARSE|RATINGS/.test(code) || error instanceof SyntaxError) return 'response_validation';
    if (['schema_unsupported', 'request_rejected', 'host_request_failed', 'network', 'authentication', 'rate_limit', 'provider_error']
        .includes(requestFailureDetails(error).requestError)) return 'transport';
    return 'unknown';
}
export function beginAuditRun({ manual = false, scope = 'combined', trigger = 'direct' } = {}) {
    load();
    const run = normalize({ id: `SBA-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase(),
        version: STORYBOOSTER_VERSION, startedAt: Date.now(), manual, scope, trigger,
        status: 'running', reason: 'completed', stage: 'admitted', metrics: {}, events: [] });
    entries.unshift(run);
    // Preserve live runs even when the user repeatedly presses a busy test button.
    const keep = new Set(entries.filter(r => r.status === 'running').slice(0, MAX_RUNS));
    let remaining = MAX_RUNS - keep.size;
    entries = entries.filter(r => keep.has(r) || (r.status !== 'running' && remaining-- > 0));
    traceAuditStage(run, 'admitted');
    return run;
}
export function traceAuditStage(run, stage, details = {}) {
    if (!run || run.status !== 'running' || !Object.hasOwn(STAGES, stage)) return;
    const data = metadata(details);
    // The latest metrics describe the accepted result; earlier failures stay
    // intact in their attempt events. Keep errors if only templates succeeded.
    if (stage === 'feedback_received' || (stage === 'result_ready' && run.metrics.feedbackFallback !== true)) {
        for (const key of ['validationCode', 'validationField', 'errorKind', 'attemptMode']) delete run.metrics[key];
    }
    run.stage = stage; Object.assign(run.metrics, data);
    run.events.push({ stage, elapsedMs: Math.max(0, Date.now() - run.startedAt), ...data });
    run.events = run.events.slice(-MAX_EVENTS);
    persist();
}
export function finishAuditRun(run, status, reason = 'completed', details = {}) {
    if (!run || run.status !== 'running') return;
    if (!load().includes(run)) { entries.unshift(run); entries = entries.slice(0, MAX_RUNS); }
    const lastStage = run.stage;
    traceAuditStage(run, 'ended', details);
    run.stage = lastStage;
    run.status = ['completed', 'cancelled', 'failed', 'skipped'].includes(status) ? status : 'failed';
    run.reason = Object.hasOwn(REASONS, reason) ? reason : 'unexpected_exit'; run.endedAt = Date.now();
    persist();
}
export function readAuditRuns() { return load().map(normalize).filter(Boolean); }
export function clearAuditRuns() {
    entries = load().filter(r => r.status === 'running'); persist();
    credentialEvents = [];
    clearAutomaticPlotTraces();
    try { storage()?.setItem(CREDENTIAL_STORAGE_KEY, '[]'); } catch { /* Optional storage. */ }
}
export function onAuditRunTraceChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function auditRunStatusText(row = readAuditRuns().find(r => r.status === 'running') || readAuditRuns()[0]) {
    if (!row) return '아직 진단 실행 기록이 없습니다.';
    const title = row.manual ? '수동진단' : row.trigger === 'test' ? '자동진단 테스트' : '자동진단';
    const elapsed = Math.round(Math.max(0, (row.endedAt ?? Date.now()) - row.startedAt) / 100) / 10;
    return `${title} ${STATUS[row.status]} · ${STAGES[row.stage]} · ${elapsed}초${row.status !== 'running' && row.reason !== 'completed' ? ` · ${REASONS[row.reason]}` : ''}`;
}
export function buildAuditRunReport() {
    const runs = readAuditRuns();
    const credentials = readCredentialEvents();
    const plotReport = buildAutomaticPlotTraceReport();
    if (!runs.length && !credentials.length && !plotReport) return '아직 진단 실행 기록이 없습니다.';
    return ['[STORYBOOSTER AUDIT RUN REPORT]',
        'API 키·롤플 원문·캐릭터 기준·채팅 이름·접속 주소는 포함하지 않습니다.',
        ...runs.flatMap(row => [ '', `[${row.id}] ${new Date(row.startedAt).toLocaleString('ko-KR')}`,
            `버전: ${row.version} · 범위: ${row.scope} · 실행 경로: ${row.trigger}`, auditRunStatusText(row),
            `결과 저장 요청: ${row.metrics.resultSaved === true ? '완료' : '미완료'} · 화면 갱신: ${row.metrics.displayUpdated === true ? '완료' : '미완료'}`,
            `최근 지표: ${JSON.stringify(row.metrics)}`,
            ...row.events.map(e => `+${Math.round(e.elapsedMs / 100) / 10}초 ${STAGES[e.stage]} ${JSON.stringify(metadata(e))}`),
        ]),
        ...(plotReport ? ['', plotReport] : []),
        ...(credentials.length ? ['', '[키 저장·복원 기록]', ...credentials.map(e => `${new Date(e.at).toLocaleString('ko-KR')} ${e.event}${e.reason ? ` · ${e.reason}` : ''}`)] : []),
    ].join('\n');
}
