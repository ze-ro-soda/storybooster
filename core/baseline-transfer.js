import { CHARACTER_BASELINE_FIELDS, CHARACTER_BASELINE_FIELD_MAX_CHARS, CHARACTER_BOOST_ANCHOR_MAX_CHARS,
    CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS, MAX_CHARACTER_BASELINE_VERSIONS, STORYBOOSTER_VERSION } from './constants.js';
import { ensureModuleSettings, getCharacterBaselineVersion, getCharacterBaselineVersionOptions, normalizeCharacterBaseline } from './storage.js';
import { characterBaselinePendingTasks, characterBaselineAutosaveTimers } from './runtime.js';
import { getCurrentCharacterIdentity, getCurrentChatId } from './context.js';
import { saveSettingsDebounced } from './sillytavern.js';

export const BASELINE_BACKUP_MAX_BYTES = 2 * 1024 * 1024;
const FORMAT = 'storybooster-character-baselines';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, max, name, optional = true) {
    if (value === undefined && optional) return '';
    if (typeof value !== 'string' || value.length > max) throw new Error(`${name} 형식 또는 길이를 확인해 주세요.`);
    return value;
}
function cleanBaseline(raw) {
    if (!object(raw) || !object(raw.fields)) throw new Error('캐릭터 기준 항목을 읽을 수 없습니다.');
    const allowed = new Set(CHARACTER_BASELINE_FIELDS.map(f => f.id));
    if (Object.keys(raw.fields).some(k => !allowed.has(k))) throw new Error('지원하지 않는 캐릭터 기준 항목이 있습니다.');
    const fields = {};
    for (const { id } of CHARACTER_BASELINE_FIELDS) {
        const f = raw.fields[id];
        if (f === undefined) continue;
        if (!object(f) || (f.pinned !== undefined && typeof f.pinned !== 'boolean')) throw new Error('기준 항목 형식이 올바르지 않습니다.');
        fields[id] = { text: text(f.text, CHARACTER_BASELINE_FIELD_MAX_CHARS, '기준 문구', false), pinned: f.pinned === true,
            language: ['ko', 'en'].includes(f.language) ? f.language : '', source: f.source === 'user' ? 'user' : 'ai',
            updatedAt: Number.isFinite(f.updatedAt) && f.updatedAt > 0 ? f.updatedAt : Date.now() };
    }
    const baseline = normalizeCharacterBaseline({ fields,
        characterName: text(raw.characterName, 100, '캐릭터 이름'),
        boostAnchor: text(raw.boostAnchor, CHARACTER_BOOST_ANCHOR_MAX_CHARS, '영문 앵커'),
        boostAnchorDisplay: text(raw.boostAnchorDisplay, CHARACTER_BOOST_ANCHOR_MAX_CHARS, '표시 앵커'),
        boostAnchorDisplayLanguage: ['ko', 'en'].includes(raw.boostAnchorDisplayLanguage) ? raw.boostAnchorDisplayLanguage : '',
        boostAnchorNeedsRefresh: raw.boostAnchorNeedsRefresh === true,
        boostAnchorUpdatedAt: Number.isFinite(raw.boostAnchorUpdatedAt) ? raw.boostAnchorUpdatedAt : 0,
        sourceHash: text(raw.sourceHash, 100, '기준 출처'),
        updatedAt: Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : Date.now() });
    if (!baseline) throw new Error('내용이 비어 있는 캐릭터 기준은 가져올 수 없습니다.');
    return baseline;
}
export function createCharacterBackup(identity = getCurrentCharacterIdentity()) {
    if (!identity?.key) throw new Error('캐릭터 채팅을 먼저 열어 주세요.');
    if (characterBaselinePendingTasks.has(identity.key) || characterBaselineAutosaveTimers.size) throw new Error('기준 생성·저장이 끝난 뒤 다시 시도해 주세요.');
    const original = getCharacterBaselineVersion(identity.key, '');
    const versions = getCharacterBaselineVersionOptions(identity.key);
    if (!original && !versions.length) throw new Error('백업할 캐릭터 기준이 없습니다.');
    // Only explicitly selected baseline data is exported. No settings, chat,
    // API credentials, avatar paths or diagnosis histories are copied.
    return { format: FORMAT, formatVersion: 1, extensionVersion: STORYBOOSTER_VERSION, createdAt: Date.now(),
        characterName: identity.name || '', original: original ? cleanBaseline(original) : null,
        versions: versions.map(v => ({ id: v.id, label: v.label, parentVersionId: v.parentVersionId,
            revisionMode: v.revisionMode, evidenceLevel: v.evidenceLevel, baseline: cleanBaseline(v.baseline) })) };
}
export function parseCharacterBackup(source) {
    if (typeof source !== 'string' || source.length > BASELINE_BACKUP_MAX_BYTES) throw new Error('백업 파일은 2MB 이하의 JSON이어야 합니다.');
    let raw;
    try { raw = JSON.parse(source.replace(/^\uFEFF/, ''), (key, value) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe key');
        return value;
    }); } catch { throw new Error('올바른 JSON 백업 파일이 아닙니다.'); }
    if (!object(raw) || raw.format !== FORMAT || raw.formatVersion !== 1 || !Array.isArray(raw.versions) || raw.versions.length > MAX_CHARACTER_BASELINE_VERSIONS)
        throw new Error('지원하는 스토리부스터 캐릭터 기준 백업 파일이 아닙니다.');
    const entries = [];
    if (raw.original !== null && raw.original !== undefined) entries.push({ sourceId: '', label: '원본', parentVersionId: '', baseline: cleanBaseline(raw.original) });
    const ids = new Set();
    for (const v of raw.versions) {
        if (!object(v)) throw new Error('갱신본 형식이 올바르지 않습니다.');
        const id = text(v.id, 100, '갱신본 ID', false);
        if (!id || ids.has(id)) throw new Error('중복되거나 비어 있는 갱신본 ID가 있습니다.');
        ids.add(id);
        entries.push({ sourceId: id, label: text(v.label, CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS, '갱신본 이름', false).trim() || '갱신본',
            parentVersionId: text(v.parentVersionId, 100, '부모 갱신본 ID'),
            revisionMode: ['directed', 'automatic'].includes(v.revisionMode) ? v.revisionMode : '',
            evidenceLevel: ['strong', 'partial', 'limited'].includes(v.evidenceLevel) ? v.evidenceLevel : '', baseline: cleanBaseline(v.baseline) });
    }
    if (!entries.length) throw new Error('백업 파일에 저장된 기준이 없습니다.');
    return { characterName: text(raw.characterName, 100, '캐릭터 이름'), entries };
}
export function captureBaselineImportTarget() {
    const identity = getCurrentCharacterIdentity();
    if (!identity?.key) throw new Error('캐릭터 채팅을 먼저 열어 주세요.');
    // Normalize once before capturing the optimistic-concurrency snapshot;
    // preview getters must not look like an intervening user edit.
    getCharacterBaselineVersionOptions(identity.key);
    const settings = ensureModuleSettings();
    return { identity: { ...identity }, chatId: getCurrentChatId(),
        snapshot: JSON.stringify([settings.characterBaselines[identity.key] || null, settings.characterBaselineVersions[identity.key] || null]) };
}
function baselineContent(b) {
    return JSON.stringify([CHARACTER_BASELINE_FIELDS.map(({ id }) => [b.fields[id]?.text || '', b.fields[id]?.pinned === true, b.fields[id]?.language || '']),
        b.boostAnchor, b.boostAnchorDisplay, b.boostAnchorDisplayLanguage, b.boostAnchorNeedsRefresh]);
}
export function planBaselineImport(backup, selectedIds, target) {
    if (!target?.identity?.key || !Array.isArray(backup?.entries) || !Array.isArray(selectedIds)) throw new Error('가져올 항목을 다시 선택해 주세요.');
    const settings = ensureModuleSettings();
    const key = target.identity.key;
    const original = getCharacterBaselineVersion(key, '');
    const existing = getCharacterBaselineVersionOptions(key);
    const known = new Set([...(original ? [baselineContent(original)] : []), ...existing.map(v => baselineContent(v.baseline))]);
    const selected = new Set(selectedIds);
    let hasOriginal = Boolean(original);
    const rows = backup.entries.filter(e => selected.has(e.sourceId)).map(e => {
        const baseline = cleanBaseline(e.baseline);
        const signature = baselineContent(baseline);
        const duplicate = known.has(signature);
        const asOriginal = !duplicate && e.sourceId === '' && !hasOriginal;
        // Distinct versions inside a backup may intentionally share content.
        // Only deduplicate against the destination's pre-existing records.
        if (asOriginal) hasOriginal = true;
        return { ...e, baseline, duplicate, asOriginal };
    });
    if (selected.size !== rows.length) throw new Error('선택한 백업 항목을 찾을 수 없습니다.');
    const additions = rows.filter(r => !r.duplicate);
    const neededSlots = additions.filter(r => !r.asOriginal).length;
    const freeSlots = MAX_CHARACTER_BASELINE_VERSIONS - existing.length;
    return { rows, additions, neededSlots, freeSlots, canImport: additions.length > 0 && neededSlots <= freeSlots,
        existingStore: settings.characterBaselineVersions[key] || { nextNumber: 1, versions: {} } };
}
export function applyBaselineImport(backup, selectedIds, target) {
    const nowTarget = captureBaselineImportTarget();
    if (nowTarget.chatId !== target.chatId || nowTarget.identity.key !== target.identity.key ||
        nowTarget.identity.sourceHash !== target.identity.sourceHash || nowTarget.snapshot !== target.snapshot)
        throw new Error('캐릭터나 저장된 기준이 변경됐습니다. 파일을 다시 선택해 주세요.');
    if (characterBaselinePendingTasks.has(target.identity.key) || characterBaselineAutosaveTimers.size)
        throw new Error('기준 생성·저장이 끝난 뒤 다시 시도해 주세요.');
    const plan = planBaselineImport(backup, selectedIds, target);
    if (!plan.canImport) throw new Error(plan.neededSlots > plan.freeSlots ? '갱신본 저장 공간이 부족합니다. 가져올 항목을 줄여 주세요.' : '새로 추가할 기준이 없습니다.');
    const settings = ensureModuleSettings();
    const versions = { ...plan.existingStore.versions };
    const mapping = new Map();
    let nextNumber = Number.isSafeInteger(plan.existingStore.nextNumber) && plan.existingStore.nextNumber > 0 &&
        plan.existingStore.nextNumber < Number.MAX_SAFE_INTEGER - MAX_CHARACTER_BASELINE_VERSIONS - 1 ? plan.existingStore.nextNumber : 1;
    let original = null;
    const names = new Set(Object.values(versions).map(v => v.label));
    const now = Date.now();
    for (const row of plan.additions) {
        if (row.asOriginal) { mapping.set(row.sourceId, ''); continue; }
        let id;
        do { id = `import_${now.toString(36)}_${nextNumber++}`; } while (Object.hasOwn(versions, id) || [...mapping.values()].includes(id));
        mapping.set(row.sourceId, id);
    }
    for (const row of plan.additions) {
        const baseline = { ...row.baseline, characterName: target.identity.name || row.baseline.characterName, notifiedSourceHash: '' };
        if (row.asOriginal) { original = baseline; continue; }
        const id = mapping.get(row.sourceId);
        const base = row.sourceId === '' ? '원본 (가져옴)' : row.label;
        let label = base, suffix = 1;
        while (names.has(label)) { const tail = ` (가져옴 ${suffix++})`; label = base.slice(0, CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS - tail.length) + tail; }
        names.add(label);
        versions[id] = { id, label, baseline, parentVersionId: mapping.get(row.parentVersionId) || '',
            revisionMode: row.revisionMode || '', evidenceLevel: row.evidenceLevel || '', createdAt: now, updatedAt: now };
    }
    // Commit only after the complete batch has validated. Never evict versions
    // to make room, overwrite the original, or switch chat selections.
    if (original) settings.characterBaselines[target.identity.key] = original;
    settings.characterBaselineVersions[target.identity.key] = { nextNumber, versions };
    saveSettingsDebounced();
    return { added: plan.additions.length, skipped: plan.rows.length - plan.additions.length, restoredOriginal: Boolean(original) };
}
