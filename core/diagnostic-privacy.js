// Shareable error reports contain controlled failure descriptions and shapes,
// never upstream error prose, model values, or unknown response field names.
import { CHARACTER_BASELINE_FIELDS, GENRE_AUDIT_CODES } from './constants.js';
import { filterRequestFailureDetails, filterResponseValidationDetails, requestFailureDetails } from './response-validation.js';

const FIELD_NAMES = new Set([
    'response', 'fields', 'changed_fields', 'has_changes', 'revision_note', 'change_summary',
    'boost_anchor', 'boost_anchor_display', 'event', 'character_correction', 'character_focus_fields',
    'deferred_dimensions', 'repetition_matches', 'problem_facets', 'reasons', 'corrections', 'next_corrections',
    ...CHARACTER_BASELINE_FIELDS.flatMap(({ id }) => [id, `fields.${id}`]),
    ...GENRE_AUDIT_CODES.flatMap(id => ['', '_evidence', '_failure_evidence', '_positive_evidence',
        '_reason', '_opportunity', '_identifiable', '_severe', '_facets'].map(suffix => id + suffix)),
    ...['problem_facets', 'reasons', 'corrections', 'next_corrections'].flatMap(group => GENRE_AUDIT_CODES.map(id => `${group}.${id}`)),
]);
export function isDiagnosticFieldName(value) {
    return typeof value === 'string' && (FIELD_NAMES.has(value) ||
        filterResponseValidationDetails({ validationField: value }).validationField === value);
}
function safeFields(value) {
    return (Array.isArray(value) ? value : []).filter(isDiagnosticFieldName).slice(0, 40);
}
function safeShapes(value) {
    return (Array.isArray(value) ? value : []).filter(item => {
        if (typeof item !== 'string') return false;
        const m = item.match(/^([A-Za-z0-9_.]+):(object|boolean|number|undefined|string\(\d{1,9}\)|array\(\d{1,9}\))$/);
        return m && isDiagnosticFieldName(m[1]);
    }).slice(0, 40);
}
const ERROR_MESSAGES = Object.freeze({
    STORYBOOSTER_CHARACTER_BASELINE_INCOMPLETE: '캐릭터 기준의 필수 내용이 부족합니다.',
    STORYBOOSTER_CONTEXT_CHANGED: '요청 중 작업 대상이 변경되었습니다.',
    STORYBOOSTER_EMPTY_STRUCTURED_OUTPUT: '표시할 최종 응답이 비어 있습니다.',
    STORYBOOSTER_INCOMPLETE_JSON: '완성된 JSON 응답을 받지 못했습니다.',
    STORYBOOSTER_INCOMPLETE_RATINGS: '진단 판정 또는 근거가 부족합니다.',
    STORYBOOSTER_INCOMPLETE_TAGGED_OUTPUT: '응답의 필수 태그가 완성되지 않았습니다.',
    STORYBOOSTER_INVALID_FIELDS: '필수 응답 필드의 형식 또는 값이 올바르지 않습니다.',
    STORYBOOSTER_REQUIRED_FIELDS_MISSING: '필수 응답 필드가 누락되었습니다.',
    STORYBOOSTER_REASONING_ONLY_OUTPUT: '최종 결과 없이 추론 내용만 반환되었습니다.',
    STORYBOOSTER_TRUNCATED_JSON: '출력 한도에 도달해 JSON 응답이 중단되었습니다.',
    STORYBOOSTER_REQUEST_ABORTED: '백그라운드 요청이 취소되었습니다.',
    STORYBOOSTER_REQUEST_TIMEOUT: '백그라운드 요청 시간이 초과되었습니다.',
    STORYBOOSTER_REQUEST_BUDGET_EXHAUSTED: '허용된 요청 한도를 사용했습니다.',
    STORYBOOSTER_PROFILE_NOT_FOUND: '선택한 연결 프로필을 찾지 못했습니다.',
    STORYBOOSTER_PROFILE_SERVICE_UNAVAILABLE: '연결 프로필 요청 기능을 사용할 수 없습니다.',
    STORYBOOSTER_TOOL_POPUP_DOM_MISSING: '도구 화면을 준비하지 못했습니다.',
    STORYBOOSTER_JEV_CANCELLED: 'Jev 요청이 취소되었습니다.',
    STORYBOOSTER_JEV_CONSENT_REQUIRED: 'Jev 사용 동의가 필요합니다.',
    STORYBOOSTER_JEV_HTTP_ERROR: 'Jev 요청이 서버에서 거부되었습니다.',
    STORYBOOSTER_JEV_INPUT_LIMIT: 'Jev 입력 한도를 초과했습니다.',
    STORYBOOSTER_JEV_INVALID_RESPONSE: 'Jev 판정 응답의 형식이 올바르지 않습니다.',
    STORYBOOSTER_JEV_KEY_FORMAT: 'Jev 키 형식이 올바르지 않습니다.',
    STORYBOOSTER_JEV_KEY_MISSING: 'Jev 키가 준비되지 않았습니다.',
    STORYBOOSTER_JEV_NETWORK_ERROR: 'Jev 요청의 네트워크 연결에 실패했습니다.',
    STORYBOOSTER_JEV_PROVIDER_INVALID: '지원하지 않는 Jev 제공자입니다.',
    STORYBOOSTER_JEV_RELAY_UNAVAILABLE: 'SillyTavern의 Jev 중계를 사용할 수 없습니다.',
    STORYBOOSTER_JEV_STORAGE_ERROR: 'Jev 키 저장소 처리에 실패했습니다.',
    STORYBOOSTER_JEV_TIMEOUT: 'Jev 요청 시간이 초과되었습니다.',
    STORYBOOSTER_JEV_UPSTREAM_ERROR: 'Jev 제공자 요청에 실패했습니다.',
});
const REQUEST_MESSAGES = Object.freeze({
    authentication: '인증에 실패했습니다. 연결 설정을 확인해 주세요.',
    rate_limit: '제공자의 요청 제한에 도달했습니다.',
    provider_error: '제공자 서버에서 오류가 발생했습니다.',
    network: '네트워크 연결에 실패했습니다.',
    timeout: '요청 시간이 초과되었습니다.', cancelled: '요청이 취소되었습니다.',
    schema_unsupported: '제공자가 요청한 응답 형식을 지원하지 않습니다.',
    request_rejected: '제공자가 요청을 거부했습니다.',
    response_invalid: '응답 검증에 실패했습니다.',
    host_request_failed: 'SillyTavern 연결 요청에 실패했습니다.',
});
export function safeDiagnosticErrorMessage(error, requestError) {
    const code = error?.code;
    if (Object.hasOwn(ERROR_MESSAGES, code)) return ERROR_MESSAGES[code];
    const kind = requestError || requestFailureDetails(error).requestError;
    return Object.hasOwn(REQUEST_MESSAGES, kind) ? REQUEST_MESSAGES[kind]
        : '요청 또는 처리 중 오류가 발생했습니다. 외부 오류 원문은 보고서에서 제외했습니다.';
}
const STAGES = new Set(['unknown', 'request_timeout', 'request_budget', 'connection_profile', 'response_completion',
    'response_empty', 'response_reasoning', 'required_field_validation', 'json_parsing', 'request_transport',
    'response_validation', 'result_validation', 'audit_setup', 'jev_diagnosis', 'jev_connection', 'jev_storage',
    'panel_refresh', 'prompt_injection', 'popup_dom_binding', 'ui_refresh', 'context_access', 'popup_api',
    'popup_call', 'settings_save', 'reply_generation']);
