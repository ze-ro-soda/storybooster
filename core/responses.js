// StoryBooster: core/responses.js
import { EMPTY_STRUCTURED_OUTPUT_ERROR, THINKING_OUTPUT_ERROR } from "./constants.js";

// @source-order 174
function normalizeGeneratedText(value) {
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) {
        return value
            .map((part) =>
                typeof part === "string"
                    ? part
                    : String(part?.text ?? part?.content ?? "")
            )
            .filter(Boolean)
            .join("\n")
            .trim();
    }
    // ConnectionManagerRequestService parses structured Chat Completion
    // responses before returning them. Preserve that object as JSON instead of
    // falling through to a model's reasoning text.
    if (value && typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch {
            return "";
        }
    }
    return "";
}

// Some hosts wrap a provider envelope in response; a parsed result object
// remains a result object. Never stringify a thought-only provider envelope.
function getGenerationResponseRoot(data) {
    const response = data?.response;
    return response && typeof response === "object" && !Array.isArray(response) &&
        ["choices", "candidates", "content", "reasoning", "reasoning_content"].some(
            (key) => Object.hasOwn(response, key)
        ) ? response : data;
}

function filterGenerationTextParts(value, reasoning = false) {
    if (!Array.isArray(value)) return reasoning ? [] : value;
    return value.filter((part) => reasoning
        ? part?.thought === true
        : part?.thought !== true);
}

// @source-order 175
function extractVisibleTextFromGenerationData(data) {
    if (typeof data === "string") return data.trim();

    const root = getGenerationResponseRoot(data);
    const message = root?.choices?.[0]?.message;
    const candidates = [
        message?.content,
        root?.choices?.[0]?.text,
        root?.candidates?.[0]?.content?.parts,
        root?.content?.parts ?? root?.content,
        root?.response,
    ];

    for (const candidate of candidates) {
        const text = normalizeGeneratedText(filterGenerationTextParts(candidate));
        if (text) return text;
    }

    const knownEnvelope =
        root &&
        typeof root === "object" &&
        [
            "choices",
            "candidates",
            "content",
            "response",
            "reasoning",
            "reasoning_content",
        ].some((key) => Object.hasOwn(root, key));
    if (root && typeof root === "object" && !knownEnvelope) {
        return normalizeGeneratedText(root);
    }

    return "";
}

// @source-order 176
function extractReasoningTextFromGenerationData(data) {
    if (!data || typeof data !== "object") return "";
    const root = getGenerationResponseRoot(data);
    const message = root?.choices?.[0]?.message;
    const candidates = [
        message?.reasoning,
        message?.reasoning_content,
        root?.reasoning,
        root?.reasoning_content,
        filterGenerationTextParts(root?.candidates?.[0]?.content?.parts, true),
        filterGenerationTextParts(message?.content, true),
        filterGenerationTextParts(root?.content?.parts ?? root?.content, true),
    ];

    for (const candidate of candidates) {
        const text = normalizeGeneratedText(candidate);
        if (text) return text;
    }

    return "";
}

// @source-order 177
function extractTextFromGenerationData(data) {
    // Final-result parsing must never fall back to a provider's draft/thoughts.
    // The presence check reports thought-only output using a controlled error.
    return extractVisibleTextFromGenerationData(data);
}

// @source-order 178
function assertStructuredOutputPresent(data, extractedText) {
    const visibleText = extractVisibleTextFromGenerationData(data);
    const reasoningText = extractReasoningTextFromGenerationData(data);
    if (!visibleText && reasoningText) {
        const error = new Error(THINKING_OUTPUT_ERROR);
        error.code = "STORYBOOSTER_REASONING_ONLY_OUTPUT";
        throw error;
    }
    if (!extractedText || extractedText === "{}") {
        const error = new Error(EMPTY_STRUCTURED_OUTPUT_ERROR);
        error.code = "STORYBOOSTER_EMPTY_STRUCTURED_OUTPUT";
        throw error;
    }

}

// @source-order 179
function isLengthLimitedGeneration(data) {
    const reasons = [
        data?.choices?.[0]?.finish_reason,
        data?.candidates?.[0]?.finishReason,
        data?.finishReason,
        data?.response?.candidates?.[0]?.finishReason,
    ]
        .filter(Boolean)
        .map((reason) => String(reason).toLowerCase());
    return reasons.some(
        (reason) =>
            reason === "length" ||
            reason.includes("max_token") ||
            reason.includes("max_output")
    );
}

