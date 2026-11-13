import { getCurrentChatId, getCurrentCharacterIdentity } from './context.js';
import { ensureChatState } from './storage.js';
import { saveSettingsDebounced } from './sillytavern.js';

export const PLOT_SHELF_LIMIT = 50;
export const PLOT_SHELF_TEXT_LIMIT = 20000;
let shelfSequence = 0;

export function capturePlotShelfScope() {
    const chatId = String(getCurrentChatId());
    if (chatId === 'no-chat-open') throw new Error('채팅을 연 뒤 보관함을 사용해 주세요.');
    return { chatId, characterKey: getCurrentCharacterIdentity()?.key || '' };
}

export function assertPlotShelfScope(scope) {
    const current = capturePlotShelfScope();
    if (!scope || current.chatId !== scope.chatId || current.characterKey !== scope.characterKey)
        throw new Error('채팅이 바뀌었습니다. 보관함을 다시 열어 주세요.');
}

export function getPlotShelf(scope = capturePlotShelfScope()) {
    assertPlotShelfScope(scope);
    const raw = ensureChatState(scope.chatId).plotShelf;
    if (!Array.isArray(raw)) return [];
    const ids = new Set();
    return raw.flatMap(entry => {
        if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
            typeof entry.text !== 'string' || !entry.text.trim()) return [];
        ids.add(entry.id);
        return [{ id: entry.id, title: typeof entry.title === 'string' ? entry.title : '', text: entry.text,
            createdAt: Number(entry.createdAt) || 0, updatedAt: Number(entry.updatedAt) || 0 }];
    });
}

export function savePlotShelfItem({ title = '', text = '', id = '', expected = null }, scope = capturePlotShelfScope()) {
    assertPlotShelfScope(scope);
    title = String(title).trim(); text = String(text).trim();
    if (!text) throw new Error('보관할 내용을 입력해 주세요.');
    if (title.length > 80 || text.length > PLOT_SHELF_TEXT_LIMIT)
        throw new Error('제목은 80자, 내용은 20,000자 이내로 입력해 주세요.');
    const entries = getPlotShelf(scope);
    const index = id ? entries.findIndex(entry => entry.id === id) : -1;
    if (id && (index < 0 || (expected !== null && JSON.stringify(entries[index]) !== expected)))
        throw new Error('보관한 내용이 변경되거나 삭제됐습니다. 다시 불러와 주세요.');
    if (!id && entries.length >= PLOT_SHELF_LIMIT)
        throw new Error('보관함은 채팅당 50개까지 저장할 수 있어요. 사용하지 않는 항목을 정리해 주세요.');
    const now = Date.now();
    const entry = { id: id || `shelf_${now.toString(36)}_${++shelfSequence}_${Math.random().toString(36).slice(2, 8)}`,
        title, text, createdAt: index < 0 ? now : entries[index].createdAt, updatedAt: now };
    if (index < 0) entries.unshift(entry); else entries[index] = entry;
    ensureChatState(scope.chatId).plotShelf = entries;
    saveSettingsDebounced();
    return { ...entry };
}

export function deletePlotShelfItem(id, expected, scope = capturePlotShelfScope()) {
    const entries = getPlotShelf(scope);
    const entry = entries.find(row => row.id === id);
    if (!entry || JSON.stringify(entry) !== expected) throw new Error('항목이 변경됐습니다. 다시 확인해 주세요.');
    ensureChatState(scope.chatId).plotShelf = entries.filter(row => row.id !== id);
    saveSettingsDebounced();
}
