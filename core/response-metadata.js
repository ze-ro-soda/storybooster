import { extractVisibleTextFromGenerationData, filterGenerationTextParts, getGenerationResponseRoot } from './responses.js';

// Only counts and controlled enums enter exported traces. A host may return
// extracted text/JSON instead of a provider envelope; absence is not STOP.
const FINISH = new Set(['unavailable', 'stop', 'length', 'safety', 'tool_call', 'other']);
const FORMATS = new Set(['pending', 'text', 'structured', 'provider', 'empty']);
const COUNTS = ['requestedOutputTokens', 'visibleOutputChars', 'reasoningOutputChars',
    'providerOutputTokens', 'providerReasoningTokens'];

export function filterResponseMetadata(value = {}) {
    const out = {};
    for (const key of COUNTS) if (Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
    if (FINISH.has(value.responseFinish)) out.responseFinish = value.responseFinish;
    if (FORMATS.has(value.responseEnvelope)) out.responseEnvelope = value.responseEnvelope;
    return out;
}

export function pendingResponseMetadata(limit) {
    return filterResponseMetadata({ requestedOutputTokens: Number(limit), responseFinish: 'unavailable', responseEnvelope: 'pending' });
}

export function captureResponseMetadata(diagnostic, data, extractedText, limit) {
    if (!diagnostic) return;
    const root = getGenerationResponseRoot(data);
    const choice = root?.choices?.[0], candidate = root?.candidates?.[0];
    const provider = Boolean(choice || candidate || root?.usage || root?.usageMetadata);
    const rawFinish = choice?.finish_reason ?? choice?.finishReason ?? candidate?.finishReason
        ?? root?.finish_reason ?? root?.finishReason;
    const finish = rawFinish == null ? 'unavailable'
        : /^(stop|end_turn|STOP)$/i.test(String(rawFinish)) ? 'stop'
        : /^(length|max_tokens|max_output_tokens)$/i.test(String(rawFinish)) ? 'length'
        : /^(safety|content_filter|recitation|blocklist|prohibited_content|spii)$/i.test(String(rawFinish)) ? 'safety'
        : /^(tool_calls|function_call)$/i.test(String(rawFinish)) ? 'tool_call' : 'other';
    const chars = value => typeof value === 'string' ? value.length : Array.isArray(value)
        ? value.reduce((n, part) => n + (typeof part === 'string' ? part.length : typeof part?.text === 'string' ? part.text.length : 0), 0) : 0;
    const parts = candidate?.content?.parts;
    const message = choice?.message;
    const reasoning = message?.reasoning_content ?? message?.reasoning ?? root?.reasoning_content ?? root?.reasoning;
    // These are observed fields, not an inference that the provider did/didn't
    // reason. Hosts without those fields leave the reasoning count absent.
    const extra = {};
    let visible = extractVisibleTextFromGenerationData(data).length;
    if (Array.isArray(parts)) {
        visible = chars(filterGenerationTextParts(parts));
        if (parts.some(part => part?.thought === true)) extra.reasoningOutputChars = chars(filterGenerationTextParts(parts, true));
    } else if (choice) {
        const content = message?.content ?? choice?.text;
        visible = chars(filterGenerationTextParts(content));
        if (Array.isArray(content) && content.some(part => part?.thought === true)) {
            extra.reasoningOutputChars = chars(filterGenerationTextParts(content, true));
        }
    } else {
        const content = root?.content?.parts ?? root?.content;
        if (Array.isArray(content)) {
            visible = chars(filterGenerationTextParts(content));
            if (content.some(part => part?.thought === true)) extra.reasoningOutputChars = chars(filterGenerationTextParts(content, true));
        }
    }
    if (reasoning !== undefined) extra.reasoningOutputChars = chars(reasoning);
    diagnostic.responseMetadata = filterResponseMetadata({ ...pendingResponseMetadata(limit), ...extra,
        responseFinish: finish, responseEnvelope: provider ? 'provider' : typeof data === 'string' ? 'text'
            : data && typeof data === 'object' ? 'structured' : 'empty', visibleOutputChars: visible,
        providerOutputTokens: root?.usageMetadata?.candidatesTokenCount ?? root?.usage?.completion_tokens ?? root?.usage?.output_tokens,
        providerReasoningTokens: root?.usageMetadata?.thoughtsTokenCount ?? root?.usage?.completion_tokens_details?.reasoning_tokens
            ?? root?.usage?.output_tokens_details?.reasoning_tokens,
    });
}
