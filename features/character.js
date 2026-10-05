// StoryBooster: features/character.js
import { CHARACTER_BASELINE_AUTOSAVE_DELAY, CHARACTER_BASELINE_FIELDS, CHARACTER_BASELINE_FIELD_MAX_CHARS, CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS, CHARACTER_BOOST_ANCHOR_MAX_CHARS, CHARACTER_CARD_INPUT_MAX_CHARS, CHARACTER_REVISION_ASSISTANT_REPLIES, CHARACTER_REVISION_NOTE_MAX_CHARS, CHARACTER_REVISION_TRANSCRIPT_MAX_CHARS, MAX_CHARACTER_BASELINE_VERSIONS, MODULE_NAME, PLOT_MESSAGE_MAX_CHARS } from "../core/constants.js";
import { createOperationContextSnapshot, getCurrentCharacterIdentity, getCurrentChatId, getRoleplayTranscript, isOperationContextCurrentCharacter, isOperationContextCurrentChat, resolveRoleMacrosForDisplay, snapshotCurrentChatMessages } from "../core/context.js";
import { createOperationDiagnostic, recordStoryBoosterError, updateOperationDiagnosticConnection } from "../core/diagnostics.js";
import { getActiveBoosterPopupRoot, getBoosterElement, getBoosterElements } from "../core/dom.js";
import { generateStructuredAnalysis, requestStructuredJsonWithCompatibility, resolveBackgroundConnectionSnapshot } from "../core/requests.js";
import { extractJsonObject, extractTextFromGenerationData, parseJsonOrTaggedPayload, requireStructuredTextFields } from "../core/responses.js";
import { characterBaselineAutosaveTimers, characterBaselinePendingTasks, characterBaselineRevisionProposals } from "../core/runtime.js";
import { saveSettingsDebounced } from "../core/sillytavern.js";
import { createCharacterBaselineVersion, createEmptyCharacterBaseline, ensureCharacterBoostState, ensureChatState, ensureGenreAnchorState, ensureModuleSettings, getCharacterBaselineVersion, getCharacterBaselineVersionOptions, getCharacterBaselineVersionStore, getCharacterCardChangeStatus, getCurrentCharacterBaseline, getGlobalAuditInterval, isBoosterFeatureEnabled, normalizeCharacterBaseline, serializeCharacterBaseline, writeCharacterBaselineVersion } from "../core/storage.js";
import { safelyUpdateCharacterBoosterPanel, safelyUpdateGenreAnchorPanel, updateCharacterBaselineActionStates } from "../core/ui-hooks.js";
import { safelyUpdateGenrePrompt } from "./audit.js";
import { invalidateCharacterAuditState } from '../core/character-audit-state.js';

// @source-order 137
function selectCharacterBaselineVersion(versionId = "") {
    const chatId = String(getCurrentChatId());
    const identity = getCurrentCharacterIdentity();
    if (!identity) return false;
    const id = String(versionId || "");
    if (id && !getCharacterBaselineVersion(identity.key, id)) return false;
    characterBaselineRevisionProposals.delete(
        getCharacterRevisionProposalKey(identity.key, chatId)
    );
    ensureCharacterBoostState(ensureChatState(chatId)).baselineVersionId = id;
    invalidateCharacterAuditAfterBaselineChange(chatId);
    saveSettingsDebounced();
    safelyUpdateGenrePrompt("캐릭터 기준 버전 변경");
    safelyUpdateGenreAnchorPanel("캐릭터 기준 버전 변경");
    return true;
}

// @source-order 138
function duplicateCurrentCharacterBaselineVersion() {
    if (!isBoosterFeatureEnabled("character")) {
        toastr?.info?.("전역 설정에서 캐릭터 부스터를 켜 주세요.");
        return;
    }
    const baselineState = getCurrentCharacterBaseline();
    if (!baselineState.identity || !baselineState.baseline) {
        toastr?.warning?.("먼저 캐릭터 원본 기준을 만들어 주세요.");
        return;
    }
    if (characterBaselinePendingTasks.has(baselineState.identity.key)) return;
    if (
        getCharacterBaselineVersionOptions(baselineState.identity.key).length >=
        MAX_CHARACTER_BASELINE_VERSIONS
    ) {
        toastr?.warning?.(
            `갱신본은 최대 ${MAX_CHARACTER_BASELINE_VERSIONS}개입니다. 사용하지 않는 갱신본을 삭제해 주세요.`
        );
        return;
    }
    const chatId = String(getCurrentChatId());
    const copiedBaseline = normalizeCharacterBaseline(baselineState.baseline);
    if (!copiedBaseline) return;
    const record = createCharacterBaselineVersion(
        baselineState.identity,
        copiedBaseline,
        {
            chatId,
            parentVersionId: String(baselineState.versionId || ""),
        }
    );
    if (!record) {
        toastr?.error?.("현재 기준의 복사본을 만들지 못했습니다.");
        return;
    }
    characterBaselineRevisionProposals.delete(
        getCharacterRevisionProposalKey(baselineState.identity.key, chatId)
    );
    invalidateCharacterAuditAfterBaselineChange(chatId);
    saveSettingsDebounced();
    safelyUpdateGenrePrompt("캐릭터 기준 복사본 생성");
    safelyUpdateGenreAnchorPanel("캐릭터 기준 복사본 생성");
    toastr?.success?.(
        `「${record.label}」을 만들고 현재 채팅의 사용 기준으로 선택했어요.`
    );
}

// @source-order 139
function renameCurrentCharacterBaselineVersion() {
    const baselineState = getCurrentCharacterBaseline();
    if (!baselineState.identity || !baselineState.versionId) return;
    const nextLabel = window.prompt(
        "갱신본 이름을 입력하세요.",
        baselineState.versionLabel
    );
    if (nextLabel === null) return;
    const label = String(nextLabel)
        .trim()
        .slice(0, CHARACTER_BASELINE_VERSION_LABEL_MAX_CHARS);
    if (!label) {
        toastr?.warning?.("버전 이름을 비워 둘 수 없습니다.");
        return;
    }
    const store = getCharacterBaselineVersionStore(baselineState.identity.key, {
        create: true,
    });
    const record = store.versions[baselineState.versionId];
    if (!record) return;
    record.label = label;
    record.updatedAt = Date.now();
    ensureModuleSettings().characterBaselineVersions[
        baselineState.identity.key
    ] = store;
    saveSettingsDebounced();
    safelyUpdateCharacterBoosterPanel("캐릭터 기준 버전 이름 변경");
}

// @source-order 140
function deleteCurrentCharacterBaselineVersion() {
    const baselineState = getCurrentCharacterBaseline();
    if (!baselineState.identity || !baselineState.versionId) return;
    if (
        !window.confirm(
            `「${baselineState.versionLabel}」을 삭제할까요? 원본은 유지됩니다.`
        )
    ) {
        return;
    }
    const settings = ensureModuleSettings();
    const store = getCharacterBaselineVersionStore(baselineState.identity.key, {
        create: true,
    });
    delete store.versions[baselineState.versionId];
    if (Object.keys(store.versions).length) {
        settings.characterBaselineVersions[baselineState.identity.key] = store;
    } else {
        delete settings.characterBaselineVersions[baselineState.identity.key];
    }
    const affectedChatIds = [];
    for (const [chatId, state] of Object.entries(settings.chats || {})) {
        if (state?.characterBoost?.baselineVersionId === baselineState.versionId) {
            state.characterBoost.baselineVersionId = "";
            affectedChatIds.push(chatId);
        }
    }
    if (affectedChatIds.length) {
        affectedChatIds.forEach((chatId) =>
            invalidateCharacterAuditAfterBaselineChange(chatId)
        );
    } else {
        invalidateCharacterAuditAfterBaselineChange();
    }
    saveSettingsDebounced();
    safelyUpdateGenrePrompt("캐릭터 기준 버전 삭제");
    safelyUpdateGenreAnchorPanel("캐릭터 기준 버전 삭제");
}

// @source-order 142
function notifyCharacterCardChangeIfNeeded() {
    const status = getCharacterCardChangeStatus();
    if (!status.changed || status.alreadyNotified || !status.identity?.key) {
        return status;
    }
    status.baseline.notifiedSourceHash = status.currentHash;
    writeCharacterBaselineVersion(
        status.identity,
        status.baseline,
        status.versionId
    );
    saveSettingsDebounced();
    toastr?.info?.(
        "캐릭터 카드의 변경을 감지했어요. 현재는 기존 기준과 앵커로 계속 부스팅하고 있어요."
    );
    return { ...status, alreadyNotified: true };
}

// @source-order 143
function acknowledgeCharacterCardChange() {
    const status = getCharacterCardChangeStatus();
    if (!status.identity?.key || !status.baseline) return false;
    status.baseline.sourceHash = status.currentHash;
    status.baseline.notifiedSourceHash = "";
    status.baseline.updatedAt = Date.now();
    writeCharacterBaselineVersion(
        status.identity,
        status.baseline,
        status.versionId
    );
    saveSettingsDebounced();
    safelyUpdateCharacterBoosterPanel("캐릭터 카드 변경 확인");
    toastr?.success?.("현재 캐릭터 기준과 앵커를 그대로 유지합니다.");
    return true;
}

// @source-order 216
function getCharacterRevisionBaselineSignature(baseline) {
    // Pins are rechecked independently at approval. Content changes invalidate
    // an old proposal even when the selected version ID has not changed.
    return JSON.stringify(CHARACTER_BASELINE_FIELDS.map(({ id }) => [
        id, String(baseline?.fields?.[id]?.text || "").trim(),
    ]));
}

// @source-order 217
function ensureCharacterRevisionReview(proposal) {
    if (!proposal.reviewFields) {
        proposal.reviewFields = Object.fromEntries(proposal.changedFields.map((fieldId) => {
            const text = resolveRoleMacrosForDisplay(proposal.fields[fieldId].text);
            return [fieldId, { included: true, text, originalDisplayText: text }];
        }));
    }
    return proposal.reviewFields;
}

// @source-order 218
function captureCharacterRevisionReview(element) {
    const container = element?.closest?.(".rp-character-revision-proposal");
    const proposal = characterBaselineRevisionProposals.get(container?.dataset.proposalKey);
    if (!proposal || String(proposal.createdAt) !== container.dataset.proposalCreatedAt) return;
    const fieldId = element.dataset.fieldId;
    const review = ensureCharacterRevisionReview(proposal)[fieldId];
    if (!review) return;
    if (element.classList.contains("rp-character-revision-include")) {
        review.included = element.checked;
    } else if (element.classList.contains("rp-character-revision-field")) {
        review.text = element.value;
    }
}

