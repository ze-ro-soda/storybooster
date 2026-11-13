import { CHARACTER_BASELINE_FIELDS, CHARACTER_BASELINE_FIELD_MAX_CHARS } from './constants.js';
import { getCurrentChatId, getCurrentCharacterIdentity } from './context.js';
import { getCharacterBaselineVersion, getCharacterBaselineVersionOptions, createCharacterBaselineVersion,
    writeCharacterBaselineVersion, ensureModuleSettings, normalizeCharacterBaseline } from './storage.js';
import { characterBaselinePendingTasks } from './runtime.js';
import { saveSettingsDebounced } from './sillytavern.js';

const comparisonClone = value => JSON.parse(JSON.stringify(value));
const comparisonFingerprint = baseline => JSON.stringify(baseline);

export function getComparableBaselines() {
    const identity = getCurrentCharacterIdentity();
    if (!identity) return [];
    const original = getCharacterBaselineVersion(identity.key, '');
    return [...(original ? [{ id: '', label: '원본', baseline: original }] : []),
        ...getCharacterBaselineVersionOptions(identity.key).map(row => ({ id: row.id, label: row.label, baseline: row.baseline }))];
}

export function createBaselineComparison(aId, bId) {
    const identity = getCurrentCharacterIdentity();
    if (!identity) throw new Error('캐릭터가 있는 채팅에서 사용해 주세요.');
    const choices = getComparableBaselines();
    const session = { chatId: String(getCurrentChatId()), identity: { ...identity }, sides: {} };
    for (const [side, id] of [['a', aId], ['b', bId]]) {
        const entry = choices.find(row => row.id === id);
        if (!entry) throw new Error('비교할 저장 기준을 선택해 주세요.');
        session.sides[side] = { id: entry.id, label: entry.label, original: comparisonClone(entry.baseline),
            draft: comparisonClone(entry.baseline), fingerprint: comparisonFingerprint(entry.baseline) };
    }
    return session;
}

export function assertBaselineComparisonScope(session) {
    if (!session || String(getCurrentChatId()) !== session.chatId || getCurrentCharacterIdentity()?.key !== session.identity.key)
        throw new Error('채팅이나 캐릭터가 바뀌었습니다. 비교를 다시 열어 주세요.');
}

export function editComparedField(session, side, fieldId, value) {
    assertBaselineComparisonScope(session);
    if (!session.sides[side] || !CHARACTER_BASELINE_FIELDS.some(row => row.id === fieldId)) throw new Error('항목을 찾을 수 없습니다.');
    value = String(value);
    if (value.length > CHARACTER_BASELINE_FIELD_MAX_CHARS) throw new Error(`항목은 ${CHARACTER_BASELINE_FIELD_MAX_CHARS}자 이내로 입력해 주세요.`);
    session.sides[side].draft.fields[fieldId].text = value;
    session.sides[side].draft.fields[fieldId].language = ensureModuleSettings().outputLanguage;
}

export function copyComparedField(session, from, to, fieldId) {
    if (!session?.sides[from] || !session.sides[to] || from === to) throw new Error('복사 방향을 확인해 주세요.');
    editComparedField(session, to, fieldId, session.sides[from].draft.fields[fieldId]?.text || '');
    session.sides[to].draft.fields[fieldId].language = session.sides[from].draft.fields[fieldId]?.language || '';
}

export function resetComparedSide(session, side) {
    assertBaselineComparisonScope(session);
    session.sides[side].draft = comparisonClone(session.sides[side].original);
}

export function comparedChanges(session, side) {
    const entry = session.sides[side];
    return CHARACTER_BASELINE_FIELDS.filter(field =>
        entry.draft.fields[field.id].text.trim() !== entry.original.fields[field.id].text.trim()).map(field => field.id);
}

export function saveComparedSide(session, side) {
    assertBaselineComparisonScope(session);
    const entry = session.sides[side];
    if (!entry) throw new Error('저장할 기준을 찾을 수 없습니다.');
    if (characterBaselinePendingTasks.has(session.identity.key)) throw new Error('캐릭터 기준 생성이 끝난 뒤 저장해 주세요.');
    const current = getCharacterBaselineVersion(session.identity.key, entry.id);
    if (!current || comparisonFingerprint(current) !== entry.fingerprint)
        throw new Error('저장된 기준이 변경되거나 삭제됐습니다. 초안을 복사해 보관한 뒤 비교를 다시 열어 주세요.');
    const changes = comparedChanges(session, side);
    if (!changes.length) throw new Error('저장할 변경 내용이 없습니다.');
    if (!CHARACTER_BASELINE_FIELDS.some(field => entry.draft.fields[field.id].text.trim())) throw new Error('기준 내용을 모두 비울 수 없습니다.');
    const next = comparisonClone(current);
    for (const fieldId of changes) {
        const text = entry.draft.fields[fieldId].text.trim();
        if (text.length > CHARACTER_BASELINE_FIELD_MAX_CHARS) throw new Error('항목의 글자 수를 확인해 주세요.');
        next.fields[fieldId] = { ...next.fields[fieldId], text, source: 'user',
            language: entry.draft.fields[fieldId].language || ensureModuleSettings().outputLanguage, updatedAt: Date.now() };
    }
    next.boostAnchorNeedsRefresh = Boolean(next.boostAnchor);
    next.updatedAt = Date.now();
    let versionId = entry.id, label = entry.label;
    if (!versionId) {
        const record = createCharacterBaselineVersion(session.identity, next, { chatId: session.chatId, parentVersionId: '' });
        if (!record) throw new Error('새 갱신본을 저장하지 못했습니다.');
        versionId = record.id; label = record.label;
    } else if (!writeCharacterBaselineVersion(session.identity, next, versionId)) throw new Error('저장 대상이 사라졌습니다.');
    // Rebase only the saved pane. Keep the opposite draft even when both started from the same version.
    const baseline = normalizeCharacterBaseline(next);
    session.sides[side] = { id: versionId, label, original: comparisonClone(baseline),
        draft: comparisonClone(baseline), fingerprint: comparisonFingerprint(getCharacterBaselineVersion(session.identity.key, versionId)) };
    saveSettingsDebounced();
    return { versionId, label, changedFields: changes, needsAnchorRefresh: true };
}
