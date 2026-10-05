// StoryBooster: features/recommendation.js
import { GENRE_RECOMMENDATION_MESSAGE_LIMIT, GENRE_RECOMMENDATION_MESSAGE_MAX_CHARS, GENRE_RECOMMENDATION_NO_SUPPORT_ID, MODULE_NAME } from "../core/constants.js";
import { createOperationContextSnapshot, getCurrentCharacterIdentity, getCurrentChatId, getLatestAssistantMessageId, getRoleplayTranscript, isOperationContextCurrentChat, snapshotCurrentChatMessages } from "../core/context.js";
import { createOperationDiagnostic, recordStoryBoosterError, updateOperationDiagnosticConnection } from "../core/diagnostics.js";
import { getBoosterElement } from "../core/dom.js";
import { requestStructuredJsonWithCompatibility, resolveBackgroundConnectionSnapshot } from "../core/requests.js";
import { extractJsonObject } from "../core/responses.js";
import { genreRecommendationPendingChats } from "../core/runtime.js";
import { saveSettingsDebounced } from "../core/sillytavern.js";
import { ensureChatState, ensureGenreAnchorState, ensureModuleSettings, getAvailableGenres, getGenrePromptLabel, isBoosterFeatureEnabled } from "../core/storage.js";
import { populateGenreSelectionControls, updateGenreAnchorPanel } from "../core/ui-hooks.js";
import { markPendingGenreAuditCancelled, updateGenrePrompt } from "./audit.js";
import { getGenreProfile, getGenreProfileSummary } from "./genre-model.js";

export function cancelGenreRecommendation() {
    const chatId = getCurrentChatId();
    if (genreRecommendationPendingChats.has(chatId)) return;
    const state = ensureChatState(chatId);
    state.genreAnchor.recommendation = null;
    saveSettingsDebounced(); renderGenreRecommendation();
}

// @source-order 362
function buildGenreRecommendationPrompt(
    availableGenres = getAvailableGenres(),
    outputLanguage = ensureModuleSettings().outputLanguage
) {
    const genreCatalog = availableGenres
        .map((genre) => {
            const direction = String(
                genre.description ||
                    getGenreProfileSummary(getGenreProfile(genre))
            )
                .replace(/\s+/g, " ")
                .slice(0, 650);
            return `- id=${genre.id} | display_name=${genre.label} | prompt_name=${getGenrePromptLabel(
                genre
            )} | group=${genre.group} | direction=${direction}`;
        })
        .join("\n");

    return [
        "Analyze the supplied recent roleplay window as a coherent scene. Do not continue the roleplay.",
        "Recommend exactly one primary genre and zero or one supporting genre from the catalog below.",
        "The primary genre must best govern {{char}}'s motives, priorities, relationship with {{user}}, scene emphasis, and emotional logic.",
        "The supporting genre is a secondary genre lens. It may contribute characteristic contextual pressure, relationship dynamics, social or world logic, atmosphere, prose rhythm, and material or sensory texture. A story genre such as Crime is valid when those elements are already meaningfully present.",
        "The supporting genre must not compete with the primary emotional and narrative center, seize scene direction, or require an unrelated event merely to display itself.",
        "Do not choose the same genre twice. Prefer no supporting genre if none adds a clearly useful secondary lens.",
        "GENRE CATALOG:",
        genreCatalog,
        outputLanguage === "en"
            ? 'Return JSON only: {"primaryId":"catalog_id","supportId":"catalog_id_or_none","reason":"A concise recommendation reason in natural English, 2–3 sentences"}. Use "none" when no supporting genre is appropriate.'
            : 'Return JSON only: {"primaryId":"catalog_id","supportId":"catalog_id_or_none","reason":"자연스러운 한국어로 간결한 추천 이유 2~3문장"}. 보조 장르가 필요하지 않으면 supportId에 "none"을 사용하세요. Do not write the reason in English except for established proper nouns.',
        "The JSON must be the final answer, not reasoning or thinking.",
    ].join("\n");
}