// @source-order 219
function invalidateCharacterAuditAfterBaselineChange(chatId = getCurrentChatId(), { sharedVersionId = '' } = {}) {
    const affected = new Set([String(chatId)]);
    if (sharedVersionId) {
        for (const [id, state] of Object.entries(ensureModuleSettings().chats || {})) {
            if (state?.characterBoost?.baselineVersionId === sharedVersionId) affected.add(id);
        }
    }
    for (const id of affected) {
        invalidateCharacterAuditState(ensureGenreAnchorState(ensureChatState(id)), getGlobalAuditInterval());
    }
}

// @source-order 220
function getCharacterBaselineFieldDefinition(fieldId) {
    return CHARACTER_BASELINE_FIELDS.find((field) => field.id === fieldId) || null;
}

// @source-order 221
function getCharacterBoostAnchorRequirements(
    outputLanguage = ensureModuleSettings().outputLanguage
) {
    return [
        `Write boost_anchor in grammatical English as a synthesized character-specific reminder, usually 70 to 110 words and never more than ${CHARACTER_BOOST_ANCHOR_MAX_CHARS} characters.`,
        "Prioritize only supported distinctions: the character's defining tension, behaviorally relevant values or boundaries, decision logic and action triggers, speech or emotional signature, and relationship-specific response pattern.",
        "Do not list the baseline fields. Exclude appearance, biography, setting lore, and plot summary unless they directly govern recurring behavior.",
        "Avoid absolute claims such as always, never, completely, or zero unless the baseline explicitly establishes them.",
        "Do not add generic instructions about agency, continuity, prose variety, or user control; those are supplied separately.",
        outputLanguage === "ko"
            ? "Also write boost_anchor_display as a faithful natural Korean display version that preserves every point without adding interpretation."
            : "",
    ]
        .filter(Boolean)
        .join(" ");
}

// @source-order 222
function buildCharacterBaselinePrompt(
    targetFields,
    contextFields = [],
    outputLanguage = ensureModuleSettings().outputLanguage,
    includeBoostAnchor = true
) {
    const targetList = targetFields
        .map((field) => `- ${field.id} (${field.label}): ${field.prompt}`)
        .join("\n");
    const retainedContext = contextFields
        .map(({ definition, text }) =>
            text ? `[${definition.label} — preserve as context]\n${text}` : ""
        )
        .filter(Boolean)
        .join("\n\n");
    const jsonExample = Object.fromEntries(
        targetFields.map((field) => [field.id, "..."])
    );
    return [
        "Extract a compact, evidence-bound roleplay baseline for the supplied character.",
        "Use only the supplied character card. Do not continue roleplay and do not invent missing traits, trauma, moral judgments, hidden virtues, flaws, contradictions, or relationships.",
        "Do not prioritize appearance, long setting lore, plot summary, or lengthy examples unless they directly constrain personality, speech, or behavior.",
        "Preserve deliberate simplicity, strong archetypal traits, and genuine contradictions. Do not make the character artificially balanced or more conventionally sympathetic.",
        "Give each fact one best home. Keep the fields complementary rather than repeating the same description, and distinguish stable character logic from a one-scene mood or circumstance.",
        outputLanguage === "en"
            ? "Write each requested field in natural English using one to three concise sentences. Keep it specific enough for later consistency auditing and avoid repeating the same fact across fields."
            : "Write each requested field in natural Korean using one to three concise sentences. Keep it specific enough for later consistency auditing and avoid repeating the same fact across fields. Do not write English prose except for established proper nouns.",
        includeBoostAnchor
            ? getCharacterBoostAnchorRequirements(outputLanguage)
            : "Generate only the requested field. Do not generate or rewrite boost_anchor for this single-field request.",
        "FIELDS TO GENERATE:",
        targetList,
        retainedContext
            ? `EXISTING FIELDS TO PRESERVE AND USE ONLY AS CONTEXT:\n${retainedContext}`
            : "",
        `Return JSON only in this exact shape: ${JSON.stringify(
            includeBoostAnchor
                ? {
                      fields: jsonExample,
                      boost_anchor: "English character-specific anchor",
                      ...(outputLanguage === "ko"
                          ? { boost_anchor_display: "한국어 표시용 앵커" }
                          : {}),
                  }
                : { fields: jsonExample }
        )}.`,
    ].join("\n");
}

// @source-order 223
function normalizeCharacterBaselineGenerationPayload(value, targetFields) {
    const parsed = value && typeof value === "object" ? value : {};
    const roots = [
        parsed,
        parsed.character_baseline,
        parsed.characterBaseline,
        parsed.baseline,
        parsed.result,
    ].filter((entry) => entry && typeof entry === "object");
    const fieldContainers = roots
        .flatMap((entry) => [entry.fields, entry])
        .filter((entry) => entry && typeof entry === "object");
    const fields = {};

    for (const definition of targetFields) {
        let rawValue;
        for (const container of fieldContainers) {
            rawValue = container[definition.id] ?? container[definition.label];
            if (rawValue !== undefined && rawValue !== null) break;
        }
        if (rawValue && typeof rawValue === "object") {
            rawValue = rawValue.text ?? rawValue.value ?? rawValue.summary ?? "";
        }
        fields[definition.id] = String(rawValue ?? "").trim();
    }

    const readRootValue = (...keys) => {
        for (const root of roots) {
            for (const key of keys) {
                if (root[key] !== undefined && root[key] !== null) {
                    return root[key];
                }
            }
        }
        return "";
    };

    return {
        fields,
        boost_anchor: String(
            readRootValue("boost_anchor", "boostAnchor") || ""
        ).trim(),
        boost_anchor_display: String(
            readRootValue("boost_anchor_display", "boostAnchorDisplay") || ""
        ).trim(),
    };
}

// @source-order 224
function getCharacterBaselineGenerationIssues(
    parsed,
    targetFields,
    { includeBoostAnchor = true, outputLanguage = "ko" } = {}
) {
    const issues = targetFields
        .filter(
            (definition) =>
                String(parsed?.fields?.[definition.id] || "").trim().length < 10
        )
        .map((definition) => definition.label);
    if (
        includeBoostAnchor &&
        String(parsed?.boost_anchor || "").trim().length < 30
    ) {
        issues.push("영문 캐릭터 앵커");
    }
    if (
        includeBoostAnchor &&
        outputLanguage === "ko" &&
        String(parsed?.boost_anchor_display || "").trim().length < 15
    ) {
        issues.push("한국어 표시용 캐릭터 앵커");
    }
    return issues;
}

// @source-order 225
function getCharacterRevisionProposalKey(
    identityKey = getCurrentCharacterIdentity()?.key || "",
    chatId = getCurrentChatId()
) {
    return `${String(chatId)}::${String(identityKey)}`;
}

// @source-order 226
function buildCharacterBaselineRevisionPrompt(
    baseline,
    outputLanguage = ensureModuleSettings().outputLanguage,
    userDirection = "",
    mode = "directed"
) {
    const pinnedFields = CHARACTER_BASELINE_FIELDS.filter(
        (definition) => baseline?.fields?.[definition.id]?.pinned
    );
    const languageInstruction =
        outputLanguage === "en"
            ? "Write every field in natural English."
            : "Write every field in natural Korean. Do not use English prose except for established proper nouns.";
    const isDirected = mode === "directed";
    return [
        isDirected
            ? "Revise the complete roleplay character baseline in the direction explicitly requested by the user. The user's requested direction is the primary editing instruction, not a hypothesis that the transcript must approve or reject."
            : "Inspect the supplied recent roleplay and revise the complete character baseline only where it demonstrates a sustained, causally supported change.",
        isDirected
            ? "Use the recent roleplay only to calibrate how the requested development appears in behavior, speech, relationships, scope, and intensity. If recent evidence is sparse, still create the requested revision and report that limitation instead of refusing the change."
            : "The existing baseline is the reference point, not an error to correct. Preserve every field verbatim unless repeated behavior across the transcript clearly establishes a lasting development.",
        "Preserve every unrelated field verbatim. Integrate development into the existing personality instead of replacing the character with a newly invented or generically improved personality.",
        "Do not convert a temporary mood, one scene, situational compliance, intoxication, coercion, exceptional crisis, or a single affectionate/hostile moment into a permanent personality change.",
        isDirected
            ? "Do not exaggerate beyond the user's requested direction. Do not make the character kinder, softer, healthier, more balanced, more romantic, or more sympathetic unless the request calls for that specific development."
            : "Do not make the character kinder, softer, healthier, more balanced, more romantic, or more sympathetic unless the transcript repeatedly and specifically supports that change.",
        "Keep relationship-specific development scoped to the relevant relationship. Do not turn behavior toward {{user}} into a universal trait unless the transcript supports that generalization.",
        "Preserve contradictions, boundaries, negative traits, decision logic, speech habits, and emotional defenses that remain active.",
        pinnedFields.length
            ? `These pinned fields must be copied exactly without any change: ${pinnedFields
                  .map((field) => field.id)
                  .join(", ")}.`
            : "No fields are pinned.",
        isDirected
            ? `The user supplied a requested direction. Apply it to at least one unpinned field: ${userDirection}`
            : "No requested direction was supplied. This is a conservative automatic scan of recent roleplay only.",
        "In revised fields, use the actual role names supplied in the input. Never introduce literal role-template placeholders in user-facing baseline text.",
        languageInstruction,
        "Return all seven fields as a complete replacement baseline. List changed_fields using only field IDs whose text truly differs. For every field, return a concise change_reasons string; use an empty string when unchanged.",
        "Set evidence_level to strong, partial, or limited. In evidence_summary, briefly distinguish what the recent roleplay supports from what follows mainly from the user's requested direction. Do not quote long passages.",
        `Field IDs: ${CHARACTER_BASELINE_FIELDS.map((field) => field.id).join(", ")}.`,
        `Return JSON only in this exact shape: ${JSON.stringify({
            fields: Object.fromEntries(
                CHARACTER_BASELINE_FIELDS.map((field) => [field.id, "..."])
            ),
            changed_fields: ["field_id"],
            change_reasons: Object.fromEntries(
                CHARACTER_BASELINE_FIELDS.map((field) => [field.id, ""])
            ),
            evidence_level: "partial",
            evidence_summary: "...",
        })}.`,
    ].join("\n");
}