const RETRY_REASONS = new Set(['필수 응답 필드 누락', '응답 필드 형식 오류', '빈 구조화 응답', '불완전한 JSON 응답',
    '출력 한도에 따른 응답 중단', '진단 필드 누락', '캐릭터 기준 필드 누락', '구조화 출력 요청 오류',
    '일반 JSON 복구', '필수 앵커 필드 누락', '앵커 필드 길이 오류', '앵커 구조화 출력 요청 오류', '태그 응답 복구',
    '필수 사건 필드 누락', '사건 필드 오류',
    '필수 플롯 필드 누락', '플롯 구조화 출력 요청 오류', '플롯 형식 보정', '출력 언어 보정']);
const NUMBERS = ['firstOccurredAt', 'lastOccurredAt', 'count', 'responseLength', 'timeoutMs', 'requestCount',
    'retryCount', 'promptChars', 'transcriptChars', 'inputChars', 'contextItems', 'elapsedMs', 'responseChars'];
const TEXT = ['id', 'storyBoosterVersion', 'sillyTavernVersion', 'task', 'connectionMode', 'model', 'apiType', 'method', 'location'];
export function protectErrorDiagnosticEntry(value, cleanText) {
    const out = {};
    for (const key of NUMBERS) out[key] = Number.isFinite(Number(value?.[key])) ? Math.max(0, Number(value[key])) : 0;
    for (const key of TEXT) out[key] = cleanText(value?.[key] || '', key === 'model' ? 120 : 100);
    out.stage = STAGES.has(value?.stage) ? value.stage : 'unknown';
    out.errorCode = Object.hasOwn(ERROR_MESSAGES, value?.errorCode) ? value.errorCode : '';
    Object.assign(out, filterRequestFailureDetails(value || {}), filterResponseValidationDetails(value || {}));
    out.errorMessage = safeDiagnosticErrorMessage({ code: out.errorCode }, out.requestError);
    out.httpStatus = Number.isInteger(Number(value?.httpStatus)) && Number(value.httpStatus) >= 400 && Number(value.httpStatus) <= 599 ? Number(value.httpStatus) : '';
    const finish = String(value?.finishReason || '').toLowerCase();
    out.finishReason = ['stop', 'length', 'max_tokens', 'max_output_tokens', 'safety', 'content_filter', 'tool_calls', 'unavailable'].includes(finish) ? finish : '';
    out.responseFormat = ['json-like', 'markdown-fence', 'provider-object', 'string', 'object', 'undefined'].includes(value?.responseFormat) ? value.responseFormat : '';
    out.compatibilityFallback = value?.compatibilityFallback === true;
    out.retryReason = String(value?.retryReason || '').split(' · ').filter(reason => RETRY_REASONS.has(reason)).join(' · ');
    out.returnedFields = safeShapes(value?.returnedFields);
    out.missingFields = safeFields(value?.missingFields);
    out.invalidFields = safeFields(value?.invalidFields);
    out.fingerprint = [out.task, out.stage, out.errorCode, out.errorMessage, out.validationCode || '', out.validationField || ''].join('|');
    return out;
}
