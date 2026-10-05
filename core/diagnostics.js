// StoryBooster: core/diagnostics.js
import { BACKGROUND_REQUEST_TIMEOUT_MS, ERROR_LOG_STORAGE_KEY, MAX_ERROR_LOG_ENTRIES, MODULE_NAME, STORYBOOSTER_VERSION } from "./constants.js";
import { extractJsonObject } from "./responses.js";
import { recordedErrorObjects, runtime } from "./runtime.js";
import { getContext } from "./sillytavern.js";

// @source-order 62
function getDiagnosticSessionStorage() {
    try {
        return globalThis.sessionStorage || null;
    } catch {
        return null;
    }
}

// @source-order 63
function sanitizeDiagnosticText(value, maxChars = 500) {
    return String(value ?? "")
        .replace(
            /<(character_card|character_baseline|roleplay_transcript|plot_event|display_anchor)[^>]*>[\s\S]*?<\/\1>/gi,
            "<$1>[내용 제거]</$1>"
        )
        .replace(
            /"(?:content|prompt|transcript|characterCard|character_card|rawResponse|raw_response)"\s*:\s*"(?:\\.|[^"\\])*"/gi,
            '"[원문 필드]":"[내용 제거]"'
        )
        .replace(
            /(?:["']?(?:content|prompt|transcript|characterCard|character_card|rawResponse|raw_response)["']?)\s*:\s*'(?:\\.|[^'\\])*'/gi,
            '"[원문 필드]":"[내용 제거]"'
        )
        .replace(
            /(?:["']?(?:content|prompt|transcript|characterCard|character_card|rawResponse|raw_response)["']?)\s*:\s*`[\s\S]*?`/gi,
            '"[원문 필드]":"[내용 제거]"'
        )
        .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[인증 정보 제거]")
        .replace(
            /\b(?:sk|gsk|xai)[-_][A-Za-z0-9_-]{8,}\b/g,
            "[인증 정보 제거]"
        )
        .replace(
            /\b(?:hf_|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/g,
            "[인증 정보 제거]"
        )
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [인증 정보 제거]")
        .replace(
            /(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
            "$1=[인증 정보 제거]"
        )
        .replace(
            /\b[A-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/gi,
            "[로컬 경로 제거]"
        )
        .replace(/\/(?:home|Users|data\/data)\/[^\s"'<>]+/g, "[로컬 경로 제거]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[이메일 제거]")
        .replace(/https?:\/\/[^\s"')]+/gi, "[접속 주소 제거]")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
        .trim()
        .slice(0, maxChars);
}

// @source-order 64
function getSillyTavernDiagnosticVersion() {
    let context = null;
    try {
        context = getContext?.();
    } catch {
        context = null;
    }
    return sanitizeDiagnosticText(
        context?.version ||
            globalThis.SillyTavern?.version ||
            globalThis.power_user?.version ||
            "확인 불가",
        80
    );
}

// @source-order 65
function getErrorDiagnosticStage(error, fallback = "unknown") {
    const code = String(error?.code || "").toUpperCase();
    const message = String(error?.message || "");
    if (code.includes("TIMEOUT")) return "request_timeout";
    if (code.includes("BUDGET_EXHAUSTED")) return "request_budget";
    if (code.includes("PROFILE")) return "connection_profile";
    if (
        code.includes("TRUNCATED") ||
        code.includes("INCOMPLETE_JSON") ||
        code.includes("INCOMPLETE_TAGGED_OUTPUT")
    ) {
        return "response_completion";
    }
    if (code.includes("EMPTY_STRUCTURED_OUTPUT")) return "response_empty";
    if (code.includes("REASONING_ONLY_OUTPUT")) return "response_reasoning";
    if (
        code.includes("INCOMPLETE_RATINGS") ||
        code.includes("BASELINE_INCOMPLETE") ||
        code.includes("REQUIRED_FIELDS_MISSING") ||
        code.includes("INVALID_FIELDS")
    ) {
        return "required_field_validation";
    }
    if (code.includes("PARSE") || error instanceof SyntaxError) return "json_parsing";
    if (/api request failed|network|failed to fetch/i.test(message)) {
        return "request_transport";
    }
    return fallback;
}

// @source-order 66
function getErrorDiagnosticLocation(error) {
    const stack = String(error?.stack || "");
    const matches = [...stack.matchAll(/(?:index\.js|storybooster[^\s/\\]*\.js):(\d+):(\d+)/gi)]
        .slice(0, 3)
        .map((match) => `index.js:${match[1]}:${match[2]}`);
    return [...new Set(matches)].join(", ");
}

// @source-order 67
function describeDiagnosticValue(value, prefix = "", depth = 0) {
    if (!value || typeof value !== "object" || depth > 1) return [];
    const entries = [];
    for (const [key, child] of Object.entries(value).slice(0, 40)) {
        const safeKey = /^[A-Za-z0-9_.-]{1,80}$/.test(key)
            ? key
            : "[비표준 필드]";
        const path = prefix ? `${prefix}.${safeKey}` : safeKey;
        if (Array.isArray(child)) {
            entries.push(`${path}:array(${child.length})`);
        } else if (child && typeof child === "object") {
            entries.push(`${path}:object`);
            entries.push(...describeDiagnosticValue(child, path, depth + 1));
        } else if (typeof child === "string") {
            entries.push(`${path}:string(${child.length})`);
        } else {
            entries.push(`${path}:${typeof child}`);
        }
    }
    return entries;
}

// @source-order 68
function getGenerationFinishReason(data) {
    return sanitizeDiagnosticText(
        data?.finish_reason ||
            data?.finishReason ||
            data?.choices?.[0]?.finish_reason ||
            data?.choices?.[0]?.finishReason ||
            data?.candidates?.[0]?.finishReason ||
            "",
        80
    );
}

// @source-order 69
function createOperationDiagnostic({
    task = "unknown",
    responseLength = 0,
    connectionMode = "main",
} = {}) {
    return {
        operationId: `SB-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 6)}`.toUpperCase(),
        task: sanitizeDiagnosticText(task, 80) || "unknown",
        startedAt: Date.now(),
        responseLength: Number(responseLength) || 0,
        connectionMode: connectionMode === "profile" ? "별도 연결" : "현재 채팅 연결",
        model: "",
        apiType: "",
        method: "",
        requestCount: 0,
        retryCount: 0,
        promptChars: 0,
        transcriptChars: 0,
        inputChars: 0,
        contextItems: 0,
        responseChars: 0,
        responseFormat: "",
        finishReason: "",
        returnedFields: [],
        compatibilityFallback: false,
        retryReason: "",
    };
}

// @source-order 70
function updateOperationDiagnosticInput(diagnostic, prompt, transcript) {
    if (!diagnostic) return;
    const promptText = String(prompt || "");
    const transcriptText = String(transcript || "");
    const numberedResponses = (
        transcriptText.match(/\[CHAR_RESPONSE_\d+:/g) || []
    ).length;
    const roleBlocks = (
        transcriptText.match(/\[(?:USER_CONTEXT|CHAR|USER):/g) || []
    ).length;
    diagnostic.promptChars = promptText.length;
    diagnostic.transcriptChars = transcriptText.length;
    diagnostic.inputChars = promptText.length + transcriptText.length;
    diagnostic.contextItems = Math.max(numberedResponses, roleBlocks);
}

// @source-order 71
function updateOperationDiagnosticConnection(diagnostic, connectionSnapshot) {
    if (!diagnostic) return;
    let context = null;
    try {
        context = getContext?.();
    } catch {
        context = null;
    }
    diagnostic.connectionMode =
        connectionSnapshot?.source === "profile" ? "별도 연결" : "현재 채팅 연결";
    diagnostic.model = sanitizeDiagnosticText(
        connectionSnapshot?.model ||
            context?.chatCompletionSettings?.model ||
            context?.chatCompletionSettings?.openai_model ||
            globalThis.oai_settings?.openai_model ||
            globalThis.textgenerationwebui_settings?.custom_model ||
            "",
        120
    );
    diagnostic.apiType = sanitizeDiagnosticText(
        connectionSnapshot?.apiType ||
            context?.mainApi ||
            globalThis.main_api ||
            "",
        80
    );
}

// @source-order 72
function captureOperationResponseDiagnostic(diagnostic, data, text, method) {
    if (!diagnostic) return;
    diagnostic.method = sanitizeDiagnosticText(method || "", 80);
    diagnostic.responseChars = String(text || "").length;
    diagnostic.finishReason = getGenerationFinishReason(data);
    const direct = String(text || "").trim();
    diagnostic.responseFormat = direct.startsWith("{")
        ? "json-like"
        : direct.startsWith("```")
          ? "markdown-fence"
          : typeof data === "object" && data !== null
            ? "provider-object"
            : typeof data;
    try {
        const parsed = extractJsonObject(text, "");
        diagnostic.returnedFields = describeDiagnosticValue(parsed);
    } catch {
        diagnostic.returnedFields = [];
    }
}

// @source-order 73
function readStoryBoosterErrorLog() {
    const storage = getDiagnosticSessionStorage();
    if (!storage) return [];
    try {
        const parsed = JSON.parse(storage.getItem(ERROR_LOG_STORAGE_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.slice(0, MAX_ERROR_LOG_ENTRIES) : [];
    } catch {
        return [];
    }
}

// @source-order 74
function writeStoryBoosterErrorLog(entries) {
    const storage = getDiagnosticSessionStorage();
    if (!storage) return;
    try {
        storage.setItem(
            ERROR_LOG_STORAGE_KEY,
            JSON.stringify(entries.slice(0, MAX_ERROR_LOG_ENTRIES))
        );
    } catch (error) {
        console.warn(`[${MODULE_NAME}] could not store error diagnostic log`, error);
    }
}

// @source-order 75
function refreshStoryBoosterErrorLogBadge() {
    const badge = document.getElementById("rp-error-log-count");
    if (!badge) return;
    const count = readStoryBoosterErrorLog().length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
}

// @source-order 76
function recordStoryBoosterError(error, details = {}) {
    if (error && typeof error === "object") {
        if (recordedErrorObjects.has(error)) return null;
        recordedErrorObjects.add(error);
    }
    const diagnostic = details.diagnostic || {};
    const missingFields = [
        ...(Array.isArray(details.missingFields) ? details.missingFields : []),
        ...(Array.isArray(error?.missingFields) ? error.missingFields : []),
    ]
        .map((item) => sanitizeDiagnosticText(item, 100))
        .filter(Boolean);
    const invalidFields = [
        ...(Array.isArray(details.invalidFields) ? details.invalidFields : []),
        ...(Array.isArray(error?.invalidFields) ? error.invalidFields : []),
    ]
        .map((item) => sanitizeDiagnosticText(item, 100))
        .filter(Boolean);
    const errorMessage = sanitizeDiagnosticText(
        error?.message || details.message || String(error || "알 수 없는 오류"),
        700
    );
    const task = sanitizeDiagnosticText(details.task || diagnostic.task || "unknown", 80);
    const stage = sanitizeDiagnosticText(
        details.stage || getErrorDiagnosticStage(error, "unknown"),
        80
    );
    const code = sanitizeDiagnosticText(error?.code || details.code || "", 100);
    const fingerprint = [task, stage, code, errorMessage].join("|");
    const now = Date.now();
    const entry = {
        id:
            diagnostic.operationId ||
            `SB-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase(),
        firstOccurredAt: now,
        lastOccurredAt: now,
        count: 1,
        storyBoosterVersion: STORYBOOSTER_VERSION,
        sillyTavernVersion: getSillyTavernDiagnosticVersion(),
        task,
        stage,
        connectionMode: sanitizeDiagnosticText(
            details.connectionMode || diagnostic.connectionMode || "확인 불가",
            40
        ),
        model: sanitizeDiagnosticText(details.model || diagnostic.model || "확인 불가", 120),
        apiType: sanitizeDiagnosticText(details.apiType || diagnostic.apiType || "확인 불가", 80),
        method: sanitizeDiagnosticText(details.method || diagnostic.method || "확인 불가", 80),
        responseLength: Number(details.responseLength || diagnostic.responseLength) || 0,
        timeoutMs: Number(details.timeoutMs || BACKGROUND_REQUEST_TIMEOUT_MS) || 0,
        requestCount: Number(details.requestCount || diagnostic.requestCount) || 0,
        retryCount: Number(details.retryCount || diagnostic.retryCount) || 0,
        promptChars: Number(details.promptChars || diagnostic.promptChars) || 0,
        transcriptChars:
            Number(details.transcriptChars || diagnostic.transcriptChars) || 0,
        inputChars: Number(details.inputChars || diagnostic.inputChars) || 0,
        contextItems: Number(details.contextItems || diagnostic.contextItems) || 0,
        elapsedMs: Math.max(
            0,
            Number(details.elapsedMs) ||
                (Number(diagnostic.startedAt)
                    ? Date.now() - Number(diagnostic.startedAt)
                    : 0)
        ),
        httpStatus: sanitizeDiagnosticText(
            error?.status || error?.statusCode || details.httpStatus || "",
            40
        ),
        finishReason: sanitizeDiagnosticText(
            details.finishReason || diagnostic.finishReason || "",
            80
        ),
        errorCode: code,
        errorMessage,
        responseChars: Number(details.responseChars || diagnostic.responseChars) || 0,
        responseFormat: sanitizeDiagnosticText(
            details.responseFormat || diagnostic.responseFormat || "",
            80
        ),
        returnedFields: [
            ...(Array.isArray(details.returnedFields) ? details.returnedFields : []),
            ...(Array.isArray(diagnostic.returnedFields)
                ? diagnostic.returnedFields
                : []),
        ]
            .map((item) => sanitizeDiagnosticText(item, 120))
            .filter(Boolean)
            .slice(0, 40),
        compatibilityFallback: Boolean(
            details.compatibilityFallback ?? diagnostic.compatibilityFallback
        ),
        retryReason: sanitizeDiagnosticText(
            details.retryReason || diagnostic.retryReason || "",
            160
        ),
        missingFields: [...new Set(missingFields)].slice(0, 30),
        invalidFields: [...new Set(invalidFields)].slice(0, 30),
        location: getErrorDiagnosticLocation(error),
        fingerprint,
    };
    const entries = readStoryBoosterErrorLog();
    const existingIndex = entries.findIndex((item) => item?.fingerprint === fingerprint);
    if (existingIndex >= 0) {
        const existing = entries.splice(existingIndex, 1)[0];
        if (existing.id === entry.id) {
            entries.unshift(existing);
            writeStoryBoosterErrorLog(entries);
            refreshStoryBoosterErrorLogBadge();
            return existing;
        }
        entry.firstOccurredAt = Number(existing.firstOccurredAt) || now;
        entry.count = Math.max(1, Number(existing.count) || 1) + 1;
    }
    entries.unshift(entry);
    writeStoryBoosterErrorLog(entries);
    refreshStoryBoosterErrorLogBadge();
    if (details.notify !== false && Date.now() - runtime.lastErrorLogHintAt > 2500) {
        runtime.lastErrorLogHintAt = Date.now();
        toastr?.info?.(
            "문제가 발생하면 오류 진단 로그를 복사해 문의해 주세요."
        );
    }
    return entry;
}

// @source-order 77
function clearStoryBoosterErrorLog() {
    writeStoryBoosterErrorLog([]);
    refreshStoryBoosterErrorLogBadge();
}

// @source-order 78
function formatStoryBoosterErrorEntry(entry, index) {
    const lines = [
        `[오류 진단 로그 ${index + 1}]`,
        `발생: ${new Date(entry.lastOccurredAt).toLocaleString("ko-KR")}`,
        `동일 오류 발생: ${entry.count || 1}회`,
        `스토리부스터: ${entry.storyBoosterVersion || "확인 불가"}`,
        `SillyTavern: ${entry.sillyTavernVersion || "확인 불가"}`,
        `작업: ${entry.task || "확인 불가"}`,
        `실패 단계: ${entry.stage || "확인 불가"}`,
        `연결: ${entry.connectionMode || "확인 불가"}`,
        `모델/API: ${entry.model || "확인 불가"} / ${entry.apiType || "확인 불가"}`,
        `요청 방식: ${entry.method || "확인 불가"}`,
        `출력 한도: ${entry.responseLength || "확인 불가"}`,
        `입력 규모: ${entry.inputChars || 0}자 · 맥락 ${entry.contextItems || 0}개`,
        `프롬프트/대화: ${entry.promptChars || 0}자 / ${entry.transcriptChars || 0}자`,
        `소요 시간: ${entry.elapsedMs ? `${Math.round(entry.elapsedMs / 100) / 10}초` : "확인 불가"}`,
        `요청/재시도: ${entry.requestCount || 0}회 / ${entry.retryCount || 0}회`,
        `호환 재시도: ${entry.compatibilityFallback ? "사용" : "미사용"}${
            entry.retryReason ? ` · ${entry.retryReason}` : ""
        }`,
        `HTTP/종료 사유: ${entry.httpStatus || "없음"} / ${entry.finishReason || "없음"}`,
        `오류 코드: ${entry.errorCode || "없음"}`,
        `오류 메시지: ${entry.errorMessage || "없음"}`,
        `응답 구조: ${entry.responseFormat || "확인 불가"} · ${entry.responseChars || 0}자`,
        `반환 필드: ${entry.returnedFields?.join(", ") || "확인 불가"}`,
        `누락 필드: ${entry.missingFields?.join(", ") || "없음"}`,
        `잘못된 필드: ${entry.invalidFields?.join(", ") || "없음"}`,
        `오류 위치: ${entry.location || "확인 불가"}`,
        `식별번호: ${entry.id || "없음"}`,
    ];
    return lines.join("\n");
}

export { captureOperationResponseDiagnostic, clearStoryBoosterErrorLog, createOperationDiagnostic, describeDiagnosticValue, formatStoryBoosterErrorEntry, getDiagnosticSessionStorage, getErrorDiagnosticLocation, getErrorDiagnosticStage, getGenerationFinishReason, getSillyTavernDiagnosticVersion, readStoryBoosterErrorLog, recordStoryBoosterError, refreshStoryBoosterErrorLogBadge, sanitizeDiagnosticText, updateOperationDiagnosticConnection, updateOperationDiagnosticInput, writeStoryBoosterErrorLog };