// @source-order 227
function normalizeCharacterBaselineRevisionPayload(value, baseline) {
    const parsed = value && typeof value === "object" ? value : {};
    const rawFields =
        parsed.fields && typeof parsed.fields === "object" ? parsed.fields : {};
    const rawReasons =
        parsed.change_reasons && typeof parsed.change_reasons === "object"
            ? parsed.change_reasons
            : {};
    const fields = {};
    const changedFields = [];
    for (const definition of CHARACTER_BASELINE_FIELDS) {
        const currentText = String(
            baseline?.fields?.[definition.id]?.text || ""
        ).trim();
        const rawText = baseline?.fields?.[definition.id]?.pinned
            ? currentText
            : requireStructuredTextFields(rawFields, [definition.id])[definition.id];
        let text = rawText
            .trim()
            .slice(0, CHARACTER_BASELINE_FIELD_MAX_CHARS);
        if (baseline?.fields?.[definition.id]?.pinned) text = currentText;
        if (text.length < 10) {
            throw new Error(`${definition.label} 항목이 누락되었거나 지나치게 짧습니다.`);
        }
        fields[definition.id] = {
            text,
            reason: String(rawReasons[definition.id] || "")
                .trim()
                .slice(0, 500),
        };
        if (text !== currentText) changedFields.push(definition.id);
    }
    const evidenceLevel = ["strong", "partial", "limited"].includes(
        parsed.evidence_level
    )
        ? parsed.evidence_level
        : "limited";
    return {
        fields,
        changedFields,
        evidenceLevel,
        evidenceSummary: String(parsed.evidence_summary || "")
            .trim()
            .slice(0, 800),
    };
}

// @source-order 230
function extractTaggedCharacterAnchorResult(result, outputLanguage) {
    const text = extractTextFromGenerationData(result);
    const tagNames = [
        "boost_anchor",
        ...(outputLanguage === "ko" ? ["boost_anchor_display"] : []),
    ];
    const parsed = {};
    const incompleteFields = [];
    for (const tagName of tagNames) {
        const openingPattern = new RegExp(`<${tagName}>`, "i");
        const closingPattern = new RegExp(`</${tagName}>`, "i");
        const match = text.match(
            new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i")
        );
        if (match) {
            parsed[tagName] = match[1].trim();
        } else if (openingPattern.test(text) && !closingPattern.test(text)) {
            incompleteFields.push(tagName);
        }
    }
    if (incompleteFields.length) {
        const error = new Error(
            `캐릭터 앵커 태그 응답이 끝나기 전에 중단되었습니다: ${incompleteFields.join(", ")}`
        );
        error.code = "STORYBOOSTER_INCOMPLETE_TAGGED_OUTPUT";
        error.invalidFields = incompleteFields;
        throw error;
    }
    return parsed;
}

// @source-order 231
function parseCharacterBoostAnchorResult(
    result,
    outputLanguage,
    { allowTagged = false } = {}
) {
    const parsed = parseJsonOrTaggedPayload(result, {
        allowTagged,
        tagPattern: /<boost_anchor(?:_display)?>/i,
        parseTagged: (value) => extractTaggedCharacterAnchorResult(value, outputLanguage),
        emptyMessage: "Character boost anchor returned no JSON object.",
    });
    const requiredFields = [
        "boost_anchor",
        ...(outputLanguage === "ko" ? ["boost_anchor_display"] : []),
    ];
    requireStructuredTextFields(parsed, requiredFields);

    const boostAnchor = String(parsed.boost_anchor || "")
        .trim()
        .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS);
    const boostAnchorDisplay =
        outputLanguage === "ko"
            ? String(parsed.boost_anchor_display || "")
                  .trim()
                  .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS)
            : boostAnchor;
    const invalidFields = [];
    if (boostAnchor.length < 30) invalidFields.push("boost_anchor");
    if (outputLanguage === "ko" && boostAnchorDisplay.length < 15) {
        invalidFields.push("boost_anchor_display");
    }
    if (invalidFields.length) {
        const error = new Error(
            `캐릭터 앵커 필드가 지나치게 짧습니다: ${invalidFields.join(", ")}`
        );
        error.code = "STORYBOOSTER_INVALID_FIELDS";
        error.invalidFields = invalidFields;
        throw error;
    }
    return { boostAnchor, boostAnchorDisplay };
}

// @source-order 232
function shouldRetryCharacterAnchorWithoutSchema(error, connectionSnapshot) {
    const code = String(error?.code || "").toUpperCase();
    if (
        [
            "TIMEOUT",
            "PROFILE",
            "CONTEXT_CHANGED",
            "ABORT",
            "REASONING_ONLY_OUTPUT",
        ].some((marker) => code.includes(marker))
    ) {
        return false;
    }
    const message = String(error?.message || "");
    if (/unauthorized|forbidden|invalid api key|authentication/i.test(message)) {
        return false;
    }
    const status = Number(error?.status || error?.statusCode) || 0;
    if (status && ![400, 415, 422].includes(status)) return false;
    if ([400, 415, 422].includes(status)) return true;
    if (
        [
            "EMPTY_STRUCTURED_OUTPUT",
            "REQUIRED_FIELDS_MISSING",
            "INVALID_FIELDS",
            "INCOMPLETE_JSON",
            "TRUNCATED_JSON",
        ].some((marker) => code.includes(marker))
    ) {
        return true;
    }
    return connectionSnapshot?.source === "profile";
}

// @source-order 233
function shouldRetryTaggedCharacterAnchor(error) {
    const code = String(error?.code || "").toUpperCase();
    if (
        [
            "TIMEOUT",
            "PROFILE",
            "CONTEXT_CHANGED",
            "ABORT",
            "REASONING_ONLY_OUTPUT",
        ].some((marker) => code.includes(marker))
    ) {
        return false;
    }
    const message = String(error?.message || "");
    if (/unauthorized|forbidden|invalid api key|authentication/i.test(message)) {
        return false;
    }
    const status = Number(error?.status || error?.statusCode) || 0;
    if (status) return false;
    return [
        "EMPTY_STRUCTURED_OUTPUT",
        "INCOMPLETE_TAGGED_OUTPUT",
        "REQUIRED_FIELDS_MISSING",
        "INVALID_FIELDS",
    ].some((marker) => code.includes(marker));
}

// @source-order 234
async function requestCharacterBoostAnchor({
    identity,
    baseline,
    outputLanguage,
    connectionSnapshot,
    diagnostic,
    responseLength = 900,
}) {
    const basePrompt = [
        `Create a compact persistent roleplay anchor for ${identity.name} from the supplied baseline only. Do not invent or reinterpret traits.`,
        getCharacterBoostAnchorRequirements(outputLanguage),
    ].join("\n");
    const transcript = `<character_baseline>\n${serializeCharacterBaseline(
        baseline
    )}\n</character_baseline>`;
    const jsonSchema = {
        name: "storybooster_character_boost_anchor",
        strict: true,
        schema: {
            type: "object",
            properties: {
                boost_anchor: { type: "string" },
                ...(outputLanguage === "ko"
                    ? { boost_anchor_display: { type: "string" } }
                    : {}),
            },
            required: [
                "boost_anchor",
                ...(outputLanguage === "ko" ? ["boost_anchor_display"] : []),
            ],
            additionalProperties: false,
        },
    };
    const jsonOutputInstruction =
        outputLanguage === "ko"
            ? 'Return JSON only: {"boost_anchor":"English character-specific anchor","boost_anchor_display":"한국어 표시용 앵커"}.'
            : 'Return JSON only: {"boost_anchor":"English character-specific anchor"}.';
    const taggedOutputInstruction = [
        "COMPATIBILITY FALLBACK: Do not return JSON, Markdown, commentary, or any text outside the required tags.",
        outputLanguage === "ko"
            ? "Return exactly <boost_anchor>English character-specific anchor</boost_anchor><boost_anchor_display>한국어 표시용 앵커</boost_anchor_display>."
            : "Return exactly <boost_anchor>English character-specific anchor</boost_anchor>.",
        "Close every tag completely. Keep each anchor inside its own tag even if it contains punctuation.",
    ].join("\n");
    const runAttempt = async ({ tagged = false, repair = false } = {}) => {
        const result = await generateStructuredAnalysis({
            prompt: [
                basePrompt,
                tagged ? taggedOutputInstruction : jsonOutputInstruction,
                repair
                    ? "FINAL REPAIR: The previous tagged response was empty, incomplete, or invalid. Return both complete tags immediately and keep the anchors concise."
                    : "",
            ]
                .filter(Boolean)
                .join("\n"),
            transcript,
            jsonSchema: tagged ? null : jsonSchema,
            responseLength: repair
                ? Math.max(1800, responseLength * 2)
                : responseLength,
            retryOnLength: false,
            connectionSnapshot,
            task: diagnostic.task,
            diagnostic,
            recordErrors: false,
            validateJson: !tagged,
        });
        return parseCharacterBoostAnchorResult(result, outputLanguage, {
            allowTagged: tagged,
        });
    };

    try {
        return await runAttempt();
    } catch (error) {
        if (!shouldRetryCharacterAnchorWithoutSchema(error, connectionSnapshot)) {
            throw error;
        }
        diagnostic.retryCount += 1;
        diagnostic.compatibilityFallback = true;
        diagnostic.retryReason = error?.missingFields?.length
            ? "필수 앵커 필드 누락"
            : error?.invalidFields?.length
              ? "앵커 필드 길이 오류"
              : error?.code === "STORYBOOSTER_EMPTY_STRUCTURED_OUTPUT"
                ? "빈 구조화 응답"
                : "구조화 출력 요청 오류";
        try {
            return await runAttempt({ tagged: true });
        } catch (taggedError) {
            if (!shouldRetryTaggedCharacterAnchor(taggedError)) {
                throw taggedError;
            }
            diagnostic.retryCount += 1;
            diagnostic.retryReason = `${diagnostic.retryReason} · 태그 응답 복구`;
            return runAttempt({ tagged: true, repair: true });
        }
    }
}