// @source-order 363
function parseGenreRecommendationResult(
    rawResult,
    availableGenres = getAvailableGenres(),
    outputLanguage = ensureModuleSettings().outputLanguage
) {
    const parsed = extractJsonObject(
        rawResult,
        "Genre recommendation returned no JSON."
    );
    const availableIds = new Set(availableGenres.map((genre) => genre.id));
    if (!availableIds.has(parsed.primaryId)) {
        const error = new Error(
            "Recommended primary genre is not in the catalog."
        );
        error.code = "STORYBOOSTER_INVALID_FIELDS";
        error.invalidFields = ["primaryId"];
        throw error;
    }

    const rawSupportId =
        typeof parsed.supportId === "string" ? parsed.supportId.trim() : "";
    const supportId =
        rawSupportId !== GENRE_RECOMMENDATION_NO_SUPPORT_ID &&
        availableIds.has(rawSupportId) &&
        rawSupportId !== parsed.primaryId
            ? rawSupportId
            : "";

    return {
        primaryId: parsed.primaryId,
        supportId,
        reason: String(
            parsed.reason ||
                (outputLanguage === "en"
                    ? "Recommended from the current roleplay's central relationship and atmosphere."
                    : "현재 롤플의 중심 관계와 분위기를 기준으로 추천했습니다.")
        )
            .trim()
            .slice(0, 600),
    };
}

