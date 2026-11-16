import { clipTranscriptMessage } from '../core/context.js';
import { AUDIT_MESSAGE_MAX_CHARS, GENRE_AUDIT_RESPONSE_LIMIT } from '../core/constants.js';

// Keep each preceding user input with its reply when applying the total budget.
// Number only retained replies. Both engines use this exact bounded window.
export function buildAuditTranscript(messages, maxChars = 60000) {
    const usable = (Array.isArray(messages) ? messages : []).filter(message =>
        message && !message.is_system && typeof message.mes === 'string' && message.mes.trim());
    const indexes = usable.map((message, index) => message.is_user ? -1 : index)
        .filter(index => index >= 0).slice(-GENRE_AUDIT_RESPONSE_LIMIT);
    const name = (message, fallback) => String(message.name || fallback).replace(/[\r\n\[\]]/g, ' ').trim();
    const retained = [];
    let used = 0;
    for (let i = indexes.length - 1; i >= 0; i--) {
        const index = indexes[i], reply = usable[index];
        const user = usable[index - 1]?.is_user ? usable[index - 1] : null;
        const userText = user ? `[USER_CONTEXT:${name(user, 'USER_CONTEXT')}]\n${clipTranscriptMessage(user.mes, AUDIT_MESSAGE_MAX_CHARS)}\n\n` : '';
        const replyText = clipTranscriptMessage(reply.mes, AUDIT_MESSAGE_MAX_CHARS);
        const replyName = name(reply, 'CHAR');
        // Reserve a two-digit number and delimiters; the final representation
        // cannot exceed this budget, even when a pair is dropped.
        const size = userText.length + replyText.length + replyName.length + '[CHAR_RESPONSE_10:]\n'.length + 2;
        if (used + size > maxChars) break;
        retained.unshift({ userText, replyText, replyName });
        used += size;
    }
    return { reviewedResponses: retained.length,
        transcript: retained.map((pair, i) => `${pair.userText}[CHAR_RESPONSE_${i + 1}:${pair.replyName}]\n${pair.replyText}`).join('\n\n') };
}

// Retain the old helper name for callers of the final automatic-plot check.
export const buildJevAuditTranscript = buildAuditTranscript;

// Reserve the entire newest user input before selecting paired, numbered
// evidence. A decision always uses the count returned with that exact input.
export function buildFinalPlotAuditInput(messages, latestMessages, maxChars = 60000) {
    const latestInput = latestMessages.map(message => String(message.mes || '')).join('\n');
    const suffix = `\nLATEST USER INPUT TO ANSWER:\n${latestInput}`;
    const metadata = { latestInputChars: latestInput.length, latestInputComplete: true };
    if (suffix.length >= maxChars) {
        return { ...metadata, latestInputComplete: false, transcript: '', reviewedResponses: 0, transcriptTrimmed: true };
    }
    const input = buildJevAuditTranscript(messages, maxChars - suffix.length);
    const usable = messages.filter(message => message && !message.is_system && typeof message.mes === 'string' && message.mes.trim());
    const originalCount = Math.min(GENRE_AUDIT_RESPONSE_LIMIT, usable.filter(message => !message.is_user).length);
    return { ...metadata, reviewedResponses: input.reviewedResponses,
        transcript: input.transcript + suffix,
        transcriptTrimmed: input.reviewedResponses < originalCount || usable.slice(-GENRE_AUDIT_RESPONSE_LIMIT * 2).some(message => message.mes.length > AUDIT_MESSAGE_MAX_CHARS),
    };
}