// @source-order 235
async function generateCharacterBaselineRevisionProposal({ automatic = false } = {}) {
    if (!isBoosterFeatureEnabled("character")) {
        toastr?.info?.("전역 설정에서 캐릭터 부스터를 켜 주세요.");
        return;
    }
    const baselineState = getCurrentCharacterBaseline();
    if (!baselineState.identity || !baselineState.baseline) {
        toastr?.warning?.("먼저 캐릭터 원본 기준을 만들어 주세요.");
        return;
    }
    const { identity, baseline } = baselineState;
    if (characterBaselinePendingTasks.has(identity.key)) return;
    if (
        getCharacterBaselineVersionOptions(identity.key).length >=
        MAX_CHARACTER_BASELINE_VERSIONS
    ) {
        toastr?.warning?.(
            `갱신본은 최대 ${MAX_CHARACTER_BASELINE_VERSIONS}개입니다. 사용하지 않는 갱신본을 삭제해 주세요.`
        );
        return;
    }
    const chatId = getCurrentChatId();
    const note = String(
        getBoosterElement("rp-character-revision-note")?.value || ""
    )
        .trim()
        .slice(0, CHARACTER_REVISION_NOTE_MAX_CHARS);
    if (!automatic && !note) {
        toastr?.warning?.("새 기준에 반영할 변화 방향을 먼저 적어 주세요.");
        getBoosterElement("rp-character-revision-note")?.focus();
        return;
    }
    const resolvedNote = automatic ? "" : resolveRoleMacrosForDisplay(note);
    const revisionMode = automatic ? "automatic" : "directed";
    const settings = ensureModuleSettings();
    const operationContext = createOperationContextSnapshot({
        chatId,
        chatSnapshot: snapshotCurrentChatMessages(),
        characterKey: identity.key,
        profileId: settings.analysisProfileId,
        outputLanguage: settings.outputLanguage,
        responseLength: 4200,
    });
    const diagnostic = createOperationDiagnostic({
        task: "character_baseline_revision_proposal",
        responseLength: operationContext.responseLength,
        connectionMode: operationContext.profileId ? "profile" : "main",
    });
    characterBaselinePendingTasks.set(identity.key, "revision");
    try {
        safelyUpdateCharacterBoosterPanel("캐릭터 갱신안 생성 시작");
        const connectionSnapshot = await resolveBackgroundConnectionSnapshot(
            operationContext.profileId
        );
        updateOperationDiagnosticConnection(diagnostic, connectionSnapshot);
        const schemaProperties = Object.fromEntries(
            CHARACTER_BASELINE_FIELDS.map((field) => [
                field.id,
                { type: "string" },
            ])
        );
        const normalized = await requestStructuredJsonWithCompatibility({
            prompt: resolveRoleMacrosForDisplay(
                buildCharacterBaselineRevisionPrompt(
                    baseline,
                    operationContext.outputLanguage,
                    resolvedNote,
                    revisionMode
                )
            ),
            transcript: [
                `<current_baseline>\n${serializeCharacterBaseline(
                    baseline
                )}\n</current_baseline>`,
                !automatic
                    ? `<user_requested_direction>\n${resolvedNote}\n</user_requested_direction>`
                    : "",
                `<recent_roleplay>\n${getRoleplayTranscript({
                    assistantRepliesWithUserContext:
                        CHARACTER_REVISION_ASSISTANT_REPLIES,
                    perMessageMaxChars: PLOT_MESSAGE_MAX_CHARS,
                    maxChars: CHARACTER_REVISION_TRANSCRIPT_MAX_CHARS,
                    chatSnapshot: operationContext.chatSnapshot,
                })}\n</recent_roleplay>`,
            ]
                .filter(Boolean)
                .join("\n\n"),
            jsonSchema: {
                name: "storybooster_character_baseline_revision",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        fields: {
                            type: "object",
                            properties: schemaProperties,
                            required: CHARACTER_BASELINE_FIELDS.map(
                                (field) => field.id
                            ),
                            additionalProperties: false,
                        },
                        changed_fields: {
                            type: "array",
                            items: {
                                type: "string",
                                enum: CHARACTER_BASELINE_FIELDS.map(
                                    (field) => field.id
                                ),
                            },
                        },
                        change_reasons: {
                            type: "object",
                            properties: schemaProperties,
                            required: CHARACTER_BASELINE_FIELDS.map(
                                (field) => field.id
                            ),
                            additionalProperties: false,
                        },
                        evidence_level: {
                            type: "string",
                            enum: ["strong", "partial", "limited"],
                        },
                        evidence_summary: { type: "string" },
                    },
                    required: [
                        "fields",
                        "changed_fields",
                        "change_reasons",
                        "evidence_level",
                        "evidence_summary",
                    ],
                    additionalProperties: false,
                },
            },
            responseLength: operationContext.responseLength,
            connectionSnapshot,
            task: diagnostic.task,
            diagnostic,
            parseResult: (result) => {
                try {
                    return normalizeCharacterBaselineRevisionPayload(
                        extractJsonObject(
                            result,
                            "Character baseline revision returned no JSON object."
                        ),
                        baseline
                    );
                } catch (error) {
                    if (!error.code) {
                        error.code = "STORYBOOSTER_INVALID_FIELDS";
                    }
                    throw error;
                }
            },
            onFallback: () =>
                toastr?.info?.(
                    "캐릭터 갱신안 응답 형식을 보정해 다시 확인하고 있어요…"
                ),
        });
        if (!isBoosterFeatureEnabled("character")) return;
        if (!normalized.changedFields.length) {
            characterBaselineRevisionProposals.delete(
                getCharacterRevisionProposalKey(identity.key, chatId)
            );
            if (automatic) {
                toastr?.info?.(
                    "최근 20개 롤플에서 기준을 바꿀 만큼 지속적인 변화는 찾지 못했어요."
                );
            } else {
                toastr?.error?.(
                    "요청한 변화가 갱신안에 반영되지 않았어요. 방향을 조금 더 구체적으로 적어 다시 시도해 주세요."
                );
            }
            return;
        }
        characterBaselineRevisionProposals.set(
            getCharacterRevisionProposalKey(identity.key, chatId),
            {
                identityKey: identity.key,
                chatId,
                baseVersionId: String(baselineState.versionId || ""),
                baseVersionLabel: baselineState.versionLabel,
                baseContentSignature: getCharacterRevisionBaselineSignature(baseline),
                fields: normalized.fields,
                changedFields: normalized.changedFields,
                mode: revisionMode,
                userDirection: resolvedNote,
                evidenceLevel: normalized.evidenceLevel,
                evidenceSummary: normalized.evidenceSummary,
                analyzedAssistantReplies: CHARACTER_REVISION_ASSISTANT_REPLIES,
                createdAt: Date.now(),
            }
        );
        toastr?.success?.(
            `${normalized.changedFields.length}개 항목의 ${automatic ? "자동 탐색" : "요청 기반"} 갱신안을 만들었어요. 확인 후 저장해 주세요.`
        );
    } catch (error) {
        console.error(`[${MODULE_NAME}] character revision proposal failed:`, error);
        recordStoryBoosterError(error, {
            task: diagnostic.task,
            diagnostic,
        });
        toastr?.error?.(
            `캐릭터 갱신안을 만들지 못했습니다: ${error?.message || "연결 상태를 확인해 주세요."}`
        );
    } finally {
        characterBaselinePendingTasks.delete(identity.key);
        safelyUpdateCharacterBoosterPanel("캐릭터 갱신안 생성 종료");
    }
}

// @source-order 236
function cancelCharacterBaselineRevisionProposal(
    identityKey = getCurrentCharacterIdentity()?.key || "",
    chatId = getCurrentChatId()
) {
    if (!identityKey) return;
    characterBaselineRevisionProposals.delete(
        getCharacterRevisionProposalKey(identityKey, chatId)
    );
    safelyUpdateCharacterBoosterPanel("캐릭터 갱신안 취소");
}

