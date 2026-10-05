import { STORYBOOSTER_VERSION } from './constants.js';

// Separate from diagnosis completion: a candidate can be used on a later turn.
const STORAGE_KEY = 'storybooster.automatic-plot-runs.v1';
const STAGES = { admitted: '자동 랜덤박스 확인 시작', blocked: '보정·대기 조건으로 준비 안 함',
    deciding: '사건 필요성 판정', legacy_fallback: '기본 모델로 재확인', retry: '응답 형식 복구',
    generating: '후보 생성', prepared: '후보 준비 완료', checking: '최신 입력·후보 최종 확인',
    check_rejected: '최종 판정으로 사건 사용 안 함', input_incomplete: '입력 한도로 사건 사용 안 함',
    armed: '다음 응답용 주입 준비', applied: '응답 수신·1회 적용 종료',
    cancelled: '후보·주입 취소', failed: '요청·검증 실패' };
const NUMBERS = ['reviewedResponses', 'transcriptChars', 'latestInputChars', 'requestCount', 'retryCount', 'timeoutMs'];
const FLAGS = ['latestInputComplete', 'transcriptTrimmed'];
const REASONS = new Set(['chat_changed', 'key_changed', 'generation_stopped', 'plot_state_changed', 'profile_changed', 'language_changed', 'genre_changed', 'character_changed', 'context_changed', 'confirmed_problem', 'not_eligible', 'busy', 'cooldown', 'insufficient_input']);
const ERRORS = new Set(['timeout', 'cancelled', 'transport', 'response_validation', 'unknown']);
let entries;
let sequence = 0;
const listeners = new Set();
export function onAutomaticPlotTraceChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
function metadata(value = {}) {
    const out = {};
    for (const key of NUMBERS) if (typeof value[key] === 'number' && Number.isFinite(value[key])) out[key] = Math.max(0, value[key]);
    for (const key of FLAGS) if (typeof value[key] === 'boolean') out[key] = value[key];
    if (['jev', 'legacy'].includes(value.engine)) out.engine = value.engine;
    if (ERRORS.has(value.errorKind)) out.errorKind = value.errorKind;
    if (REASONS.has(value.reason)) out.reason = value.reason;
    return out;
}
function normalize(row) {
    if (!/^SBP-[A-Z0-9-]{1,70}$/.test(row?.id || '') || !Number.isSafeInteger(row.at)) return null;
    return { id: row.id, at: row.at, version: /^\d+\.\d+\.\d+(?:-(?:dev|beta)\.\d+)?$/.test(row.version) ? row.version : 'unknown',
        parentAuditId: /^SBA-[A-Z0-9-]{1,60}$/.test(row.parentAuditId || '') ? row.parentAuditId : '',
        events: (Array.isArray(row.events) ? row.events : []).filter(e => Object.hasOwn(STAGES, e?.stage)).slice(-40)
            .map(e => ({ stage: e.stage, elapsedMs: typeof e.elapsedMs === 'number' && Number.isFinite(e.elapsedMs) ? Math.max(0, e.elapsedMs) : 0, ...metadata(e) })),
    };
}
function storage() { try { return globalThis.sessionStorage || null; } catch { return null; } }
function load() {
    if (!entries) {
        try { entries = JSON.parse(storage()?.getItem(STORAGE_KEY) || '[]'); } catch { entries = []; }
        entries = (Array.isArray(entries) ? entries : []).map(normalize).filter(Boolean).slice(0, 12);
    }
    return entries;
}
function persist() {
    try { storage()?.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* Memory remains useful. */ }
    for (const listener of listeners) { try { listener(); } catch { /* Diagnostics must never block generation. */ } }
}
export function startAutomaticPlotTrace(parentAuditId = '') {
    const row = normalize({ id: `SBP-${Date.now().toString(36)}-${(++sequence).toString(36)}`.toUpperCase(), at: Date.now(), version: STORYBOOSTER_VERSION, parentAuditId, events: [] });
    load().unshift(row); entries = entries.slice(0, 12);
    recordAutomaticPlotTrace(row.id, 'admitted');
    return row.id;
}
export function recordAutomaticPlotTrace(id, stage, details = {}) {
    const row = load().find(r => r.id === id);
    if (!row || !Object.hasOwn(STAGES, stage)) return;
    row.events.push({ stage, elapsedMs: Math.max(0, Date.now() - row.at), ...metadata(details) });
    row.events = row.events.slice(-40); persist();
}
export function clearAutomaticPlotTraces() { entries = []; persist(); }
export function readAutomaticPlotTraces() { return load().map(normalize).filter(Boolean); }
export function buildAutomaticPlotTraceReport() {
    const rows = readAutomaticPlotTraces();
    if (!rows.length) return '';
    return ['[자동 랜덤박스 실행 기록]', ...rows.flatMap(row => ['', `[${row.id}] ${new Date(row.at).toLocaleString('ko-KR')} · ${row.version}`,
        ...(row.parentAuditId ? [`연결된 진단: ${row.parentAuditId}`] : []),
        ...row.events.map(e => `+${Math.round(e.elapsedMs / 100) / 10}초 ${STAGES[e.stage]} ${JSON.stringify(metadata(e))}`),
    ])].join('\n');
}