// @source-order 180
function throwIfStructuredResultWasTruncated(data, text) {
    if (!isLengthLimitedGeneration(data)) return;
    try {
        extractJsonObject(
            text,
            "자동 분석이 JSON을 출력하기 전에 길이 제한에 도달했습니다."
        );
    } catch {
        const error = new Error(
            "모델이 내부 사고에 출력 한도를 사용해 JSON 완성 전에 중단되었습니다."
        );
        error.code = "STORYBOOSTER_TRUNCATED_JSON";
        throw error;
    }
}

// @source-order 181
function throwIfStructuredJsonIsIncomplete(text) {
    try {
        extractJsonObject(
            text,
            "The model did not return a complete JSON object."
        );
    } catch (cause) {
        const error = new Error(
            "The model response ended before a complete JSON object was returned."
        );
        error.code = "STORYBOOSTER_INCOMPLETE_JSON";
        error.cause = cause;
        throw error;
    }
}

// @source-order 182
function extractJsonObject(rawResult, emptyMessage) {
    const text = extractTextFromGenerationData(rawResult);
    if (!text) throw new Error(emptyMessage);

    const direct = text.trim();
    try {
        return JSON.parse(direct);
    } catch {
        // Some models wrap the final JSON in a Markdown fence or include a short
        // reasoning preface. Scan for the first balanced, parseable object.
    }

    const fencedMatches = direct.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
    for (const match of fencedMatches) {
        try {
            return JSON.parse(match[1].trim());
        } catch {
            // Continue to the balanced-object scanner below.
        }
    }

    for (let start = 0; start < direct.length; start += 1) {
        if (direct[start] !== "{") continue;

        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let end = start; end < direct.length; end += 1) {
            const character = direct[end];
            if (inString) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === '"') inString = false;
                continue;
            }

            if (character === '"') inString = true;
            else if (character === "{") depth += 1;
            else if (character === "}") depth -= 1;

            if (depth === 0) {
                try {
                    return JSON.parse(direct.slice(start, end + 1));
                } catch {
                    break;
                }
            }
        }
    }

    throw new Error(emptyMessage);
}

// @source-order 183
function normalizeSillyTavernJsonSchema(jsonSchema) {
    if (!jsonSchema || typeof jsonSchema !== "object") return null;
    const { schema, value, ...metadata } = jsonSchema;
    const schemaValue = value || schema;
    if (!schemaValue || typeof schemaValue !== "object") return null;
    return {
        ...metadata,
        value: schemaValue,
    };
}

// @source-order 228
function requireStructuredTextFields(parsed, fields) {
    const object = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed : {};
    const missingFields = fields.filter((field) => !Object.hasOwn(object, field));
    if (missingFields.length) {
        const error = new Error(`필수 응답 필드가 누락되었습니다: ${missingFields.join(", ")}`);
        error.code = "STORYBOOSTER_REQUIRED_FIELDS_MISSING";
        error.missingFields = missingFields;
        throw error;
    }
    const invalidFields = fields.filter((field) => typeof object[field] !== "string");
    if (invalidFields.length) {
        const error = new Error(`응답 필드가 문자열이 아닙니다: ${invalidFields.join(", ")}`);
        error.code = "STORYBOOSTER_INVALID_FIELDS";
        error.invalidFields = invalidFields;
        throw error;
    }
    return object;
}

// @source-order 229
function parseJsonOrTaggedPayload(result, { allowTagged, tagPattern, parseTagged, emptyMessage }) {
    const text = extractTextFromGenerationData(result);
    // A complete JSON payload wins over tag-like text inside its string fields.
    try { return JSON.parse(text.trim()); } catch { /* Try explicit markers next. */ }
    if (allowTagged && tagPattern.test(text)) return parseTagged(result);
    try {
        return extractJsonObject(result, emptyMessage);
    } catch (error) {
        if (!allowTagged) throw error;
        // Empty / unrecognizable tagged output becomes a missing-field error,
        // keeping it eligible for the final bounded repair attempt.
        return parseTagged(result);
    }
}

export { assertStructuredOutputPresent, extractJsonObject, extractReasoningTextFromGenerationData, extractTextFromGenerationData, extractVisibleTextFromGenerationData, filterGenerationTextParts, getGenerationResponseRoot, isLengthLimitedGeneration, normalizeGeneratedText, normalizeSillyTavernJsonSchema, parseJsonOrTaggedPayload, requireStructuredTextFields, throwIfStructuredJsonIsIncomplete, throwIfStructuredResultWasTruncated };
