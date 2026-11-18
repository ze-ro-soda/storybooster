// One acceptance decision before any one-shot is consumed. Same-slot swipes
// may reuse the message ID. Reloads and chat switches seed the current slot.
import { getContext } from './sillytavern.js';
import { getCurrentChatId, resolveReceivedAssistantMessageId } from './context.js';
let previous, generation;
export function markReceivedGeneration(type) {
    generation = ['swipe','regenerate','continue'].includes(type) ? getCurrentChatId() : null;
}
function stamp(id) {
    if (id === null) return null;
    const m = getContext().chat[id];
    return { chat: getCurrentChatId(), id, swipe: m.swipe_id, text: m.mes };
}
export function syncReceivedTurn() { generation = null; previous = stamp(resolveReceivedAssistantMessageId()); }
export function acceptReceivedTurn(raw) {
    const id = resolveReceivedAssistantMessageId(raw), s = stamp(id);
    if (!s) return null;
    if (previous && previous.chat === s.chat && previous.id === id && previous.swipe === s.swipe && (previous.text === s.text || generation !== s.chat)) return null;
    generation = null; previous = s; return id;
}