// @source-order 364
async function generateGenreRecommendation() {
    if (!isBoosterFeatureEnabled("genre")) {
        toastr?.info?.("전역 설정에서 장르 부스터를 켜 주세요.");
        return;
    }
    const chatId = getCurrentChatId();
    if (genreRecommendationPendingChats.has(chatId)) return;
    const chatSnapshot = snapshotCurrentChatMessages();
    const availableGenres = getAvailableGenres();
    const recommendationSettings = ensureModuleSettings();
    const operationContext = createOperationContextSnapshot({
        chatId,
        chatSnapshot,
        characterKey: getCurrentCharacterIdentity()?.key || "",
        profileId: recommendationSettings.analysisProfileId,
        outputLanguage: recommendationSettings.outputLanguage,
        responseLength: 2400,
    });
    const outputLanguage = operationContext.outputLanguage;
    const recommendationDiagnostic = createOperationDiagnostic({
        task: "genre_recommendation",
        responseLength: operationContext.responseLength,
        connectionMode: operationContext.profileId ? "profile" : "main",
    });
    genreRecommendationPendingChats.add(chatId);
    try {
        renderGenreRecommendation();
        const availableGenreIds = availableGenres.map((genre) => genre.id);
        const connectionSnapshot = await resolveBackgroundConnectionSnapshot(
            operationContext.profileId
        );
        updateOperationDiagnosticConnection(
            recommendationDiagnostic,
            connectionSnapshot
        );
        const recommendation = await requestStructuredJsonWithCompatibility({
            prompt: buildGenreRecommendationPrompt(
                availableGenres,
                outputLanguage
            ),
            transcript: getRoleplayTranscript({
                messageLimit: GENRE_RECOMMENDATION_MESSAGE_LIMIT,
                perMessageMaxChars: GENRE_RECOMMENDATION_MESSAGE_MAX_CHARS,
                maxChars: 55000,
                chatSnapshot: operationContext.chatSnapshot,
            }),
            jsonSchema: {
                name: "storybooster_genre_recommendation",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        primaryId: {
                            type: "string",
                            enum: availableGenreIds,
                        },
                        supportId: {
                            type: "string",
                            enum: [
                                GENRE_RECOMMENDATION_NO_SUPPORT_ID,
                                ...availableGenreIds,
                            ],
                        },
                        reason: {
                            type: "string",
                        },
                    },
                    required: ["primaryId", "supportId", "reason"],
                    additionalProperties: false,
                },
            },
            responseLength: operationContext.responseLength,
            connectionSnapshot,
            task: recommendationDiagnostic.task,
            diagnostic: recommendationDiagnostic,
            parseResult: (result) =>
                parseGenreRecommendationResult(
                    result,
                    availableGenres,
                    outputLanguage
                ),
        });
        if (!isBoosterFeatureEnabled("genre")) {
            toastr?.info?.(
                "장르 부스터가 꺼져 있어 추천 결과를 적용하지 않았어요."
            );
            return;
        }
        const currentGenreIds = new Set(
            getAvailableGenres().map((genre) => genre.id)
        );
        if (
            !currentGenreIds.has(recommendation.primaryId) ||
            (recommendation.supportId &&
                !currentGenreIds.has(recommendation.supportId))
        ) {
            throw new Error(
                "추천 중 장르 목록이 변경되어 이전 결과를 적용하지 않았습니다."
            );
        }
        const chatState = ensureChatState(chatId);
        ensureGenreAnchorState(chatState);
        chatState.genreAnchor.recommendation = recommendation;
        saveSettingsDebounced();

        if (isOperationContextCurrentChat(operationContext)) {
            renderGenreRecommendation();
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] genre recommendation failed:`, err);
        recordStoryBoosterError(err, {
            task: recommendationDiagnostic.task,
            diagnostic: recommendationDiagnostic,
        });
        toastr?.error?.(`장르 추천 실패: ${err?.message || err}`);
    } finally {
        genreRecommendationPendingChats.delete(chatId);
        if (isOperationContextCurrentChat(operationContext)) {
            renderGenreRecommendation();
        }
    }
}

// @source-order 365
function renderGenreRecommendation() {
    const button = getBoosterElement("rp-recommend-genre-btn");
    const status = getBoosterElement("rp-recommend-status");
    const resultWrap = getBoosterElement("rp-recommend-result");
    const genres = getBoosterElement("rp-recommend-genres");
    const reason = getBoosterElement("rp-recommend-reason");
    const applyButton = getBoosterElement("rp-recommend-apply-btn");
    const cancelButton = getBoosterElement("rp-recommend-cancel-btn");
    if (!button || !status || !resultWrap || !genres || !reason || !applyButton) return;

    const chatId = getCurrentChatId();
    const pending = genreRecommendationPendingChats.has(chatId);
    const state = ensureChatState();
    const recommendation = state.genreAnchor.recommendation;
    const featureEnabled = isBoosterFeatureEnabled("genre");
    button.disabled = pending || !featureEnabled;
    applyButton.disabled = pending || !featureEnabled;
    if (cancelButton) cancelButton.disabled = pending;
    button.textContent = pending ? "⏳ 분석 중…" : "현재 롤플 분석";
    button.setAttribute("aria-busy", pending ? "true" : "false");
    status.textContent = pending
        ? "최근 롤플을 읽고 주 장르와 보조 장르를 추천하는 중입니다…"
        : featureEnabled
          ? "추천은 자동 적용되지 않습니다."
          : "전역 설정에서 장르 부스터가 꺼져 있습니다.";

    if (!recommendation) {
        resultWrap.hidden = true;
        return;
    }

    const genresById = new Map(getAvailableGenres().map((genre) => [genre.id, genre]));
    const primaryGenre = genresById.get(recommendation.primaryId);
    const supportGenre = genresById.get(recommendation.supportId);
    if (!primaryGenre) {
        resultWrap.hidden = true;
        return;
    }

    genres.textContent =
        `주 장르: ${primaryGenre.emoji} ${primaryGenre.label}` +
        (supportGenre
            ? ` · 보조 장르: ${supportGenre.emoji} ${supportGenre.label}`
            : " · 보조 장르: 없음");
    reason.textContent = recommendation.reason;
    resultWrap.hidden = false;
}

// @source-order 366
function applyGenreRecommendation() {
    const state = ensureChatState();
    const recommendation = state.genreAnchor.recommendation;
    if (!recommendation) return;

    state.genreSelection = {
        primaryId: recommendation.primaryId,
        supportIds: recommendation.supportId ? [recommendation.supportId] : [],
    };
    state.genreAnchor.responseCount = 0;
    markPendingGenreAuditCancelled(state);
    state.genreAnchor.correctionCodes = [];
    state.genreAnchor.correctionText = "";
    state.genreAnchor.correctionFieldIds = [];
    state.genreAnchor.correctionRemaining = 0;
    state.genreAnchor.correctionAppliedMessageId = null;
    state.genreAnchor.correctionArmedRevision = 0;
    state.genreAnchor.auditStatus = "waiting";
    state.genreAnchor.lastCountedMessageId = getLatestAssistantMessageId();
    state.genreAnchor.recommendation = null;
    saveSettingsDebounced();
    populateGenreSelectionControls();
    updateGenrePrompt();
    updateGenreAnchorPanel();
    renderGenreRecommendation();
    toastr?.success?.("추천 장르 구성을 이 채팅에 적용했습니다.");
}


export { applyGenreRecommendation, buildGenreRecommendationPrompt, generateGenreRecommendation, parseGenreRecommendationResult, renderGenreRecommendation };
