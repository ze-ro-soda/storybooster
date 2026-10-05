// StoryBooster: core/text.js
import { AUDIT_REASON_DISPLAY_HARD_LIMIT, AUDIT_REASON_MAX_CHARS_EN, AUDIT_REASON_MAX_CHARS_KO, AUDIT_REASON_MAX_SENTENCES, AUDIT_REASON_SCHEMA_MAX_CHARS_EN, AUDIT_REASON_SCHEMA_MAX_CHARS_KO, CHARACTER_CORRECTION_MAX_CHARS, CHARACTER_CORRECTION_MAX_WORDS } from "./constants.js";

// @source-order 124
function hashStableText(value) {
    let hash = 2166136261;
    for (const char of String(value || "")) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

// @source-order 165
function getAuditReasonMaxChars(outputLanguage = "ko") {
    return outputLanguage === "en"
        ? AUDIT_REASON_MAX_CHARS_EN
        : AUDIT_REASON_MAX_CHARS_KO;
}

// @source-order 166
function getAuditReasonSchemaMaxChars(outputLanguage = "ko") {
    return outputLanguage === "en"
        ? AUDIT_REASON_SCHEMA_MAX_CHARS_EN
        : AUDIT_REASON_SCHEMA_MAX_CHARS_KO;
}

// @source-order 167
function normalizeAuditReason(value, outputLanguage = "ko") {
    let text = String(value || "")
        .replace(/\[?CHAR_RESPONSE_?\d+\]?/gi, "최근 응답")
        .replace(
            /\b(?:responses?|repl(?:y|ies))\s*#?\d+(?:\s*[,·ㆍ、/&-]\s*#?\d+)*\b/gi,
            "recent responses"
        )
        .replace(
            /\d+(?:\s*[·ㆍ,，、/&-]\s*\d+)+\s*번(?:째)?/g,
            "최근 응답"
        )
        .replace(/(?:응답|메시지)\s*#?\d+\s*번?/g, "최근 응답")
        .replace(/\d+\s*번(?:째)?\s*(?:응답|메시지)/g, "최근 응답")
        .replace(/\d+\s*번(?:째)?/g, "최근 응답")
        .replace(/\s+/g, " ")
        .trim();
    if (!text) return "";

    const sentences = text.match(/[^.!?。！？]+[.!?。！？]?/g) || [text];
    text = sentences
        .slice(0, AUDIT_REASON_MAX_SENTENCES)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    if (text.length <= AUDIT_REASON_DISPLAY_HARD_LIMIT) return text;

    const clipped = text
        .slice(0, AUDIT_REASON_DISPLAY_HARD_LIMIT - 1)
        .trimEnd();
    const lastSpace = clipped.lastIndexOf(" ");
    const safeCut =
        lastSpace >= Math.floor(AUDIT_REASON_DISPLAY_HARD_LIMIT * 0.8)
            ? clipped.slice(0, lastSpace)
            : clipped;
    return `${safeCut.replace(/[.!?。！？,;:]+$/u, "")}…`;
}

// @source-order 168
function normalizeCharacterCorrectionText(value) {
    const normalized = String(value || "")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (!normalized) return "";
    const wordChunks = normalized.match(/\S+(?:\s+|$)/g) || [];
    const wordLimited =
        wordChunks.length > CHARACTER_CORRECTION_MAX_WORDS
            ? wordChunks.slice(0, CHARACTER_CORRECTION_MAX_WORDS).join("").trim()
            : normalized;
    if (wordLimited.length <= CHARACTER_CORRECTION_MAX_CHARS) return wordLimited;
    const clipped = wordLimited.slice(0, CHARACTER_CORRECTION_MAX_CHARS).trimEnd();
    const lastSpace = clipped.lastIndexOf(" ");
    return lastSpace >= Math.floor(CHARACTER_CORRECTION_MAX_CHARS * 0.8)
        ? clipped.slice(0, lastSpace)
        : clipped;
}

export { getAuditReasonMaxChars, getAuditReasonSchemaMaxChars, hashStableText, normalizeAuditReason, normalizeCharacterCorrectionText };