// @source-order 237
async function applyCharacterBaselineRevisionProposal() {
    const chatId = String(getCurrentChatId());
    const baselineState = getCurrentCharacterBaseline(chatId);
    if (!baselineState.identity || !baselineState.baseline) return;
    const { identity, baseline } = baselineState;
    const key = getCharacterRevisionProposalKey(identity.key, chatId);
    const proposal = characterBaselineRevisionProposals.get(key);
    if (!proposal) return;
    if (
        String(proposal.chatId || "") !== chatId ||
        proposal.identityKey !== identity.key
    ) {
        characterBaselineRevisionProposals.delete(key);
        toastr?.warning?.(
            "채팅이나 캐릭터가 바뀌었어요. 현재 채팅에서 갱신안을 다시 만들어 주세요."
        );
        return;
    }
    if (
        getCharacterBaselineVersionOptions(identity.key).length >=
        MAX_CHARACTER_BASELINE_VERSIONS
    ) {
        toastr?.warning?.(
            `갱신본은 최대 ${MAX_CHARACTER_BASELINE_VERSIONS}개입니다. 사용하지 않는 갱신본을 삭제해 주세요.`
        );
        return;
    }
    if (proposal.baseVersionId !== String(baselineState.versionId || "")) {
        toastr?.warning?.(
            "기준 버전이 바뀌었어요. 현재 버전으로 갱신안을 다시 만들어 주세요."
        );
        cancelCharacterBaselineRevisionProposal(identity.key, chatId);
        return;
    }
    const baselineSignature = getCharacterRevisionBaselineSignature(baseline);
    if (proposal.baseContentSignature !== baselineSignature) {
        toastr?.warning?.("갱신안 생성 후 기준 내용이 변경됐어요. 현재 기준으로 갱신안을 다시 만들어 주세요. 검토 중인 문구는 그대로 보관됩니다.");
        return;
    }
    const reviewFields = ensureCharacterRevisionReview(proposal);
    const selected = [];
    for (const fieldId of proposal.changedFields) {
        const checkbox = getActiveBoosterPopupRoot()?.querySelector(
            `.rp-character-revision-include[data-field-id="${fieldId}"]`
        );
        if (checkbox) captureCharacterRevisionReview(checkbox);
        const textarea = getActiveBoosterPopupRoot()?.querySelector(
            `.rp-character-revision-field[data-field-id="${fieldId}"]`
        );
        if (textarea) captureCharacterRevisionReview(textarea);
        const review = reviewFields[fieldId];
        if (!review?.included || baseline.fields[fieldId]?.pinned) continue;
        const text = String(review.text === review.originalDisplayText
            ? proposal.fields[fieldId].text
            : review.text)
            .trim()
            .slice(0, CHARACTER_BASELINE_FIELD_MAX_CHARS);
        if (text === baseline.fields[fieldId]?.text) continue;
        if (text.length < 10) {
            toastr?.warning?.(
                `${getCharacterBaselineFieldDefinition(fieldId)?.label || "선택 항목"} 내용을 10자 이상 입력해 주세요.`
            );
            return;
        }
        selected.push({ fieldId, text });
    }
    if (!selected.length) {
        toastr?.warning?.("고정되지 않은 변경 항목을 하나 이상 선택해 주세요. 핀으로 고정한 항목은 그대로 유지됩니다.");
        return;
    }
    if (characterBaselinePendingTasks.has(identity.key)) return;
    const settings = ensureModuleSettings();
    const operationContext = createOperationContextSnapshot({
        chatId,
        characterKey: identity.key,
        profileId: settings.analysisProfileId,
        outputLanguage: settings.outputLanguage,
        responseLength: 900,
    });
    const diagnostic = createOperationDiagnostic({
        task: "character_baseline_revision_anchor",
        responseLength: operationContext.responseLength,
        connectionMode: operationContext.profileId ? "profile" : "main",
    });
    const nextBaseline = normalizeCharacterBaseline(baseline);
    for (const { fieldId, text } of selected) {
        nextBaseline.fields[fieldId] = {
            ...nextBaseline.fields[fieldId],
            text,
            source: "ai",
            language: operationContext.outputLanguage,
            updatedAt: Date.now(),
        };
    }
    nextBaseline.boostAnchorNeedsRefresh = true;
    nextBaseline.updatedAt = Date.now();
    characterBaselinePendingTasks.set(identity.key, "revision-apply");
    try {
        safelyUpdateCharacterBoosterPanel("캐릭터 갱신본 저장 시작");
        const connectionSnapshot = await resolveBackgroundConnectionSnapshot(
            operationContext.profileId
        );
        updateOperationDiagnosticConnection(diagnostic, connectionSnapshot);
        const anchor = await requestCharacterBoostAnchor({
            identity,
            baseline: nextBaseline,
            outputLanguage: operationContext.outputLanguage,
            connectionSnapshot,
            diagnostic,
            responseLength: operationContext.responseLength,
        });
        if (!isBoosterFeatureEnabled("character")) return;
        if (
            !isOperationContextCurrentChat(operationContext) ||
            !isOperationContextCurrentCharacter(operationContext)
        ) {
            const contextError = new Error(
                "앵커 생성 중 채팅이나 캐릭터가 바뀌어 저장을 중단했습니다. 원래 채팅에서 다시 시도해 주세요."
            );
            contextError.code = "STORYBOOSTER_CONTEXT_CHANGED";
            throw contextError;
        }
        const current = getCurrentCharacterBaseline(chatId);
        if (
            String(current.versionId || "") !== proposal.baseVersionId ||
            getCharacterRevisionBaselineSignature(current.baseline) !== baselineSignature ||
            CHARACTER_BASELINE_FIELDS.some(({ id }) =>
                Boolean(current.baseline?.fields?.[id]?.pinned) !== Boolean(baseline.fields[id]?.pinned))
        ) {
            const error = new Error("저장 중 캐릭터 기준이나 고정 상태가 변경되어 이전 결과를 적용하지 않았습니다. 현재 기준을 확인해 주세요.");
            error.code = "STORYBOOSTER_CONTEXT_CHANGED";
            throw error;
        }
        nextBaseline.boostAnchor = anchor.boostAnchor;
        nextBaseline.boostAnchorDisplay = anchor.boostAnchorDisplay;
        nextBaseline.boostAnchorDisplayLanguage = operationContext.outputLanguage;
        nextBaseline.boostAnchorUpdatedAt = Date.now();
        nextBaseline.boostAnchorNeedsRefresh = false;
        nextBaseline.updatedAt = Date.now();
        const record = createCharacterBaselineVersion(identity, nextBaseline, {
            chatId: operationContext.chatId,
            parentVersionId: proposal.baseVersionId,
            revisionMode: proposal.mode,
            evidenceLevel: proposal.evidenceLevel,
        });
        if (!record) throw new Error("새 캐릭터 기준 버전을 저장하지 못했습니다.");
        characterBaselineRevisionProposals.delete(key);
        invalidateCharacterAuditAfterBaselineChange(operationContext.chatId);
        saveSettingsDebounced();
        if (isOperationContextCurrentCharacter(operationContext)) {
            safelyUpdateGenrePrompt("캐릭터 갱신본 저장");
            safelyUpdateGenreAnchorPanel("캐릭터 갱신본 저장");
        }
        toastr?.success?.(`「${record.label}」을 저장하고 이 채팅에 적용했어요.`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] character revision apply failed:`, error);
        recordStoryBoosterError(error, {
            task: diagnostic.task,
            diagnostic,
        });
        toastr?.error?.(
            `캐릭터 갱신본을 저장하지 못했습니다: ${error?.message || "연결 상태를 확인해 주세요."}`
        );
    } finally {
        characterBaselinePendingTasks.delete(identity.key);
        safelyUpdateCharacterBoosterPanel("캐릭터 갱신본 저장 종료");
    }
}

// @source-order 238
async function generateCharacterBaseline(fieldId = null) {
    if (!isBoosterFeatureEnabled("character")) {
        toastr?.info?.("전역 설정에서 캐릭터 부스터를 켜 주세요.");
        return;
    }
    const baselineState = getCurrentCharacterBaseline();
    if (!baselineState.identity) {
        toastr?.warning?.("개별 캐릭터 채팅에서만 캐릭터 기준을 만들 수 있어요.");
        return;
    }
    if (!baselineState.identity.source) {
        toastr?.warning?.("분석할 캐릭터 시트 내용이 없습니다.");
        return;
    }
    if (
        baselineState.isOriginal &&
        baselineState.baseline &&
        getCharacterBaselineVersionOptions(baselineState.identity.key).length >=
            MAX_CHARACTER_BASELINE_VERSIONS
    ) {
        toastr?.warning?.(
            `갱신본은 최대 ${MAX_CHARACTER_BASELINE_VERSIONS}개입니다. 사용하지 않는 갱신본을 삭제해 주세요.`
        );
        return;
    }
    const { identity } = baselineState;
    const taskChatId = getCurrentChatId();
    const taskVersionId = String(baselineState.versionId || "");
    if (characterBaselinePendingTasks.has(identity.key)) return;
    if (getBoosterElement("rp-character-baseline-fields")?.querySelector(
        ".rp-character-field-text:not([readonly])"
    )) {
        toastr?.info?.("편집 중인 항목을 저장한 뒤 다시 시도해 주세요.");
        return;
    }
    const baseline = baselineState.baseline || createEmptyCharacterBaseline(identity);
    const requestedField = fieldId
        ? getCharacterBaselineFieldDefinition(fieldId)
        : null;
    if (fieldId && !requestedField) return;
    const targetFields = requestedField
        ? [requestedField]
        : CHARACTER_BASELINE_FIELDS.filter(
              (definition) => !baseline.fields[definition.id]?.pinned
          );
    if (!targetFields.length) {
        toastr?.info?.("모든 항목이 고정되어 있어 다시 요약할 항목이 없습니다.");
        return;
    }
    const targetIds = new Set(targetFields.map((field) => field.id));
    const contextFields = CHARACTER_BASELINE_FIELDS.filter((definition) =>
        requestedField
            ? definition.id !== requestedField.id
            : baseline.fields[definition.id]?.pinned
    ).map((definition) => ({
        definition,
        text: String(baseline.fields[definition.id]?.text || ""),
    }));
    const baselineSettings = ensureModuleSettings();
    const baselineResponseLength = requestedField ? 1200 : 3600;
    const operationContext = createOperationContextSnapshot({
        chatId: taskChatId,
        characterKey: identity.key,
        profileId: baselineSettings.analysisProfileId,
        outputLanguage: baselineSettings.outputLanguage,
        responseLength: baselineResponseLength,
    });
    const selectedProfileId = operationContext.profileId;
    const outputLanguage = operationContext.outputLanguage;
    const baselineDiagnostic = createOperationDiagnostic({
        task: requestedField
            ? `character_baseline_field_${requestedField.id}`
            : "character_baseline_all",
        responseLength: operationContext.responseLength,
        connectionMode: selectedProfileId ? "profile" : "main",
    });
    characterBaselinePendingTasks.set(identity.key, fieldId || "all");
    try {
        safelyUpdateCharacterBoosterPanel("캐릭터 기준 생성 시작");
        const connectionSnapshot = await resolveBackgroundConnectionSnapshot(
            selectedProfileId
        );
        updateOperationDiagnosticConnection(baselineDiagnostic, connectionSnapshot);
        const schemaProperties = Object.fromEntries(
            targetFields.map((field) => [field.id, { type: "string" }])
        );
        const baselinePrompt = buildCharacterBaselinePrompt(
            targetFields,
            contextFields,
            outputLanguage,
            !requestedField
        );
        const baselineTranscript = `<character_card>\n${identity.source.slice(
                0,
                CHARACTER_CARD_INPUT_MAX_CHARS
            )}\n</character_card>`;
        const baselineJsonSchema = {
                name: "storybooster_character_baseline",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        fields: {
                            type: "object",
                            properties: schemaProperties,
                            required: [...targetIds],
                            additionalProperties: false,
                        },
                        ...(!requestedField
                            ? {
                                  boost_anchor: { type: "string" },
                                  ...(outputLanguage === "ko"
                                      ? {
                                            boost_anchor_display: {
                                                type: "string",
                                            },
                                        }
                                      : {}),
                              }
                            : {}),
                    },
                    required: requestedField
                        ? ["fields"]
                        : [
                              "fields",
                              "boost_anchor",
                              ...(outputLanguage === "ko"
                                  ? ["boost_anchor_display"]
                                  : []),
                          ],
                    additionalProperties: false,
                },
            };
        const parsed = await requestStructuredJsonWithCompatibility({
            prompt: baselinePrompt,
            transcript: baselineTranscript,
            jsonSchema: baselineJsonSchema,
            responseLength: operationContext.responseLength,
            connectionSnapshot,
            task: baselineDiagnostic.task,
            diagnostic: baselineDiagnostic,
            parseResult: (result) => {
                const normalized = normalizeCharacterBaselineGenerationPayload(
                    extractJsonObject(
                        result,
                        "Character baseline returned no JSON object."
                    ),
                    targetFields
                );
                const formatIssues = getCharacterBaselineGenerationIssues(
                    normalized,
                    targetFields,
                    {
                        includeBoostAnchor: !requestedField,
                        outputLanguage,
                    }
                );
                if (formatIssues.length) {
                    const formatError = new Error(
                        `캐릭터 기준 응답에 필수 항목이 누락되었습니다: ${formatIssues.join(
                            ", "
                        )}`
                    );
                    formatError.code =
                        "STORYBOOSTER_CHARACTER_BASELINE_INCOMPLETE";
                    formatError.missingFields = [...formatIssues];
                    throw formatError;
                }
                return normalized;
            },
            onFallback: () =>
                toastr?.info?.(
                    "캐릭터 기준 응답 형식을 보정해 다시 요청하고 있어요…"
                ),
        });
        if (!isBoosterFeatureEnabled("character")) {
            toastr?.info?.(
                "캐릭터 부스터가 꺼져 있어 생성 결과를 저장하지 않았어요."
            );
            return;
        }
        const boostAnchor = requestedField
            ? ""
            : String(parsed.boost_anchor || "")
                  .trim()
                  .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS);
        if (!requestedField && boostAnchor.length < 30) {
            throw new Error("캐릭터 앵커가 지나치게 짧습니다.");
        }
        const boostAnchorDisplay = requestedField
            ? ""
            : outputLanguage === "ko"
              ? String(parsed.boost_anchor_display || "")
                    .trim()
                    .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS)
              : boostAnchor;
        if (
            !requestedField &&
            outputLanguage === "ko" &&
            boostAnchorDisplay.length < 15
        ) {
            throw new Error("한국어 표시용 캐릭터 앵커가 지나치게 짧습니다.");
        }
        const nextBaseline = normalizeCharacterBaseline(baseline) ||
            createEmptyCharacterBaseline(identity);
        for (const definition of targetFields) {
            const text = String(parsed.fields[definition.id] || "")
                .trim()
                .slice(0, CHARACTER_BASELINE_FIELD_MAX_CHARS);
            if (text.length < 10) {
                throw new Error(`${definition.label} 항목이 지나치게 짧습니다.`);
            }
            nextBaseline.fields[definition.id] = {
                ...nextBaseline.fields[definition.id],
                text,
                source: "ai",
                language: outputLanguage,
                updatedAt: Date.now(),
            };
        }
        nextBaseline.characterName = identity.name;
        if (requestedField) {
            // A single-field refresh should succeed independently. Preserve the
            // existing compact anchor and let the user refresh it separately.
            nextBaseline.boostAnchorNeedsRefresh = Boolean(nextBaseline.boostAnchor);
        } else {
            nextBaseline.boostAnchor = boostAnchor;
            nextBaseline.boostAnchorDisplay = boostAnchorDisplay;
            nextBaseline.boostAnchorDisplayLanguage = outputLanguage;
            nextBaseline.boostAnchorUpdatedAt = Date.now();
            nextBaseline.boostAnchorNeedsRefresh = false;
        }
        nextBaseline.updatedAt = Date.now();
        if (!requestedField || !baselineState.baseline) {
            nextBaseline.sourceHash = identity.sourceHash;
            nextBaseline.notifiedSourceHash = "";
        }
        const completedBaseline = {
            characterName: identity.name,
            ...nextBaseline,
        };
        if (taskVersionId) {
            if (
                !writeCharacterBaselineVersion(
                    identity,
                    completedBaseline,
                    taskVersionId
                )
            ) {
                throw new Error("저장하려던 캐릭터 기준 버전을 찾지 못했습니다.");
            }
        } else if (baselineState.baseline) {
            createCharacterBaselineVersion(identity, completedBaseline, {
                chatId: taskChatId,
                parentVersionId: "",
            });
        } else {
            writeCharacterBaselineVersion(identity, completedBaseline, "");
        }
        invalidateCharacterAuditAfterBaselineChange(taskChatId);
        saveSettingsDebounced();
        if (isOperationContextCurrentCharacter(operationContext)) {
            const promptUpdated = safelyUpdateGenrePrompt(
                "캐릭터 기준 생성 완료"
            );
            safelyUpdateGenreAnchorPanel("캐릭터 기준 생성 완료");
            if (!promptUpdated) {
                toastr?.warning?.(
                    "캐릭터 기준은 저장됐지만 부스팅 갱신에 실패했습니다. SillyTavern을 새로고침해 주세요."
                );
            }
        }
        toastr?.success?.(
            requestedField
                ? `${requestedField.label} 항목을 다시 생성했어요.`
                : "고정하지 않은 캐릭터 기준을 다시 요약했어요."
        );
    } catch (error) {
        console.error(`[${MODULE_NAME}] character baseline failed:`, error);
        recordStoryBoosterError(error, {
            task: baselineDiagnostic.task,
            diagnostic: baselineDiagnostic,
        });
        toastr?.error?.(
            `캐릭터 기준을 만들지 못했습니다: ${error?.message || "연결 상태를 확인해 주세요."}`
        );
    } finally {
        characterBaselinePendingTasks.delete(identity.key);
        safelyUpdateCharacterBoosterPanel("캐릭터 기준 생성 종료");
    }
}

// @source-order 239
function setCharacterFieldSaveStatus(fieldId, text) {
    const status = getActiveBoosterPopupRoot()?.querySelector(
        `.rp-character-field-save-status[data-field-id="${fieldId}"]`
    );
    if (status) status.textContent = text;
}

// @source-order 240
function getCharacterEditTarget(element) {
    const identityKey = String(element?.dataset?.identityKey || "");
    if (!identityKey) return null;
    return {
        identity: {
            key: identityKey,
            name: String(element.dataset.characterName || ""),
            sourceHash: String(element.dataset.sourceHash || ""),
        },
        chatId: String(element.dataset.chatId || getCurrentChatId()),
        versionId: String(element.dataset.baselineVersionId || ""),
        originalText: element.dataset.originalText,
        originalDisplayText: element.dataset.originalDisplayText,
    };
}

// @source-order 241
function resolveCharacterSaveTarget(target) {
    if (target?.identity?.key) {
        return {
            identity: target.identity,
            chatId: String(target.chatId || getCurrentChatId()),
            versionId: String(target.versionId ?? ""),
        };
    }
    const current = getCurrentCharacterBaseline();
    return {
        identity: current.identity,
        chatId: String(getCurrentChatId()),
        versionId: String(current.versionId || ""),
    };
}

// @source-order 242
function updateCharacterEditorSaveTarget(target, versionId, fieldId, text) {
    if (!target?.identity?.key) return;
    const previousVersionId = String(target.versionId ?? "");
    getBoosterElements(".rp-character-field-text[data-field-id]").forEach((element) => {
        if (
            element.dataset.identityKey !== target.identity.key ||
            element.dataset.chatId !== String(target.chatId) ||
            String(element.dataset.baselineVersionId || "") !== previousVersionId
        ) return;
        element.dataset.baselineVersionId = String(versionId || "");
        if (element.dataset.fieldId === fieldId) {
            element.dataset.originalText = text;
            element.dataset.originalDisplayText = element.value.trim();
        }
    });
    target.versionId = String(versionId || "");
}

// @source-order 243
function saveCharacterBaselineField(
    fieldId,
    value,
    { refresh = false, target = null } = {}
) {
    const definition = getCharacterBaselineFieldDefinition(fieldId);
    const { identity, chatId: targetChatId, versionId: requestedVersionId } =
        resolveCharacterSaveTarget(target);
    if (!definition || !identity?.key) return false;
    const existingBaseline = getCharacterBaselineVersion(
        identity.key,
        requestedVersionId
    );
    // A deleted target must not be recreated or silently redirected.
    if (requestedVersionId && !existingBaseline) return false;
    const inputText = String(value || "").trim();
    if (target?.originalText !== undefined &&
        inputText === String(target.originalDisplayText ?? "").trim()) {
        setCharacterFieldSaveStatus(fieldId, "저장됨");
        return true;
    }
    const text = inputText.slice(0, CHARACTER_BASELINE_FIELD_MAX_CHARS);
    if (text === String(existingBaseline?.fields?.[fieldId]?.text || "")) {
        setCharacterFieldSaveStatus(fieldId, "저장됨");
        return true;
    }
    if (
        !requestedVersionId &&
        existingBaseline &&
        getCharacterBaselineVersionOptions(identity.key).length >=
            MAX_CHARACTER_BASELINE_VERSIONS
    ) {
        setCharacterFieldSaveStatus(
            fieldId,
            `저장 불가 · 갱신본 최대 ${MAX_CHARACTER_BASELINE_VERSIONS}개`
        );
        return false;
    }
    const baseline = existingBaseline || createEmptyCharacterBaseline(identity);
    if (existingBaseline && !text &&
        !Object.entries(existingBaseline.fields).some(([id, field]) => id !== fieldId && field.text)) {
        setCharacterFieldSaveStatus(fieldId, requestedVersionId
            ? "저장 대기 · 마지막 내용을 비우면 이전 저장본을 유지합니다"
            : "저장 불가 · 원본은 보존됩니다");
        return false;
    }
    baseline.fields[fieldId] = {
        ...baseline.fields[fieldId],
        text,
        source: "user",
        language: ensureModuleSettings().outputLanguage,
        updatedAt: Date.now(),
    };
    baseline.characterName = identity.name;
    baseline.boostAnchorNeedsRefresh = Boolean(baseline.boostAnchor);
    baseline.updatedAt = Date.now();
    if (!baseline.sourceHash) baseline.sourceHash = identity.sourceHash;
    let savedVersionId = requestedVersionId;
    if (Object.values(baseline.fields).some((field) => field.text)) {
        if (requestedVersionId) {
            if (!writeCharacterBaselineVersion(identity, baseline, requestedVersionId)) return false;
        } else if (existingBaseline) {
            const record = createCharacterBaselineVersion(identity, baseline, {
                chatId: targetChatId,
                parentVersionId: "",
            });
            if (!record) return false;
            savedVersionId = record.id;
        } else {
            writeCharacterBaselineVersion(identity, baseline, "");
        }
    } else return false;
    updateCharacterEditorSaveTarget(target, savedVersionId, fieldId, text);
    invalidateCharacterAuditAfterBaselineChange(targetChatId, { sharedVersionId: savedVersionId });
    saveSettingsDebounced();
    if (getCurrentCharacterIdentity()?.key === identity.key) {
        const promptUpdated = safelyUpdateGenrePrompt("캐릭터 기준 저장");
        setCharacterFieldSaveStatus(
            fieldId,
            promptUpdated ? "저장됨" : "저장됨 · 부스팅 갱신 필요"
        );
        if (!promptUpdated && refresh) {
            toastr?.warning?.(
                "캐릭터 기준은 저장됐지만 부스팅 갱신에 실패했습니다. SillyTavern을 새로고침해 주세요."
            );
        }
        if (refresh) safelyUpdateGenreAnchorPanel("캐릭터 기준 저장");
    }
    return true;
}

// @source-order 244
function scheduleCharacterBaselineAutosave(textarea) {
    const fieldId = textarea?.dataset.fieldId;
    if (!fieldId) return;
    const target = getCharacterEditTarget(textarea);
    const identityKey = target?.identity?.key || "none";
    const timerKey = `${identityKey}:${target?.versionId || "original"}:${fieldId}`;
    const previousTimer = characterBaselineAutosaveTimers.get(timerKey);
    if (previousTimer) clearTimeout(previousTimer);
    setCharacterFieldSaveStatus(fieldId, "저장 중…");
    const value = textarea.value;
    characterBaselineAutosaveTimers.set(
        timerKey,
        setTimeout(() => {
            characterBaselineAutosaveTimers.delete(timerKey);
            saveCharacterBaselineField(fieldId, value, { target });
        }, CHARACTER_BASELINE_AUTOSAVE_DELAY)
    );
}

// @source-order 245
function flushCharacterBaselineAutosave(textarea, { refresh = false } = {}) {
    const fieldId = textarea?.dataset.fieldId;
    if (!fieldId) return false;
    const target = getCharacterEditTarget(textarea);
    const timerKey = `${target?.identity?.key || "none"}:${target?.versionId || "original"}:${fieldId}`;
    const timer = characterBaselineAutosaveTimers.get(timerKey);
    if (timer) {
        clearTimeout(timer);
        characterBaselineAutosaveTimers.delete(timerKey);
    }
    return saveCharacterBaselineField(fieldId, textarea.value, {
        refresh,
        target,
    });
}

// @source-order 246
function toggleCharacterFieldPin(fieldId) {
    if (!getCharacterBaselineFieldDefinition(fieldId)) return;
    const baselineState = getCurrentCharacterBaseline();
    if (
        !baselineState.identity ||
        !String(baselineState.baseline?.fields?.[fieldId]?.text || "").trim()
    ) {
        return;
    }
    const baseline = baselineState.baseline || createEmptyCharacterBaseline(
        baselineState.identity
    );
    baseline.fields[fieldId].pinned = !baseline.fields[fieldId].pinned;
    baseline.updatedAt = Date.now();
    writeCharacterBaselineVersion(
        baselineState.identity,
        baseline,
        baselineState.versionId
    );
    saveSettingsDebounced();
    safelyUpdateCharacterBoosterPanel("캐릭터 기준 고정 변경");
}

// @source-order 247
function toggleCharacterFieldEditing(fieldId, sourceButton = null) {
    const button = sourceButton || getActiveBoosterPopupRoot()?.querySelector(
        `.rp-character-edit-button[data-field-id="${fieldId}"]`
    );
    const card = button?.closest(".rp-character-field-card");
    const textarea = card?.querySelector(
        `.rp-character-field-text[data-field-id="${fieldId}"]`
    );
    if (!textarea || !button) return;
    if (textarea.readOnly) {
        textarea.readOnly = false;
        textarea.classList.add("is-editing");
        button.textContent = "💾";
        button.title = "저장하고 편집 잠금";
        textarea.focus();
    } else {
        try {
            const saved = flushCharacterBaselineAutosave(textarea, {
                refresh: true,
            });
            if (!saved) throw new Error("저장할 캐릭터를 찾지 못했습니다.");
        } catch (error) {
            console.error(`[${MODULE_NAME}] character field save failed:`, error);
            recordStoryBoosterError(error, {
                task: "character_baseline_field_save",
                stage: "settings_save",
            });
            toastr?.error?.(
                `캐릭터 기준 저장에 실패했습니다: ${error?.message || "화면을 다시 열어 주세요."}`
            );
        } finally {
            textarea.readOnly = true;
            textarea.classList.remove("is-editing");
            button.textContent = "✏️";
            button.title = "직접 편집";
        }
    }
    updateCharacterBaselineActionStates();
}

// @source-order 248
function saveCharacterBoostAnchor(
    { canonicalText, displayText, displayLanguage },
    target = null
) {
    const { identity, chatId: targetChatId, versionId: requestedVersionId } =
        resolveCharacterSaveTarget(target);
    const baseline = identity?.key
        ? getCharacterBaselineVersion(identity.key, requestedVersionId)
        : null;
    if (!identity?.key || !baseline) return false;
    const text = String(canonicalText || "")
        .trim()
        .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS);
    const visibleText = String(displayText || text)
        .trim()
        .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS);
    if (!text || !visibleText) return false;
    baseline.boostAnchor = text;
    baseline.boostAnchorDisplay = visibleText;
    baseline.boostAnchorDisplayLanguage = ["ko", "en"].includes(displayLanguage)
        ? displayLanguage
        : "en";
    baseline.boostAnchorUpdatedAt = Date.now();
    baseline.boostAnchorNeedsRefresh = false;
    baseline.updatedAt = Date.now();
    if (requestedVersionId) {
        if (!writeCharacterBaselineVersion(identity, baseline, requestedVersionId)) return false;
    } else {
        createCharacterBaselineVersion(identity, baseline, {
            chatId: targetChatId,
            parentVersionId: "",
        });
    }
    saveSettingsDebounced();
    if (getCurrentCharacterIdentity()?.key === identity.key) {
        const promptUpdated = safelyUpdateGenrePrompt("캐릭터 앵커 저장");
        safelyUpdateGenreAnchorPanel("캐릭터 앵커 저장");
        if (!promptUpdated) {
            toastr?.warning?.(
                "상시 앵커는 저장됐지만 부스팅 갱신에 실패했습니다. SillyTavern을 새로고침해 주세요."
            );
        }
    }
    return true;
}

// @source-order 249
async function convertCharacterAnchorDisplayToEnglish(displayText) {
    const conversionSettings = ensureModuleSettings();
    const operationContext = createOperationContextSnapshot({
        chatId: getCurrentChatId(),
        characterKey: getCurrentCharacterIdentity()?.key || "",
        profileId: conversionSettings.analysisProfileId,
        outputLanguage: conversionSettings.outputLanguage,
        responseLength: 900,
    });
    const anchorConversionDiagnostic = createOperationDiagnostic({
        task: "character_anchor_translation",
        responseLength: operationContext.responseLength,
        connectionMode: operationContext.profileId ? "profile" : "main",
    });
    const connectionSnapshot = await resolveBackgroundConnectionSnapshot(
        operationContext.profileId
    );
    updateOperationDiagnosticConnection(
        anchorConversionDiagnostic,
        connectionSnapshot
    );
    try {
        return await requestStructuredJsonWithCompatibility({
            prompt: [
                "Convert the supplied user-edited Korean character anchor into a concise English roleplay instruction.",
                "Preserve every character-specific trait, tension, value, boundary, motive, speech pattern, and relationship response. Do not add, soften, intensify, interpret, or omit content.",
                `Use complete grammatical English and stay within ${CHARACTER_BOOST_ANCHOR_MAX_CHARS} characters.`,
                'Return JSON only: {"boost_anchor":"English character-specific anchor"}.',
            ].join("\n"),
            transcript: `<display_anchor>\n${String(displayText || "").slice(
                0,
                CHARACTER_BOOST_ANCHOR_MAX_CHARS
            )}\n</display_anchor>`,
            jsonSchema: {
                name: "storybooster_character_anchor_conversion",
                strict: true,
                schema: {
                    type: "object",
                    properties: { boost_anchor: { type: "string" } },
                    required: ["boost_anchor"],
                    additionalProperties: false,
                },
            },
            responseLength: operationContext.responseLength,
            connectionSnapshot,
            task: anchorConversionDiagnostic.task,
            diagnostic: anchorConversionDiagnostic,
            parseResult: (result) => {
                const parsed = extractJsonObject(
                    result,
                    "Character anchor conversion returned no JSON object."
                );
                const text = requireStructuredTextFields(parsed, ["boost_anchor"]).boost_anchor
                    .trim()
                    .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS);
                if (text.length < 15) {
                    const error = new Error(
                        "영문 주입용 앵커가 지나치게 짧습니다."
                    );
                    error.code = "STORYBOOSTER_INVALID_FIELDS";
                    error.invalidFields = ["boost_anchor"];
                    throw error;
                }
                return text;
            },
        });
    } catch (error) {
        recordStoryBoosterError(error, {
            task: anchorConversionDiagnostic.task,
            diagnostic: anchorConversionDiagnostic,
        });
        throw error;
    }
}

// @source-order 250
function setCharacterBoostAnchorEditMode(editing) {
    const textarea = getBoosterElement("rp-character-boost-anchor-text");
    const editButton = getBoosterElement("rp-character-boost-anchor-edit");
    const saveButton = getBoosterElement("rp-character-boost-anchor-save");
    const cancelButton = getBoosterElement("rp-character-boost-anchor-cancel");
    if (!textarea || !editButton || !saveButton || !cancelButton) return;
    if (editing) {
        textarea.dataset.originalValue = textarea.value;
        textarea.readOnly = false;
        textarea.classList.add("is-editing");
        editButton.hidden = true;
        saveButton.hidden = false;
        cancelButton.hidden = false;
        textarea.focus();
    } else {
        textarea.readOnly = true;
        textarea.classList.remove("is-editing");
        editButton.hidden = false;
        saveButton.hidden = true;
        cancelButton.hidden = true;
        delete textarea.dataset.originalValue;
    }
    updateCharacterBaselineActionStates();
}

// @source-order 251
function beginCharacterBoostAnchorEditing() {
    setCharacterBoostAnchorEditMode(true);
}

// @source-order 252
function cancelCharacterBoostAnchorEditing() {
    const textarea = getBoosterElement("rp-character-boost-anchor-text");
    if (textarea && !textarea.readOnly) {
        textarea.value = textarea.dataset.originalValue || "";
    }
    setCharacterBoostAnchorEditMode(false);
}

// @source-order 253
async function saveEditedCharacterBoostAnchor() {
    const textarea = getBoosterElement("rp-character-boost-anchor-text");
    const baselineState = getCurrentCharacterBaseline();
    if (!textarea || textarea.readOnly || !baselineState.identity) return;
    if (textarea.value.trim() === String(textarea.dataset.originalValue ?? "").trim()) {
        setCharacterBoostAnchorEditMode(false);
        return;
    }
    if (
        baselineState.isOriginal &&
        getCharacterBaselineVersionOptions(baselineState.identity.key).length >=
            MAX_CHARACTER_BASELINE_VERSIONS
    ) {
        toastr?.warning?.(
            `갱신본은 최대 ${MAX_CHARACTER_BASELINE_VERSIONS}개입니다. 사용하지 않는 갱신본을 삭제해 주세요.`
        );
        return;
    }
    // Capture the save target before a possible translation request. The
    // active popup is reused across chat changes, so its dataset may point to
    // another character by the time the request resolves.
    const target = getCharacterEditTarget(textarea) || {
        identity: baselineState.identity,
        chatId: getCurrentChatId(),
    };
    const displayText = textarea.value.trim();
    if (!displayText) {
        toastr?.warning?.("캐릭터 앵커를 비워 둘 수 없습니다.");
        return;
    }
    const language = ensureModuleSettings().outputLanguage;
    const identityKey = target.identity.key;
    if (characterBaselinePendingTasks.has(identityKey)) return;
    characterBaselinePendingTasks.set(identityKey, "anchor");
    try {
        safelyUpdateCharacterBoosterPanel("캐릭터 앵커 저장 시작");
        const canonicalText =
            language === "ko"
                ? await convertCharacterAnchorDisplayToEnglish(displayText)
                : displayText;
        if (!isBoosterFeatureEnabled("character")) {
            toastr?.info?.(
                "캐릭터 부스터가 꺼져 있어 편집 결과를 저장하지 않았어요."
            );
            return;
        }
        const saved = saveCharacterBoostAnchor(
            { canonicalText, displayText, displayLanguage: language },
            target
        );
        if (!saved) throw new Error("저장할 캐릭터를 찾지 못했습니다.");
        if (getCurrentCharacterIdentity()?.key === identityKey) {
            setCharacterBoostAnchorEditMode(false);
        }
        toastr?.success?.(
            language === "ko"
                ? "한국어 앵커를 저장하고 영문 주입용 앵커를 갱신했어요."
                : "캐릭터 앵커를 저장했어요."
        );
    } catch (error) {
        console.error(`[${MODULE_NAME}] character anchor save failed:`, error);
        recordStoryBoosterError(error, {
            task: "character_anchor_save",
        });
        toastr?.error?.(
            `캐릭터 앵커 저장에 실패했습니다: ${error?.message || "연결 상태를 확인해 주세요."}`
        );
    } finally {
        characterBaselinePendingTasks.delete(identityKey);
        safelyUpdateCharacterBoosterPanel("캐릭터 앵커 저장 종료");
    }
}

// @source-order 254
function closeCharacterEditorsForChatChange() {
    const popupRoot = getActiveBoosterPopupRoot();
    const anchorText = getBoosterElement("rp-character-boost-anchor-text");
    if (anchorText && !anchorText.readOnly) {
        anchorText.value = anchorText.dataset.originalValue || anchorText.value;
        setCharacterBoostAnchorEditMode(false);
    }
    popupRoot
        ?.querySelectorAll(
            ".rp-character-field-text[data-field-id]:not([readonly])"
        )
        .forEach((textarea) => {
            flushCharacterBaselineAutosave(textarea);
            textarea.readOnly = true;
            textarea.classList.remove("is-editing");
        });
}

// @source-order 255
async function regenerateCharacterBoostAnchor() {
    if (!isBoosterFeatureEnabled("character")) {
        toastr?.info?.("전역 설정에서 캐릭터 부스터를 켜 주세요.");
        return;
    }
    const baselineState = getCurrentCharacterBaseline();
    if (!baselineState.identity || !baselineState.baseline) return;
    if (
        baselineState.isOriginal &&
        getCharacterBaselineVersionOptions(baselineState.identity.key).length >=
            MAX_CHARACTER_BASELINE_VERSIONS
    ) {
        toastr?.warning?.(
            `갱신본은 최대 ${MAX_CHARACTER_BASELINE_VERSIONS}개입니다. 사용하지 않는 갱신본을 삭제해 주세요.`
        );
        return;
    }
    const { identity, baseline } = baselineState;
    const taskChatId = getCurrentChatId();
    const taskVersionId = String(baselineState.versionId || "");
    const anchorSettings = ensureModuleSettings();
    const operationContext = createOperationContextSnapshot({
        chatId: getCurrentChatId(),
        characterKey: identity.key,
        profileId: anchorSettings.analysisProfileId,
        outputLanguage: anchorSettings.outputLanguage,
        responseLength: 900,
    });
    const outputLanguage = operationContext.outputLanguage;
    if (characterBaselinePendingTasks.has(identity.key)) return;
    const anchorDiagnostic = createOperationDiagnostic({
        task: "character_anchor_regeneration",
        responseLength: operationContext.responseLength,
        connectionMode: operationContext.profileId ? "profile" : "main",
    });
    characterBaselinePendingTasks.set(identity.key, "anchor");
    try {
        safelyUpdateCharacterBoosterPanel("캐릭터 앵커 생성 시작");
        const connectionSnapshot = await resolveBackgroundConnectionSnapshot(
            operationContext.profileId
        );
        updateOperationDiagnosticConnection(anchorDiagnostic, connectionSnapshot);
        const anchor = await requestCharacterBoostAnchor({
            identity,
            baseline,
            outputLanguage,
            connectionSnapshot,
            diagnostic: anchorDiagnostic,
            responseLength: operationContext.responseLength,
        });
        if (!isBoosterFeatureEnabled("character")) {
            toastr?.info?.(
                "캐릭터 부스터가 꺼져 있어 앵커 생성 결과를 저장하지 않았어요."
            );
            return;
        }
        baseline.boostAnchor = anchor.boostAnchor;
        baseline.boostAnchorDisplay = anchor.boostAnchorDisplay;
        baseline.boostAnchorDisplayLanguage = outputLanguage;
        baseline.boostAnchorUpdatedAt = Date.now();
        baseline.boostAnchorNeedsRefresh = false;
        baseline.updatedAt = Date.now();
        if (taskVersionId) {
            if (!writeCharacterBaselineVersion(identity, baseline, taskVersionId)) {
                throw new Error("저장하려던 캐릭터 기준 버전을 찾지 못했습니다.");
            }
        } else {
            createCharacterBaselineVersion(identity, baseline, {
                chatId: taskChatId,
                parentVersionId: "",
            });
        }
        saveSettingsDebounced();
        if (isOperationContextCurrentCharacter(operationContext)) {
            const promptUpdated = safelyUpdateGenrePrompt(
                "캐릭터 앵커 생성 완료"
            );
            safelyUpdateGenreAnchorPanel("캐릭터 앵커 생성 완료");
            if (!promptUpdated) {
                toastr?.warning?.(
                    "상시 앵커는 저장됐지만 부스팅 갱신에 실패했습니다. SillyTavern을 새로고침해 주세요."
                );
            }
        }
        toastr?.success?.("캐릭터 전용 상시 앵커를 갱신했어요.");
    } catch (error) {
        console.error(`[${MODULE_NAME}] character boost anchor failed:`, error);
        recordStoryBoosterError(error, {
            task: anchorDiagnostic.task,
            diagnostic: anchorDiagnostic,
        });
        toastr?.error?.(
            `상시 앵커를 만들지 못했습니다: ${error?.message || "연결 상태를 확인해 주세요."}`
        );
    } finally {
        characterBaselinePendingTasks.delete(identity.key);
        safelyUpdateCharacterBoosterPanel("캐릭터 앵커 생성 종료");
    }
}

// @source-order 256
function deleteCharacterBaseline() {
    const baselineState = getCurrentCharacterBaseline();
    if (!baselineState.identity || !baselineState.baseline) return;
    if (baselineState.isOriginal) {
        toastr?.info?.("원본은 보존됩니다. 필요하면 갱신본을 만들어 사용해 주세요.");
        return;
    }
    deleteCurrentCharacterBaselineVersion();
}

export { acknowledgeCharacterCardChange, applyCharacterBaselineRevisionProposal, beginCharacterBoostAnchorEditing, buildCharacterBaselinePrompt, buildCharacterBaselineRevisionPrompt, cancelCharacterBaselineRevisionProposal, cancelCharacterBoostAnchorEditing, captureCharacterRevisionReview, closeCharacterEditorsForChatChange, convertCharacterAnchorDisplayToEnglish, deleteCharacterBaseline, deleteCurrentCharacterBaselineVersion, duplicateCurrentCharacterBaselineVersion, ensureCharacterRevisionReview, extractTaggedCharacterAnchorResult, flushCharacterBaselineAutosave, generateCharacterBaseline, generateCharacterBaselineRevisionProposal, getCharacterBaselineFieldDefinition, getCharacterBaselineGenerationIssues, getCharacterBoostAnchorRequirements, getCharacterEditTarget, getCharacterRevisionBaselineSignature, getCharacterRevisionProposalKey, invalidateCharacterAuditAfterBaselineChange, normalizeCharacterBaselineGenerationPayload, normalizeCharacterBaselineRevisionPayload, notifyCharacterCardChangeIfNeeded, parseCharacterBoostAnchorResult, regenerateCharacterBoostAnchor, renameCurrentCharacterBaselineVersion, requestCharacterBoostAnchor, resolveCharacterSaveTarget, saveCharacterBaselineField, saveCharacterBoostAnchor, saveEditedCharacterBoostAnchor, scheduleCharacterBaselineAutosave, selectCharacterBaselineVersion, setCharacterBoostAnchorEditMode, setCharacterFieldSaveStatus, shouldRetryCharacterAnchorWithoutSchema, shouldRetryTaggedCharacterAnchor, toggleCharacterFieldEditing, toggleCharacterFieldPin, updateCharacterEditorSaveTarget };
