import { STORYBOOSTER_VERSION } from './constants.js';
import { capturePlotShelfScope, assertPlotShelfScope, getPlotShelf, PLOT_SHELF_LIMIT, PLOT_SHELF_TEXT_LIMIT } from './plot-shelf.js';
import { ensureChatState } from './storage.js';
import { saveSettingsDebounced } from './sillytavern.js';
const FORMAT = 'storybooster-plot-shelf';
export const PLOT_SHELF_FILE_MAX_BYTES = 2 * 1024 * 1024;
function checkFileSize(source) {
    if (typeof source !== 'string' || source.length > PLOT_SHELF_FILE_MAX_BYTES) throw new Error('파일은 2MB 이하의 JSON이어야 합니다.');
    let bytes = 0;
    for (const char of source) {
        const point = char.codePointAt(0);
        bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (bytes > PLOT_SHELF_FILE_MAX_BYTES) throw new Error('파일이 2MB를 초과합니다. 한 번에 옮길 항목을 줄여 주세요.');
    }
}
function cleanItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.text !== 'string' ||
        typeof item.title !== 'string' || !item.text.trim() || item.text.length > PLOT_SHELF_TEXT_LIMIT || item.title.length > 80)
        throw new Error('아이디어의 제목 또는 내용 형식이 올바르지 않습니다.');
    return { title: item.title.trim(), text: item.text.trim() };
}
export function exportPlotShelf(ids, scope = capturePlotShelfScope()) {
    const selected = new Set(ids || []), entries = getPlotShelf(scope).filter(item => selected.has(item.id));
    if (!entries.length) throw new Error('내보낼 아이디어를 선택해 주세요.');
    const file = { format: FORMAT, formatVersion: 1, extensionVersion: STORYBOOSTER_VERSION, createdAt: Date.now(), items: entries.map(cleanItem) };
    checkFileSize(JSON.stringify(file, null, 2)); return file;
}
export function parsePlotShelfFile(source) {
    checkFileSize(source);
    let value;
    try { value = JSON.parse(source.replace(/^\uFEFF/, ''), (key, item) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe key');
        return item;
    }); } catch { throw new Error('올바른 JSON 파일이 아닙니다.'); }
    if (!value || value.format !== FORMAT || value.formatVersion !== 1 || !Array.isArray(value.items) || !value.items.length || value.items.length > PLOT_SHELF_LIMIT)
        throw new Error('지원하는 플롯 보관함 파일이 아닙니다.');
    return value.items.map(cleanItem);
}
export function capturePlotImportTarget(scope = capturePlotShelfScope()) {
    return { scope: { ...scope }, snapshot: JSON.stringify(getPlotShelf(scope)) };
}
export function planPlotShelfImport(items, selected, target) {
    assertPlotShelfScope(target?.scope);
    const entries = getPlotShelf(target.scope);
    if (JSON.stringify(entries) !== target.snapshot) throw new Error('보관함이 변경됐습니다. 파일을 다시 가져와 주세요.');
    if (!Array.isArray(items) || items.length > PLOT_SHELF_LIMIT || !Array.isArray(selected) || selected.some(index => !Number.isSafeInteger(index) || index < 0 || index >= items.length)) throw new Error('가져올 항목을 다시 확인해 주세요.');
    const choices = new Set(selected), seen = new Set(entries.map(item => item.text.trim())), additions = [];
    let duplicates = 0;
    items.forEach((raw, index) => {
        const item = cleanItem(raw);
        if (!choices.has(index)) return;
        if (seen.has(item.text)) { duplicates++; return; }
        seen.add(item.text); additions.push(item);
    });
    if (entries.length + additions.length > PLOT_SHELF_LIMIT) throw new Error('보관함은 채팅당 50개까지 저장할 수 있어요. 가져올 항목을 줄여 주세요.');
    return { additions, duplicates };
}
export function applyPlotShelfImport(items, selected, target) {
    const plan = planPlotShelfImport(items, selected, target);
    if (!plan.additions.length) return { added: 0, duplicates: plan.duplicates };
    const entries = getPlotShelf(target.scope), ids = new Set(entries.map(item => item.id)), now = Date.now();
    const additions = plan.additions.map((item, index) => {
        let id = `import_${now.toString(36)}_${index}`;
        while (ids.has(id)) id += '_'; ids.add(id);
        return { ...item, id, createdAt: now, updatedAt: now };
    });
    // Validate everything before a single commit. Never partially import a file.
    ensureChatState(target.scope.chatId).plotShelf = [...additions, ...entries]; saveSettingsDebounced();
    return { added: additions.length, duplicates: plan.duplicates };
}
