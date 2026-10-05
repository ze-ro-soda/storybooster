import { GENRE_AUDIT_CODES, GENRE_AUDIT_RESPONSE_LIMIT } from './constants.js';
import { hashStableText } from './text.js';

export const AUDIT_HISTORY_LIMIT = 6;
const short = (value, max = 100) => typeof value === 'string' ? value.slice(0, max) : '';
const codes = value => Array.isArray(value) ? [...new Set(value.filter(v => GENRE_AUDIT_CODES.includes(v)))] : [];
const index = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function auditPrefixHash(messages, end) {
    return hashStableText(JSON.stringify(messages.slice(0, end + 1).map(m =>
        [Boolean(m?.is_user), Boolean(m?.is_system), m?.name || '', m?.mes || ''])));
}
export function createAuditAnalysis({ messages, reviewedResponses, signature, baselineState, characterKey, characterIncluded }) {
    const ids = messages.map((m, i) => m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim() ? i : -1)
        .filter(i => i >= 0).slice(-GENRE_AUDIT_RESPONSE_LIMIT).slice(-reviewedResponses);
    return normalizeAuditAnalysis({ reviewedResponses, startMessageId: ids[0], endMessageId: ids.at(-1),
        signature: hashStableText(signature), characterKey,
        baselineVersionId: characterIncluded ? baselineState.versionId || '' : '',
        baselineLabel: characterIncluded ? baselineState.versionLabel || '원본' : '' });
}
export function normalizeAuditAnalysis(value) {
    if (!value || index(value.startMessageId) === null || index(value.endMessageId) === null ||
        value.startMessageId > value.endMessageId || !Number.isSafeInteger(value.reviewedResponses) ||
        value.reviewedResponses < 1 || value.reviewedResponses > GENRE_AUDIT_RESPONSE_LIMIT || !value.signature) return null;
    return { reviewedResponses: value.reviewedResponses, startMessageId: value.startMessageId, endMessageId: value.endMessageId,
        signature: short(value.signature), characterKey: short(value.characterKey, 300),
        baselineVersionId: short(value.baselineVersionId), baselineLabel: short(value.baselineLabel) };
}
export function normalizeAuditComparison(value) {
    return Object.fromEntries(GENRE_AUDIT_CODES.filter(code => ['repeated', 'clear', 'deferred'].includes(value?.[code])).map(code => [code, value[code]]));
}
export function normalizeAuditHistory(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-AUDIT_HISTORY_LIMIT).flatMap(v => {
        const analysis = normalizeAuditAnalysis(v?.analysis);
        if (!analysis || !v.id || !['genre', 'character', 'combined'].includes(v.scope)) return [];
        return [{ id: short(v.id), createdAt: Number(v.createdAt) || 0, scope: v.scope, analysis,
            engine: v.engine === 'jev' ? 'jev' : 'legacy', connectionKey: short(v.connectionKey, 300),
            ratings: Object.fromEntries(GENRE_AUDIT_CODES.filter(c => ['stable', 'present', 'attention', 'weak', 'drifted', 'biased', 'dormant', 'na', 'unavailable'].includes(v.ratings?.[c])).map(c => [c, v.ratings[c]])),
            uncertain: codes(v.uncertain), correctionCodes: codes(v.correctionCodes).slice(0, 2),
            appliedCodes: codes(v.appliedCodes).slice(0, 2), appliedMessageId: index(v.appliedMessageId), appliedPrefix: short(v.appliedPrefix) }];
    });
}
function connectionKey(record) {
    return [record.connection?.source, record.connection?.profileId, record.connection?.model].join('|');
}
export function compareAuditHistory(anchor, record, messages) {
    const current = normalizeAuditAnalysis(record.analysis);
    if (!current) return {};
    const previous = normalizeAuditHistory(anchor.auditHistory).reverse().find(p =>
        p.scope === record.scope && p.engine === record.engine && p.connectionKey === connectionKey(record) &&
        p.analysis.signature === current.signature && p.analysis.characterKey === current.characterKey &&
        p.analysis.baselineVersionId === current.baselineVersionId && p.appliedMessageId !== null && p.appliedCodes.length &&
        current.startMessageId > p.analysis.endMessageId && current.startMessageId >= p.appliedMessageId &&
        p.appliedPrefix && auditPrefixHash(messages, p.appliedMessageId) === p.appliedPrefix);
    if (!previous) return {};
    return Object.fromEntries(previous.appliedCodes.map(code => [code,
        record.uncertain?.includes(code) || !record.ratings?.[code] || ['na', 'unavailable', 'dormant'].includes(record.ratings[code]) ? 'deferred' :
        ['attention', 'weak', 'drifted', 'biased'].includes(record.ratings[code]) ? 'repeated' : 'clear']));
}
export function rememberAudit(anchor, record) {
    if (!record.analysis || ['error', 'cancelled'].includes(record.status)) return;
    anchor.auditHistory = normalizeAuditHistory([...(anchor.auditHistory || []).filter(p => p?.id !== record.id),
        { ...record, connectionKey: connectionKey(record), appliedCodes: [], appliedPrefix: '' }]);
}
export function markAuditHistoryApplied(anchor, recordIds, activeCodes, messageId, messages) {
    if (index(messageId) === null || !messages[messageId] || messages[messageId].is_user || messages[messageId].is_system) return;
    for (const record of anchor.auditHistory || []) {
        if (!recordIds.has(record.id)) continue;
        record.appliedCodes = record.correctionCodes.filter(c => activeCodes.has(c));
        record.appliedMessageId = messageId;
        record.appliedPrefix = auditPrefixHash(messages, messageId);
    }
}
export function auditAnalysisLabel(audit) {
    const a = normalizeAuditAnalysis(audit?.analysis);
    return a ? `최근 AI 답변 ${a.reviewedResponses}개${a.baselineLabel ? ` · 캐릭터 기준: ${a.baselineLabel}` : ''}` : '';
}
export function auditComparisonText(audit, code) {
    return { repeated: '이전 보정 항목에서 문제가 다시 감지됐습니다.',
        clear: '이전 보정 항목: 이번 진단에서는 안정으로 판정했습니다.',
        deferred: '이전 보정 항목: 이번에는 판단할 근거가 충분하지 않습니다.' }[audit?.comparison?.[code]] || '';
}
