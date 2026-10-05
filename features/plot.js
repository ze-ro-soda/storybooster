// StoryBooster: features/plot.js
import { CHARACTER_BOOST_ANCHOR_MAX_CHARS, EVENT_CATEGORIES, EVENT_CATEGORY_DESCRIPTIONS, EVENT_CATEGORY_GUIDANCE, MAX_PLOT_GENERATION_ATTEMPTS, MAX_PLOT_HISTORY, MODULE_NAME, PLOT_CONTEXT_MESSAGE_LIMIT, PLOT_MESSAGE_MAX_CHARS, PLOT_PROMPT_KEY } from "../core/constants.js";
import { createOperationContextSnapshot, getCurrentChatId, getCurrentRoleDisplayNames, getRoleplayTranscript, isOperationContextCurrentChat, isOperationContextCurrentMessages, snapshotCurrentChatMessages } from "../core/context.js";
import { createOperationDiagnostic, recordStoryBoosterError, updateOperationDiagnosticConnection } from "../core/diagnostics.js";
import { escapeHtml, getActiveBoosterPopupRoot, getBoosterElement, getBoosterElements } from "../core/dom.js";
import { generateStructuredAnalysis, requestCurrentRoleplayGenerationStop, resolveBackgroundConnectionSnapshot, withRequestTimeout } from "../core/requests.js";
import { extractTextFromGenerationData, parseJsonOrTaggedPayload, requireStructuredTextFields } from "../core/responses.js";
import { eventGenerationPendingTasks, plotModeDraftsByChat, runtime } from "../core/runtime.js";
import { extension_prompt_roles, extension_prompt_types, getContext, saveSettingsDebounced, setExtensionPrompt } from "../core/sillytavern.js";
import { armPendingGenreCorrectionForNextResponse, ensureChatState, ensureModuleSettings, getAvailablePlotCategories, getCharacterBoosterReadiness, getCurrentCharacterBaseline, getRandomPlotCategory, getSelectedPlotCategory, isBoosterFeatureEnabled, normalizePlotHistory, serializeCharacterBaseline } from "../core/storage.js";
import { automaticPlotRuntime, cancelAutomaticPlot } from '../core/automatic-plot-state.js';

// Headless ordinary random generation shares the existing prompt, validators
// and bounded JSON -> tag -> repair compatibility path. It never calls generate().
async function requestHeadlessPlotEvent({ chatId, selection, isCurrent, signal }) {
    const settings = ensureModuleSettings();
    const category = getRandomPlotCategory();
    if (!category || !isCurrent()) return null;
    const snapshot = snapshotCurrentChatMessages();
    const diagnostic = createOperationDiagnostic({ task: 'automatic_random_generate', responseLength: settings.plotMaxTokens });
    const connectionSnapshot = await resolveBackgroundConnectionSnapshot(settings.plotProfileId);
    const prompt = buildEventGenerationPrompt(category, { surpriseType: 'random',
        characterBoostAnchor: selection.characterBoostAnchor, outputLanguage: settings.outputLanguage });
    const transcript = getRoleplayTranscript({ messageLimit: PLOT_CONTEXT_MESSAGE_LIMIT,
        perMessageMaxChars: PLOT_MESSAGE_MAX_CHARS, maxChars: 48000, chatSnapshot: snapshot });
    const schema = { name: 'storybooster_automatic_random', strict: true, schema: { type: 'object',
        properties: { event: { type: 'string' } }, required: ['event'], additionalProperties: false } };
    const attempt = async (tagged, repair = false) => {
        if (!isCurrent()) throw new Error('자동 사건 생성이 취소되었습니다.');
        const raw = await generateStructuredAnalysis({ prompt: [prompt,
            tagged ? 'COMPATIBILITY OUTPUT: Return exactly <plot_event>event text</plot_event>. Close the tag. No JSON or commentary.' : 'Return only {"event":"event text"}.',
            repair ? 'FINAL REPAIR: Return one complete non-empty event immediately.' : '',
            `Preserve the selected primary genre direction: ${selection.primaryGenre?.label || 'the current roleplay'}.`,
        ].filter(Boolean).join('\n'), transcript, connectionSnapshot,
            responseLength: repair ? Math.max(2400, settings.plotMaxTokens * 2) : settings.plotMaxTokens,
            retryOnLength: false, jsonSchema: tagged ? null : schema, validateJson: !tagged,
            task: 'automatic_random_generate', diagnostic, recordErrors: false, signal });
        const event = parsePlotEventResult(raw, { allowTagged: tagged });
        if (isRoleplayLikePlotCandidate(event) || isPlotOutputLanguageMismatch(event, settings.outputLanguage)) {
            const error = new Error('자동 사건의 형식 또는 언어가 맞지 않습니다.');
            error.code = 'STORYBOOSTER_INVALID_FIELDS'; error.invalidFields = ['event']; throw error;
        }
        return event;
    };
    try {
        let event;
        try { event = await attempt(false); }
        catch (error) {
            if (!shouldRetryPlotEventWithoutSchema(error, connectionSnapshot)) throw error;
            diagnostic.compatibilityFallback = true; diagnostic.retryCount = 1;
            try { event = await attempt(true); }
            catch (taggedError) {
                if (!shouldRetryTaggedPlotEvent(taggedError)) throw taggedError;
                diagnostic.retryCount = 2; event = await attempt(true, true);
            }
        }
        return isCurrent() ? { event, category } : null;
    } catch (error) {
        recordStoryBoosterError(error, { task: 'automatic_random_generate', diagnostic });
        throw error;
    }
}

// @source-order 280
function isPlotSecretMode(chatId = getCurrentChatId()) {
    return ensureChatState(chatId).plotSecretMode === true;
}

// @source-order 281
function getSelectedSecretPlotAction() {
    const action = String(
        getActiveBoosterPopupRoot()?.dataset.secretPlotAction || ""
    );
    return ["random", "crazy", "character_question"].includes(action)
        ? action
        : "";
}

// @source-order 282
function getPlotGenerateButtonLabel(mode, secretMode, secretAction = "") {
    if (mode === "guided") return "✨ 내 아이디어로 플롯 작성";
    if (!secretMode) return "🎲 사건 생성";
    if (secretAction === "random") return "🎁 랜덤박스 열기";
    if (secretAction === "crazy") return "💥 미친 랜덤박스 열기";
    if (secretAction === "character_question") {
        return `❓ ${getCurrentRoleDisplayNames().characterName}의 질문박스`;
    }
    return "🎲 사건 생성";
}

// @source-order 283
function selectSecretPlotAction(type = "") {
    const popupRoot = getActiveBoosterPopupRoot();
    if (!popupRoot || !isPlotSecretMode()) return;
    const normalizedType = ["random", "crazy", "character_question"].includes(
        type
    )
        ? type
        : "";
    popupRoot.dataset.secretPlotAction =
        getSelectedSecretPlotAction() === normalizedType ? "" : normalizedType;
    const selectedAction = getSelectedSecretPlotAction();
    popupRoot.classList.toggle("has-secret-plot-action", Boolean(selectedAction));
    popupRoot.querySelectorAll(".rp-secret-action").forEach((button) => {
        const selected = button.dataset.secretAction === selectedAction;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
    });
    const status = getBoosterElement("rp-event-status");
    if (status) {
        status.textContent = selectedAction
            ? "깜짝 전개를 선택했어요. 아래 생성 버튼을 눌러 실행해 주세요."
            : "선택한 카테고리에 맞는 사건을 플롯 공개 없이 바로 전개합니다.";
    }
    updatePlotGenerationPendingUi();
}

// @source-order 284
function clearSecretPlotAction() {
    const popupRoot = getActiveBoosterPopupRoot();
    if (!popupRoot) return;
    popupRoot.dataset.secretPlotAction = "";
    popupRoot.classList.remove("has-secret-plot-action");
    popupRoot.querySelectorAll(".rp-secret-action").forEach((button) => {
        button.classList.remove("is-selected");
        button.setAttribute("aria-pressed", "false");
    });
}

// @source-order 285
function updatePlotSecretModeUi(chatId = getCurrentChatId()) {
    if (String(chatId) !== String(getCurrentChatId())) return;
    const popupRoot = getActiveBoosterPopupRoot();
    if (!popupRoot) return;
    const enabled = isPlotSecretMode(chatId);
    const toggle = getBoosterElement("rp-plot-secret-toggle");
    const panel = getBoosterElement("rp-plot-secret-tools");
    const resultWrap = getBoosterElement("rp-event-result-wrap");
    const mode = popupRoot.dataset.plotMode || "free";

    popupRoot.classList.toggle("is-plot-secret-mode", enabled);
    if (toggle) {
        toggle.checked = enabled;
        toggle.setAttribute("aria-checked", String(enabled));
    }
    if (panel) panel.hidden = !enabled || mode !== "free";
    if (resultWrap && mode === "free") {
        const draft = getPlotModeDrafts(chatId).free;
        resultWrap.hidden = enabled || !String(draft?.text || "").trim();
    }
    updatePlotGenerationPendingUi(chatId);
}

// @source-order 286
function setPlotSecretMode(enabled) {
    const state = ensureChatState();
    state.plotSecretMode = Boolean(enabled);
    if (!state.plotSecretMode) clearSecretPlotAction();
    saveSettingsDebounced();
    updatePlotSecretModeUi();
    const status = getBoosterElement("rp-event-status");
    if (status) {
        status.textContent = state.plotSecretMode
            ? "선택한 카테고리에 맞는 사건을 플롯 공개 없이 바로 전개합니다."
            : "비밀모드를 껐어요. 생성 결과는 아래에 표시됩니다.";
    }
}

// @source-order 287
function launchSecretSurprise(type) {
    if (!isPlotSecretMode()) {
        toastr?.info?.("비밀모드를 먼저 켜 주세요.");
        return;
    }
    if (type === "crazy") {
        const confirmed = window.confirm(
            "현재 흐름과 무관한 엉뚱한 전개가 발생할 수 있어요. 미친 랜덤박스를 열까요?"
        );
        if (!confirmed) return;
    }
    generateEventCandidate("generate", { surpriseType: type });
}

// @source-order 288
function runSelectedPlotGenerationAction() {
    const popupRoot = getActiveBoosterPopupRoot();
    const mode = popupRoot?.dataset.plotMode || "free";
    const selectedAction =
        mode === "free" && isPlotSecretMode()
            ? getSelectedSecretPlotAction()
            : "";
    if (selectedAction === "random" || selectedAction === "crazy") {
        launchSecretSurprise(selectedAction);
        return;
    }
    if (selectedAction === "character_question") {
        generateCharacterQuestionReply();
        return;
    }
    generateEventCandidate("generate");
}

// @source-order 289
function showPlotGenerationToast(kind, message) {
    toastr?.[kind]?.(message, "스토리부스터", {
        timeOut: 2400,
        extendedTimeOut: 700,
        preventDuplicates: true,
    });
}

// @source-order 290
function createEmptyPlotModeDrafts() {
    return {
        free: { text: "", historyId: "" },
        guided: { text: "", historyId: "" },
    };
}

// @source-order 291
function getPlotModeDrafts(chatId = getCurrentChatId()) {
    const normalizedChatId = String(chatId || "default");
    if (!plotModeDraftsByChat.has(normalizedChatId)) {
        plotModeDraftsByChat.set(normalizedChatId, createEmptyPlotModeDrafts());
    }
    return plotModeDraftsByChat.get(normalizedChatId);
}

// @source-order 292
function updatePlotGenerationPendingUi(chatId = getCurrentChatId()) {
    if (String(chatId) !== String(getCurrentChatId())) return;
    const task = eventGenerationPendingTasks.get(String(chatId));
    const pending = Boolean(task);
    const featureEnabled = isBoosterFeatureEnabled("plot");
    const popupRoot = getActiveBoosterPopupRoot();
    const mode = popupRoot?.dataset.plotMode || "free";
    const secretMode = isPlotSecretMode(chatId);
    const secretAction =
        mode === "free" && secretMode ? getSelectedSecretPlotAction() : "";
    const generateButton = getBoosterElement("rp-event-generate-btn");
    const status = getBoosterElement("rp-event-status");

    if (generateButton) {
        generateButton.disabled = pending || !featureEnabled;
        generateButton.textContent = pending
            ? "⏳ 플롯 생성 중…"
            : getPlotGenerateButtonLabel(mode, secretMode, secretAction);
    }
    getBoosterElements(".rp-plot-mode-button, .rp-event-result-action").forEach(
        (button) => {
            button.disabled = pending || !featureEnabled;
        }
    );
    getBoosterElements(
        ".rp-plot-category-card, .rp-secret-action, #rp-plot-secret-toggle"
    ).forEach((control) => {
        control.disabled = pending || !featureEnabled || runtime.plotPending;
    });
    if (status && pending) {
        status.textContent = "";
    }
}

// @source-order 293
function triggerPlotEvent(eventText, source = "") {
    if (source !== 'automatic_random') cancelAutomaticPlot();
    if (!isBoosterFeatureEnabled("plot")) {
        toastr?.info?.("전역 설정에서 플롯 부스터가 꺼져 있습니다.");
        return;
    }
    const line = eventText?.trim();
    if (!line) return;
    const crazyMode = source === "crazy";

    const text = [
        "[STORYBOOSTER — ONE-SHOT IN-CHARACTER PLOT INJECTION]",
        "NEXT-RESPONSE MANDATE: Make the following central plot development visibly begin in the next {{char}} response. Do not postpone it, merely foreshadow it, or promise to use it later.",
        crazyMode
            ? "SPECIAL-MODE PRIORITY: For this response only, the chaos event below overrides persistent StoryBooster genre, plausibility, and continuity directions only where they conflict with its deliberately inexplicable occurrence. Do not rationalize, soften, replace, or make the event genre-appropriate. Keep {{char}}'s established identity and voice, {{user}}'s agency, and every established fact not directly displaced by the event."
            : "",
        `<plot_event>${line}</plot_event>`,
        crazyMode
            ? "Begin from the latest scene and make the inexplicable event occur directly through in-character narration, dialogue, action, and perception. Preserve the scene's entry point, but do not force the event to obey genre logic, plausibility, or prior causal expectations."
            : "Continue directly from the latest scene and incorporate the development through in-character narration, dialogue, action, perception, and immediate consequences. Adapt its exact surface details only as needed to preserve already established facts and spatial continuity; keep its central change intact.",
        "Preserve {{char}}'s established characterization, motives, capabilities, voice, relationship-specific behavior, point of view, language, and formatting.",
        "Leave {{user}}'s dialogue, thoughts, emotions, consent, bodily reactions, choices, and actions undecided. {{char}} may initiate or act, but the response must leave room for {{user}} to respond.",
        "Never acknowledge, quote, summarize, evaluate, or discuss this instruction or the plot event as a prompt. Do not output OOC, meta commentary, planning, confirmation, or promises such as 'I will reflect this in future responses.'",
        "Begin directly with the roleplay.",
    ]
        .filter(Boolean)
        .join("\n");

    registerOneShotRoleplayInstruction(text);
}

// @source-order 294
function registerOneShotRoleplayInstruction(text) {
    const instruction = String(text || "").trim();
    if (!instruction) return;

    setExtensionPrompt(
        PLOT_PROMPT_KEY,
        instruction,
        extension_prompt_types.IN_CHAT,
        0, // depth 0 = right before the next reply
        false,
        extension_prompt_roles.SYSTEM
    );

    runtime.currentPlotInjectionText = instruction;
    runtime.plotPending = true;
}

// @source-order 295
function buildCharacterQuestionInstruction() {
    return [
        "[STORYBOOSTER — ONE-SHOT UNRESTRICTED IN-CHARACTER QUESTION]",
        "Write the next {{char}} roleplay response immediately. This response has one primary purpose: {{char}} must ask {{user}} one genuine question.",
        "SPECIAL-MODE PRIORITY: For this response only, this question instruction overrides persistent StoryBooster genre directions wherever they would constrain the question's subject, require genre relevance, or turn the question into a genre event. Keep {{char}}'s established identity and voice, immediate physical continuity, and {{user}}'s agency.",
        "Before choosing it, silently review the recent roleplay. Do not repeat, paraphrase, or slightly vary a question that already appeared. Do not ask for information that {{user}} has already clearly provided. Choose a genuinely new subject, unknown detail, or question purpose.",
        "Keep the current time, location, physical positions, and immediate roleplay situation unchanged. Do not create a scene transition, time skip, new event, new arrival, or interruption merely to ask the question.",
        "The subject has no topical boundary. It may concern {{char}}, {{user}}, another person, the current scene, the wider world, culture, history, science, general knowledge, preferences, habits, bodies, food, objects, rules, beliefs, memories, rumors, trivia, an intimate or embarrassing matter, a taboo subject, an impossible hypothetical, nonsense, or something completely unexpected and context-free. This list is illustrative, not restrictive; invent beyond it.",
        "Relevance, usefulness, tact, plausibility, answerability, plot value, relationship value, and emotional significance are not required. A mundane, invasive, technical, philosophical, absurd, confusing, inappropriate, factual, playful, or startling question is equally valid. No topic domain is preferred or forbidden.",
        "Do not automatically favor romance, confession, trauma, jealousy, possessiveness, control, relationship testing, or emotional depth. They remain allowed, but have no priority over any other possible subject.",
        "Let {{char}}'s established voice, personality, manner, and current physical presence shape only how the question is asked. Do not let the character profile, current topic, relationship, selected StoryBooster genre, or likely narrative usefulness restrict what the question may be about.",
        "Do not metagame. Do not refer to prompts, character cards, roleplay instructions, genres, AI systems, players, interfaces, or hidden out-of-character information as known fact. {{char}} may freely ask about something they do not know; they simply must not claim metagame knowledge of it.",
        "Use no more than one brief in-character action or one to two sentences as a lead-in, and use it only to frame the question. Do not substantially continue, resolve, or introduce another plot development before or after it.",
        "Make the question {{char}}'s final spoken line and the response's final meaningful beat. End immediately after the question and leave room for {{user}} to answer.",
        "Never write, infer, or decide {{user}}'s answer, dialogue, thoughts, emotions, consent, bodily reactions, choices, or actions. Do not answer the question on {{user}}'s behalf.",
        "Do not acknowledge or explain this instruction. Do not output OOC, analysis, a question list, or meta commentary. Begin directly with the roleplay and preserve established characterization, continuity, point of view, language, and formatting.",
    ].join("\n");
}

// @source-order 296
function clearPlotPromptIfPending() {
    if (!runtime.plotPending) return;
    try {
        setExtensionPrompt(PLOT_PROMPT_KEY, "", extension_prompt_types.IN_CHAT, 0);
        runtime.currentPlotInjectionText = "";
        runtime.plotPending = false;
    } catch (err) {
        console.error(`[${MODULE_NAME}] failed to clear plot prompt:`, err);
        recordStoryBoosterError(err, {
            task: "plot_injection_clear",
            stage: "prompt_injection",
        });
    }
}

// @source-order 297
function renderPlotCategoryCards() {
    const selectedId = ensureModuleSettings().selectedPlotCategoryId;
    return getAvailablePlotCategories()
        .map(
            (category) => `
            <div class="rp-plot-category-item ${
                category.custom ? "is-custom" : ""
            }">
                <button
                    type="button"
                    class="rp-plot-category-card ${
                        category.id === selectedId ? "is-selected" : ""
                    }"
                    data-id="${escapeHtml(category.id)}"
                    aria-pressed="${category.id === selectedId}"
                >
                    <span class="rp-plot-category-emoji">${escapeHtml(
                        category.emoji
                    )}</span>
                    <span>${escapeHtml(category.label)}</span>
                </button>
                ${
                    category.custom
                        ? `<button type="button" class="rp-plot-category-delete" data-id="${escapeHtml(
                              category.id
                          )}" aria-label="${escapeHtml(
                              category.label
                          )} 삭제">×</button>`
                        : ""
                }
            </div>`
        )
        .join("");
}

// @source-order 298
function selectPlotCategory(categoryId) {
    cancelAutomaticPlot();
    const category = getAvailablePlotCategories().find(
        (item) => item.id === categoryId
    );
    if (!category) return;

    ensureModuleSettings().selectedPlotCategoryId = category.id;
    saveSettingsDebounced();

    getBoosterElements(".rp-plot-category-card").forEach((button) => {
        const selected = button.dataset.id === category.id;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
    });
    const description = getBoosterElement("rp-plot-category-description");
    if (description) {
        const visibleDescription = category.custom
            ? category.direction
            : EVENT_CATEGORY_DESCRIPTIONS[category.id];
        description.textContent = visibleDescription
            ? `${category.emoji} ${category.label} · ${visibleDescription}`
            : `${category.emoji} ${category.label} · 입력한 이름을 중심으로 현재 맥락에 맞게 생성합니다.`;
    }
}

// @source-order 299
function refreshPlotCategoryCards() {
    const grid = getBoosterElement("rp-plot-category-grid");
    if (!grid) return;
    grid.innerHTML = renderPlotCategoryCards();
    selectPlotCategory(getSelectedPlotCategory().id);
}

// @source-order 300
function addCustomPlotCategory() {
    const emojiInput = getBoosterElement("rp-custom-plot-emoji");
    const nameInput = getBoosterElement("rp-custom-plot-name");
    const directionInput = getBoosterElement("rp-custom-plot-direction");
    const status = getBoosterElement("rp-custom-plot-status");
    if (!emojiInput || !nameInput || !directionInput || !status) return;

    const emoji = emojiInput.value.trim().slice(0, 8) || "✨";
    const label = nameInput.value.trim().slice(0, 40);
    const direction = directionInput.value.trim().slice(0, 500);
    if (!label) {
        status.textContent = "카테고리 이름을 입력해 주세요.";
        nameInput.focus();
        return;
    }

    const duplicate = getAvailablePlotCategories().some(
        (category) =>
            category.label.toLocaleLowerCase() === label.toLocaleLowerCase()
    );
    if (duplicate) {
        status.textContent = "같은 이름의 플롯 카테고리가 이미 있습니다.";
        return;
    }

    const category = {
        id: `custom_plot_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 8)}`,
        label,
        emoji,
        direction,
        custom: true,
    };
    const settings = ensureModuleSettings();
    settings.customPlotCategories.push(category);
    settings.selectedPlotCategoryId = category.id;
    emojiInput.value = "";
    nameInput.value = "";
    directionInput.value = "";
    status.textContent = `“${label}” 카테고리를 추가했습니다.`;
    saveSettingsDebounced();
    refreshPlotCategoryCards();
}

// @source-order 301
function deleteCustomPlotCategory(categoryId) {
    const settings = ensureModuleSettings();
    const category = settings.customPlotCategories.find(
        (item) => item.id === categoryId
    );
    if (!category) return;
    if (!window.confirm(`“${category.label}” 플롯 카테고리를 삭제할까요?`)) {
        return;
    }

    settings.customPlotCategories = settings.customPlotCategories.filter(
        (item) => item.id !== categoryId
    );
    if (settings.selectedPlotCategoryId === categoryId) {
        settings.selectedPlotCategoryId = EVENT_CATEGORIES[0].id;
    }
    saveSettingsDebounced();
    refreshPlotCategoryCards();
}

// @source-order 302
function activatePlotGenerationMode(mode) {
    const popupRoot = getActiveBoosterPopupRoot();
    if (!popupRoot || !["free", "guided"].includes(mode)) return;
    const previousMode = popupRoot.dataset.plotMode;
    if (["free", "guided"].includes(previousMode)) {
        capturePlotModeDraft(previousMode);
    }
    popupRoot.dataset.plotMode = mode;
    if (mode !== "free") clearSecretPlotAction();

    popupRoot.querySelectorAll(".rp-plot-mode-button").forEach((button) => {
        const selected = button.dataset.mode === mode;
        button.classList.toggle("is-active", selected);
        button.setAttribute("aria-pressed", String(selected));
    });
    const ideaWrap = getBoosterElement("rp-plot-idea-wrap");
    if (ideaWrap) ideaWrap.hidden = mode !== "guided";
    const categorySection = getBoosterElement(
        "rp-plot-category-section"
    );
    if (categorySection) categorySection.hidden = mode === "guided";
    const generateButton = getBoosterElement("rp-event-generate-btn");
    if (generateButton) {
        generateButton.textContent = getPlotGenerateButtonLabel(
            mode,
            isPlotSecretMode(),
            getSelectedSecretPlotAction()
        );
    }
    restorePlotModeDraft(mode);
    updatePlotSecretModeUi();
}

// @source-order 303
function capturePlotModeDraft(mode) {
    if (!["free", "guided"].includes(mode)) return;
    const resultField = getBoosterElement("rp-event-result");
    if (!resultField) return;
    getPlotModeDrafts()[mode] = {
        text: resultField.value,
        historyId: resultField.dataset.historyId || "",
    };
}

// @source-order 304
function restorePlotModeDraft(mode) {
    const resultWrap = getBoosterElement("rp-event-result-wrap");
    const resultField = getBoosterElement("rp-event-result");
    if (!resultWrap || !resultField) return;

    const draft = getPlotModeDrafts()[mode] || { text: "", historyId: "" };
    resultField.value = draft.text;
    if (draft.historyId) {
        resultField.dataset.historyId = draft.historyId;
    } else {
        delete resultField.dataset.historyId;
    }
    resultWrap.hidden = !draft.text.trim();
    updatePlotHistoryUI();
}

// @source-order 305
function getPlotOutputInstruction(
    language = ensureModuleSettings().outputLanguage
) {
    return language === "en"
        ? 'OUTPUT LANGUAGE AND FORMAT REQUIREMENT: Write the entire value of the "event" field in natural English in 1–3 decisive sentences as the direct next plot development. State what concretely changes, its immediate effect, and the unresolved opening it leaves. Begin with the requested-direction-appropriate behavior, condition, information, interaction, or change; do not hedge with a list of things that could happen. Do not introduce or label it with phrases such as "This episode", "This scene", or "The plot". Do not use Korean narration. Do not write direct dialogue, internal monologue, character-roleplay narration, or a completed scene.'
        : '출력 언어·형식 필수 조건: "event" 필드 전체를 반드시 자연스러운 한국어 1~3개의 단호한 문장으로 다음 플롯 전개 자체를 바로 작성하라. 무엇이 구체적으로 변하는지, 그 즉각적인 영향과 이후에 남는 가능성을 적어라. 요청한 방향에 맞는 행동·조건·정보·상호작용·변화로 곧바로 시작하고, 일어날 수도 있는 일의 목록처럼 흐리게 쓰지 마라. "이 에피소드는", "이 장면은", "~한 에피소드입니다", "~한 장면입니다"처럼 소개하거나 규정하는 문구를 쓰지 마라. 기존 고유명사만 원어로 유지하라. 직접 대사, 내면 독백, 캐릭터 롤플 서술, 완성된 장면을 쓰지 마라. 영어 서술을 출력하지 마라.';
}

// @source-order 306
function getPlotCandidateFormatIssues(text) {
    const value = String(text || "").trim();
    if (!value) return ["empty"];

    const issues = [];
    const directDialogue =
        /["“][^"”\n]{8,}[.!?…][^"”\n]*["”]|['‘][^'’\n]{8,}[.!?…][^'’\n]*['’]/u;
    const dialogueLine =
        /(?:^|\n)\s*(?:[-—]\s+|[^\n:]{1,24}:\s*["“‘])[^\n]{3,}/mu;
    const roleplayAction = /(?:^|\n)\s*\*[^*\n]{3,}\*\s*(?:$|\n)/mu;
    const koreanSceneVerbs =
        value.match(
            /(?:했다|였다|있었다|없었다|보았다|봤다|말했다|물었다|대답했다|속삭였다|웃었다|움직였다|다가갔다|돌아섰다|내밀었다|잡았다|열었다|닫았다|느꼈다)(?=[.!?…]|$)/gu
        ) || [];
    const englishSceneSentences =
        value.match(
            /(?:^|[.!?]\s+)(?:I|We|He|She|They|[A-Z][a-z]+)\s+(?:said|asked|looked|walked|opened|turned|felt|smiled|reached|stepped|leaned|grabbed|whispered)\b/gu
        ) || [];
    const metaFraming =
        /^(?:(?:이|이번|해당)\s*(?:에피소드|장면|플롯)(?:는|은|에서는|에서|가|이)?\s*|(?:[^.!?\n]{0,48})?(?:에피소드|장면)(?:입니다|이다)(?:[.!?\s]|$)|(?:this|the)\s+(?:episode|scene|plot|story|event|development)\s+(?:is|involves|focuses\s+on|centers\s+on|would|will)\b|(?:in|for)\s+this\s+(?:episode|scene|plot|story)\b)/iu;

    if (directDialogue.test(value) || dialogueLine.test(value)) {
        issues.push("direct_dialogue");
    }
    if (roleplayAction.test(value)) issues.push("roleplay_action");
    if (koreanSceneVerbs.length >= 2 || englishSceneSentences.length >= 2) {
        issues.push("scene_narration");
    }
    if (metaFraming.test(value)) issues.push("meta_framing");

    return issues;
}

// @source-order 307
function isRoleplayLikePlotCandidate(text) {
    return getPlotCandidateFormatIssues(text).length > 0;
}

// @source-order 308
function isPlotOutputLanguageMismatch(
    text,
    language = ensureModuleSettings().outputLanguage
) {
    const hangulCount = (String(text).match(/[가-힣]/g) || []).length;
    const latinCount = (String(text).match(/[A-Za-z]/g) || []).length;
    if (language === "ko") {
        if (hangulCount === 0) return true;
        const letterCount = hangulCount + latinCount;
        return letterCount >= 80 && hangulCount / letterCount < 0.2;
    }
    return hangulCount > Math.max(8, latinCount);
}

// @source-order 309
function getPlotHistory(chatId = getCurrentChatId()) {
    return normalizePlotHistory(ensureChatState(chatId));
}

// @source-order 310
function recordPlotHistory({
    text,
    mode,
    categoryId,
    userIdea,
    surpriseType = "",
    chatId = getCurrentChatId(),
    updateUi = true,
}) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return null;

    const state = ensureChatState(chatId);
    const entry = {
        id: `plot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        text: normalizedText,
        createdAt: Date.now(),
        mode: mode === "guided" ? "guided" : "free",
        categoryId: String(categoryId || ""),
        userIdea: String(userIdea || "").slice(0, 2000),
        surpriseType: ["secret", "random", "crazy"].includes(surpriseType)
            ? surpriseType
            : "",
    };
    state.plotHistory = [
        entry,
        ...normalizePlotHistory(state).filter(
            (item) => item.text !== normalizedText
        ),
    ].slice(0, MAX_PLOT_HISTORY);
    saveSettingsDebounced();

    if (updateUi && getCurrentChatId() === chatId) {
        const resultField = getBoosterElement("rp-event-result");
        if (resultField) resultField.dataset.historyId = entry.id;
        updatePlotHistoryUI();
    }
    return entry;
}

// @source-order 311
function getPlotHistoryModeLabel(entry) {
    if (entry.surpriseType === "crazy") return "💥 미친 랜덤박스";
    if (entry.surpriseType === "random") {
        const category = getAvailablePlotCategories().find(
            (item) => item.id === entry.categoryId
        );
        return category
            ? `🎁 랜덤박스 · ${category.emoji} ${category.label}`
            : "🎁 랜덤박스";
    }
    if (entry.surpriseType === "secret") return "🔒 비밀모드";
    return "";
}

// @source-order 312
function renderPlotHistoryCards() {
    const history = getPlotHistory();
    const currentHistoryId =
        getBoosterElement("rp-event-result")?.dataset.historyId || "";

    if (history.length === 0) {
        return '<p class="rp-plot-history-empty">아직 저장된 추천이 없습니다.</p>';
    }

    return history
        .map(
            (entry, index) => `
            <article class="rp-plot-history-card ${
                entry.id === currentHistoryId ? "is-current" : ""
            }">
                <div class="rp-plot-history-card-head">
                    <strong>${index === 0 ? "최근 추천" : `이전 추천 ${index}`}${
                        entry.id === currentHistoryId
                            ? ' <span class="rp-plot-history-current">현재</span>'
                            : ""
                    }</strong>
                    <button
                        type="button"
                        class="rp-plot-history-delete"
                        data-history-id="${escapeHtml(entry.id)}"
                        aria-label="이 추천 삭제"
                        title="삭제"
                    >×</button>
                </div>
                ${
                    getPlotHistoryModeLabel(entry)
                        ? `<div class="rp-plot-history-mode">${escapeHtml(
                              getPlotHistoryModeLabel(entry)
                          )}</div>`
                        : ""
                }
                <p>${escapeHtml(entry.text)}</p>
                <button
                    type="button"
                    class="menu_button rp-plot-history-load"
                    data-history-id="${escapeHtml(entry.id)}"
                >추천창으로 불러오기</button>
            </article>`
        )
        .join("");
}

// @source-order 313
function updatePlotHistoryUI() {
    const history = getPlotHistory();
    const badge = getBoosterElement("rp-plot-history-count");
    const list = getBoosterElement("rp-plot-history-list");
    const clearButton = getBoosterElement("rp-plot-history-clear");

    if (badge) {
        badge.textContent = String(history.length);
        badge.hidden = history.length === 0;
    }
    if (list) list.innerHTML = renderPlotHistoryCards();
    if (clearButton) clearButton.hidden = history.length === 0;
}

// @source-order 314
function togglePlotHistoryDrawer(forceOpen) {
    const popover = getBoosterElement("rp-plot-history-drawer");
    const button = getBoosterElement("rp-plot-history-btn");
    if (!popover || !button) return;

    const shouldOpen =
        typeof forceOpen === "boolean" ? forceOpen : popover.hidden;
    popover.hidden = !shouldOpen;
    button.setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) updatePlotHistoryUI();
}

// @source-order 315
function loadPlotHistoryItem(historyId) {
    const entry = getPlotHistory().find((item) => item.id === historyId);
    const resultWrap = getBoosterElement("rp-event-result-wrap");
    const resultField = getBoosterElement("rp-event-result");
    const status = getBoosterElement("rp-event-status");
    if (!entry || !resultWrap || !resultField) return;

    activatePlotGenerationMode(entry.mode);
    if (
        entry.mode === "free" &&
        getAvailablePlotCategories().some(
            (category) => category.id === entry.categoryId
        )
    ) {
        selectPlotCategory(entry.categoryId);
    }
    const ideaInput = getBoosterElement("rp-plot-idea");
    if (ideaInput) ideaInput.value = entry.userIdea;

    resultField.value = entry.text;
    resultField.dataset.historyId = entry.id;
    resultWrap.hidden = false;
    capturePlotModeDraft(entry.mode);
    if (status) {
        status.textContent =
            "기존 추천을 불러왔습니다. 다듬거나 새 방향으로 바꾼 뒤 적용할 수 있어요.";
    }
    togglePlotHistoryDrawer(false);
    updatePlotHistoryUI();
    requestAnimationFrame(() => {
        resultWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
        resultField.focus({ preventScroll: true });
    });
}

// @source-order 316
function deletePlotHistoryItem(historyId) {
    const state = ensureChatState();
    state.plotHistory = getPlotHistory().filter(
        (entry) => entry.id !== historyId
    );
    const resultField = getBoosterElement("rp-event-result");
    if (resultField?.dataset.historyId === historyId) {
        delete resultField.dataset.historyId;
    }
    saveSettingsDebounced();
    updatePlotHistoryUI();
}

// @source-order 317
function clearPlotHistory() {
    if (!getPlotHistory().length) return;
    if (!window.confirm("이 채팅의 최근 플롯 추천 기록을 모두 삭제할까요?")) {
        return;
    }

    ensureChatState().plotHistory = [];
    const resultField = getBoosterElement("rp-event-result");
    if (resultField) delete resultField.dataset.historyId;
    saveSettingsDebounced();
    updatePlotHistoryUI();
}

// @source-order 318
function buildEventGenerationPrompt(
    category,
    {
        operation = "generate",
        currentEvent = "",
        history = [],
        userIdea = "",
        characterBoostAnchor = "",
        outputLanguage = ensureModuleSettings().outputLanguage,
        surpriseType = "",
    } = {}
) {
    const isCrazyRandom = surpriseType === "crazy";
    const categoryGuidance = !isCrazyRandom && category?.id
        ? EVENT_CATEGORY_GUIDANCE[category.id] || null
        : null;
    const compactCharacterAnchor = String(characterBoostAnchor || "")
        .trim()
        .slice(0, CHARACTER_BOOST_ANCHOR_MAX_CHARS);
    const characterContinuityLines = isCrazyRandom
        ? []
        : compactCharacterAnchor
        ? [
              "CHARACTER CONTINUITY FOR PLOT PLANNING:",
              `<character_boost_anchor>\n${compactCharacterAnchor}\n</character_boost_anchor>`,
              "Use this compact anchor only to keep the proposed development faithful to {{char}}'s distinctive motives, values, boundaries, capabilities, speech or behavioral tendencies, and relationship-specific responses. Keep it subordinate to the supplied transcript and established roleplay context; do not quote or explain it.",
              "The plot must not require {{char}} to adopt a stock trope or contradict established characterization merely to create drama. Any unusual choice must have a visible cause in the supplied transcript and remain plausible as development, pressure, concealment, or regression for this specific character.",
          ]
        : [
              "No compact character-booster anchor is available. Infer characterization conservatively from the supplied transcript and do not invent a stock personality or relationship trope to create drama.",
          ];
    const ideaLines = isCrazyRandom
        ? [
              "Invent the occurrence independently. Do not optimize it for coherence, plausibility, genre fit, usefulness, emotional relevance, continuity, tasteful storytelling, or smooth integration. Impossible, absurd, disproportionate, tonally disruptive, or inexplicable results are welcome.",
          ]
        : userIdea
        ? [
              "USER-IDEA CONTRACT: Preserve the supplied idea's central intent, desired direction, and recognizable core. Improve only the causality, specificity, character fit, and integration needed to make it usable in the current roleplay; do not replace it with a more dramatic idea.",
              `<user_plot_idea>${userIdea}</user_plot_idea>`,
          ]
        : ["Create the event freely within the selected category contract."];

    const categoryContractLines = isCrazyRandom
        ? [
              "CHAOS MODE: Ignore the current roleplay, selected genre, plot categories, character anchor, relationship direction, tone, world rules, causality, and prior suggestions when inventing the occurrence.",
              "Generate three maximally different possibilities silently. Discard the easiest one to explain and the most conventional one. Return only the strangest remaining possibility.",
              "The result must be genuinely unpredictable, oddly specific, and unlike a responsible plot planner's choice. Do not soften, justify, foreshadow, rationalize, or make it meaningful.",
              "Reject safe default twists such as a generic mysterious message, package, stranger, emergency, hidden secret, misunderstanding, or routine interruption.",
          ]
        : category
        ? [
              "SELECTED CATEGORY CONTRACT:",
              `Category: ${category.promptLabel || category.label}.`,
              category.direction
                  ? `Central direction: ${category.direction}`
                  : "Interpret this user-defined category by its exact name and apply its semantic function directly.",
              "CATEGORY PRIORITY: The selected category determines the development's type, narrative function, and degree of change. Do not substitute a more dramatic, familiar, or genre-flavored plot pattern for it.",
              categoryGuidance?.required ||
                  "CUSTOM CATEGORY: Treat the category name and supplied direction as a hard semantic contract. The result must remain recognizable as this category even when its label is removed.",
              categoryGuidance?.avoid ||
                  "Do not broaden the user-defined direction into a different built-in category or use higher stakes to compensate for an unclear fit.",
              categoryGuidance?.completion ||
                  "A complete candidate states the category-specific development, its grounding in the current context, and the usable opening left for what follows.",
          ]
        : [
              "NO CATEGORY CONTRACT: Follow the user's rough idea directly. Do not force it into a built-in category or import a more familiar plot pattern.",
          ];

    const generalDevelopmentRequirement = isCrazyRandom
        ? "Return one concrete occurrence that begins immediately in-world when injected. It may violate realism, genre, tone, causality, continuity, or established world rules and may remain completely unexplained. It must be an event rather than random words or a vague dreamlike summary."
        : category
        ? "Keep the scale and kind of change appropriate to the selected category. A subtle emotional, relational, informational, environmental, or everyday shift can be a complete plot development when that is the category's function."
        : "The refined user idea must create a clear, context-specific and usable next development without being forced into an unrelated preset plot pattern.";

    const operationLines = isCrazyRandom
        ? [
              "CHAOS GENERATION TASK: Invent one independent, concrete, in-world occurrence without using the current roleplay, a selected category, a character anchor, or previous suggestions as creative guidance.",
          ]
        : operation === "refine"
            ? [
                  "REFINEMENT TASK: Preserve the current candidate's central premise, intended direction, and recognizable core.",
                  "Improve its specificity, causal plausibility, fidelity to the selected category, relevance to established characterization and relationships, and usable forward movement. Do not enlarge or redirect the event into a more dramatic plot type. Do not replace it with a completely different event.",
                  `<current_candidate>${currentEvent}</current_candidate>`,
              ]
            : operation === "new_direction"
              ? [
                    "NEW DIRECTION TASK: Treat this as a fresh brainstorming session, not an iteration or refinement of earlier suggestions.",
                    "Do not repeat, rephrase, combine, or create a minor variation of the current candidate or any previous suggestion.",
                    "Generate a genuinely different development that preserves the selected category's narrative function, scale, and exclusions. Novelty must come from category-relevant content rather than higher stakes or a different plot type.",
                    categoryGuidance?.novelty
                        ? `The new direction must differ from earlier suggestions in at least two category-relevant dimensions: ${categoryGuidance.novelty}. Prefer category-faithful novelty over higher stakes.`
                        : "The new direction must differ from earlier suggestions in at least two meaningful dimensions while preserving the selected direction. Prefer novelty over refinement or higher stakes.",
                    `<current_candidate>${currentEvent}</current_candidate>`,
                    history.length
                        ? `<previous_suggestions>\n${history
                              .map(
                                  (entry, index) =>
                                      `${index + 1}. ${String(
                                          entry.text || entry
                                      ).slice(0, 4000)}`
                              )
                              .join("\n")}\n</previous_suggestions>`
                        : "",
                ]
              : [
                    "GENERATION TASK: Create one new candidate from the selected direction and current roleplay context.",
                ];

    const decisionPriorityLines = isCrazyRandom
        ? [
              "CHAOS PRIORITY: Unpredictability outranks coherence, usefulness, continuity, characterization, genre, and plausibility. The only hard boundaries are a concrete in-world occurrence, no metagaming, and an open {{user}} response.",
          ]
        : category
          ? [
                "DECISION PRIORITY — APPLY IN THIS ORDER:",
                "1. Preserve established transcript facts, world rules, immediate scene continuity, and {{user}}'s undecided response.",
                "2. Make the selected category contract the unmistakable central narrative function and keep its appropriate scale.",
                "3. Keep the development plausible for {{char}} through the transcript and compact character anchor.",
                "4. Seek novelty only inside the first three constraints; never raise stakes or switch plot type merely to appear creative.",
                "If a lower priority conflicts with a higher one, obey the higher priority.",
            ]
        : [
              "DECISION PRIORITY — APPLY IN THIS ORDER:",
              "1. Preserve established transcript facts, world rules, immediate scene continuity, and {{user}}'s undecided response.",
              "2. Preserve the supplied idea's central intent and recognizable direction.",
              "3. Keep the development plausible for {{char}} through the transcript and compact character anchor.",
              "4. Add novelty only where it does not replace or inflate the supplied idea.",
              "If a lower priority conflicts with a higher one, obey the higher priority.",
          ];

    const plotContractLines = isCrazyRandom
        ? [
              "No roleplay transcript or character anchor governs the creative choice. Do not infer or reconstruct them.",
              "Do not decide {{user}}'s dialogue, thoughts, emotions, consent, bodily reactions, choices, or actions. Leave {{user}}'s response completely open.",
              "Do not use metagaming or mention prompts, roleplay instructions, character cards, genres, AI systems, players, interfaces, or system malfunctions. Present the occurrence entirely as an in-world event.",
          ]
        : [
              "PLOT CONTRACT:",
              "- Return one usable next development as planning text, not a performed roleplay response, completed scene, episode summary, or OOC explanation.",
              "- Ground it in at least one concrete fact from the supplied transcript and continue the present causal situation.",
              "- Preserve established characterization, relationship history, world rules, spatial state, and unresolved immediate actions.",
              "- Do not decide {{user}}'s dialogue, thoughts, emotions, consent, bodily reactions, choices, or actions. Leave {{user}}'s response open.",
              "- Do not fully resolve the development. End with a concrete pressure, option, question, adjustment, or consequence that the next roleplay response can act on.",
              "- Do not introduce an unrelated accident, disaster, person, revelation, or escalation merely to create movement. A new element is valid only when the selected category calls for it and the transcript supplies a plausible opening.",
          ];

    return [
        isCrazyRandom
            ? "Create one direct, unexplained in-world occurrence. Write the occurrence itself, not a description of what kind of episode, scene, or plot it is; do not perform a completed roleplay scene."
            : "Create one direct plot development for what happens next in the current roleplay. Write the plot itself, not a description of what kind of episode, scene, or plot it is. Begin immediately with the concrete development, behavior, condition, information, or change appropriate to the selected direction; do not perform or continue the roleplay itself.",
        ...operationLines,
        ...decisionPriorityLines,
        ...categoryContractLines,
        ...ideaLines,
        ...plotContractLines,
        ...characterContinuityLines,
        isCrazyRandom
            ? "Use only the requested output language and the explicit no-metagaming and {{user}}-agency boundaries. Nothing else constrains the creative choice."
            : "Use only the supplied roleplay transcript, selected plot category, optional user idea, and previous suggestions as creative context. Do not consult or infer StoryBooster genre selections when choosing the development.",
        generalDevelopmentRequirement,
        isCrazyRandom
            ? ""
            : "Do not create jealousy, possessiveness, obsession, overprotectiveness, territorial behavior, controlling behavior, surveillance, or restriction of autonomy as generic relationship tension. Use any of them only when the recent transcript clearly establishes the relevant character tendency and the immediate situation specifically activates it; affection, concern, attraction, fear of loss, danger, or emotional intensity alone is not sufficient evidence.",
        "Use decisive prospective or planning language and state what develops, not what could hypothetically happen. Do not introduce, label, summarize, or evaluate it with phrases such as 'This episode...', 'This scene...', 'The plot...', '이 에피소드는', '이 장면은', '~한 에피소드입니다', or '~한 장면입니다'. Do not write direct dialogue, quoted speech, internal monologue, first-person narration, character-roleplay prose, or a completed scene. The result must still require a separate roleplay generation to become a scene.",
        "Treat these as planning instructions, never as an OOC request to acknowledge, promise future compliance, or explain how the plot should be used.",
        isCrazyRandom
            ? "Before returning the candidate, silently ask whether it feels coherent, useful, tasteful, foreshadowed, or like a familiar plot device. If so, discard it and choose something stranger. Verify only that it is a concrete in-world occurrence, contains no metagaming, and leaves {{user}}'s response open. Output only the candidate, not the check."
            : "Before returning the candidate, silently verify that its central development belongs more clearly to the selected category than to any other built-in category, is grounded in the supplied roleplay, and leaves a usable next step. If another category fits better, rewrite the candidate instead of relabeling it. Output only the candidate, not the check.",
        getPlotOutputInstruction(outputLanguage),
    ]
        .filter(Boolean)
        .join("\n");
}

// @source-order 319
function extractTaggedPlotEventResult(result) {
    const text = extractTextFromGenerationData(result);
    const completeMatch = text.match(
        /<plot_event\b[^>]*>([\s\S]*?)<\/plot_event>/i
    );
    if (completeMatch) return String(completeMatch[1] || "").trim();
    if (/<plot_event\b[^>]*>/i.test(text)) {
        const error = new Error(
            "플롯 태그 응답이 끝나기 전에 중단되었습니다."
        );
        error.code = "STORYBOOSTER_INCOMPLETE_TAGGED_OUTPUT";
        error.invalidFields = ["event"];
        throw error;
    }
    return "";
}

// @source-order 320
function parsePlotEventResult(result, { allowTagged = false } = {}) {
    const parsed = parseJsonOrTaggedPayload(result, {
        allowTagged,
        tagPattern: /<plot_event\b[^>]*>/i,
        parseTagged: (value) => ({ event: extractTaggedPlotEventResult(value) }),
        emptyMessage: "AI가 사건 후보 JSON을 반환하지 않았습니다.",
    });
    const eventText = requireStructuredTextFields(parsed, ["event"]).event.trim();
    if (!eventText) {
        const error = new Error("AI가 빈 사건 후보를 반환했습니다.");
        error.code = "STORYBOOSTER_REQUIRED_FIELDS_MISSING";
        error.missingFields = ["event"];
        throw error;
    }
    return eventText;
}

// @source-order 321
function shouldRetryPlotEventWithoutSchema(error, connectionSnapshot) {
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

// @source-order 322
function shouldRetryTaggedPlotEvent(error) {
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

// @source-order 323
async function generateEventCandidate(operation = "generate", options = {}) {
    cancelAutomaticPlot();
    if (!isBoosterFeatureEnabled("plot")) {
        toastr?.info?.("전역 설정에서 플롯 부스터를 켜 주세요.");
        return;
    }

    const taskChatId = String(getCurrentChatId());
    if (runtime.plotPending) {
        toastr?.info?.("현재 일회성 전개를 적용하고 있어요.");
        return;
    }
    if (eventGenerationPendingTasks.has(taskChatId)) {
        updatePlotGenerationPendingUi(taskChatId);
        toastr?.info?.("이 채팅의 플롯을 이미 생성하고 있어요.");
        return;
    }
    const chatSnapshot = snapshotCurrentChatMessages();
    const plotSettings = ensureModuleSettings();
    const plotCharacterBaselineState = getCurrentCharacterBaseline();
    const plotCharacterReadiness = getCharacterBoosterReadiness(
        plotCharacterBaselineState
    );
    const plotCharacterBoostAnchor = plotCharacterReadiness.boostActive
        ? plotCharacterReadiness.boostAnchor
        : "";
    const operationContext = createOperationContextSnapshot({
        chatId: taskChatId,
        chatSnapshot,
        characterKey: plotCharacterBaselineState.identity?.key || "",
        profileId: plotSettings.plotProfileId,
        outputLanguage: plotSettings.outputLanguage,
        responseLength: plotSettings.plotMaxTokens,
    });
    const plotTokenBudget = operationContext.responseLength;
    const plotOutputLanguage = operationContext.outputLanguage;
    const selectedProfileId = operationContext.profileId;
    const contextEpoch = automaticPlotRuntime.contextEpoch;
    const characterEpoch = automaticPlotRuntime.characterEpoch;
    const baselineSignature = JSON.stringify([
        plotCharacterBaselineState.identity?.key || '',
        plotCharacterBaselineState.versionId || '',
        plotCharacterBaselineState.baseline ? serializeCharacterBaseline(plotCharacterBaselineState.baseline) : '',
        plotCharacterBoostAnchor,
    ]);
    const isAutoApplyContextCurrent = () => {
        if (!isBoosterFeatureEnabled('plot') || !isOperationContextCurrentMessages(operationContext) ||
            automaticPlotRuntime.contextEpoch !== contextEpoch || automaticPlotRuntime.characterEpoch !== characterEpoch) return false;
        const settings = ensureModuleSettings();
        if (String(settings.plotProfileId || '') !== selectedProfileId ||
            settings.outputLanguage !== plotOutputLanguage || settings.plotMaxTokens !== plotTokenBudget) return false;
        const current = getCurrentCharacterBaseline();
        const readiness = getCharacterBoosterReadiness(current);
        return JSON.stringify([current.identity?.key || '', current.versionId || '',
            current.baseline ? serializeCharacterBaseline(current.baseline) : '',
            readiness.boostActive ? readiness.boostAnchor : '',
        ]) === baselineSignature;
    };

    const popupRoot = getActiveBoosterPopupRoot();
    const resultWrap = getBoosterElement("rp-event-result-wrap");
    const resultField = getBoosterElement("rp-event-result");
    const status = getBoosterElement("rp-event-status");
    const generateButton = getBoosterElement("rp-event-generate-btn");
    const ideaInput = getBoosterElement("rp-plot-idea");

    if (!popupRoot || !resultWrap || !resultField || !status || !generateButton) {
        return;
    }

    const mode = popupRoot.dataset.plotMode || "free";
    const requestedSurpriseType = ["random", "crazy"].includes(
        options.surpriseType
    )
        ? options.surpriseType
        : "";
    const surpriseType =
        operation === "generate" && mode === "free"
            ? requestedSurpriseType || (isPlotSecretMode(taskChatId) ? "secret" : "")
            : "";
    const autoInject = Boolean(surpriseType);
    const userIdea = mode === "guided" ? String(ideaInput?.value || "").trim() : "";
    const currentEvent = resultField.value.trim();
    if (operation === "generate" && mode === "guided" && !userIdea) {
        status.textContent = "다듬고 싶은 플롯 키워드나 내용을 먼저 입력해 주세요.";
        ideaInput?.focus();
        return;
    }
    if (["refine", "new_direction"].includes(operation) && !currentEvent) {
        status.textContent = "먼저 플롯 추천을 생성하거나 기존 추천을 불러와 주세요.";
        return;
    }
    const category =
        mode === "guided" || surpriseType === "crazy"
            ? null
            : surpriseType === "random"
              ? getRandomPlotCategory()
              : getSelectedPlotCategory();
    if (surpriseType === "random" && !category) {
        status.textContent = "랜덤박스에서 사용할 카테고리를 찾지 못했어요.";
        return;
    }
    const task = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        operation,
        startedAt: Date.now(),
    };
    const plotDiagnostic = createOperationDiagnostic({
        task: surpriseType
            ? `plot_${surpriseType}_generate`
            : `plot_${operation}`,
        responseLength: plotTokenBudget,
        connectionMode: selectedProfileId ? "profile" : "main",
    });
    eventGenerationPendingTasks.set(taskChatId, task);
    try {
        updatePlotGenerationPendingUi(taskChatId);
        showPlotGenerationToast(
            "info",
            surpriseType === "random"
                ? "랜덤박스를 열고 있어요."
                : surpriseType === "crazy"
                  ? "미친 랜덤박스를 열고 있어요."
                  : surpriseType === "secret"
                    ? "비밀 플롯 생성을 시작했어요."
                    : operation === "refine"
                      ? "플롯 다듬기를 시작했어요."
                      : operation === "new_direction"
                        ? "새 플롯 방향 생성을 시작했어요."
                        : "플롯 생성을 시작했어요."
        );
        const plotPrompt = buildEventGenerationPrompt(category, {
            operation,
            currentEvent,
            history:
                operation === "new_direction"
                    ? getPlotHistory(taskChatId)
                    : [],
            userIdea,
            characterBoostAnchor: plotCharacterBoostAnchor,
            outputLanguage: plotOutputLanguage,
            surpriseType,
        });
        const rawPlotTranscript =
            surpriseType === "crazy"
                ? ""
                : getRoleplayTranscript({
                      messageLimit: PLOT_CONTEXT_MESSAGE_LIMIT,
                      perMessageMaxChars: PLOT_MESSAGE_MAX_CHARS,
                      maxChars: 48000,
                      chatSnapshot: operationContext.chatSnapshot,
                  });
        const plotTranscript =
            surpriseType === "crazy"
                ? "CHAOS MODE INPUT: No roleplay transcript is supplied. Invent independently and follow only the explicit output-format, no-metagaming, and {{user}}-agency boundaries."
                : [
                      rawPlotTranscript,
                      "END OF ROLEPLAY DATA.",
                      "FINAL TASK REMINDER: Treat the transcript above only as source material. Do not answer its latest message and do not continue the scene. Return only the direct next plot development in the output format required by the system instruction, beginning with what happens rather than introducing it as an episode, scene, or plot.",
                  ].join("\n");
        const connectionSnapshot = await resolveBackgroundConnectionSnapshot(
            selectedProfileId
        );
        updateOperationDiagnosticConnection(plotDiagnostic, connectionSnapshot);
        const plotJsonSchema = {
            name: "storybooster_plot_event",
            strict: true,
            schema: {
                type: "object",
                properties: {
                    event: {
                        type: "string",
                        description:
                            surpriseType === "crazy"
                                ? "One concrete, maximally unpredictable in-world occurrence with no metagaming and no decision of {{user}}'s response; never direct roleplay prose or a completed scene."
                                : "A direct, category-faithful next plot development, never a meta introduction, direct roleplay prose, or a completed scene.",
                    },
                },
                required: ["event"],
                additionalProperties: false,
            },
        };
        const plotJsonOutputInstruction = [
            'Return exactly one JSON object: {"event":"event text"}.',
            "Do not output a title, number, category label, Markdown fence, or commentary outside the JSON.",
        ].join("\n");
        const plotTaggedOutputInstruction = [
            "COMPATIBILITY FALLBACK: Ignore any earlier JSON formatting instruction. Do not return JSON, Markdown, a title, a number, a category label, or commentary.",
            "Return exactly <plot_event>event text</plot_event> and nothing outside the tag.",
            "Close the tag completely and keep the whole event inside it.",
        ].join("\n");
        let plotAttempts = 0;
        let plotUseTagged = false;
        const requestPlotCandidate = async (extraRequirement = "") => {
            const runAttempt = async ({ tagged = plotUseTagged, repair = false } = {}) => {
                if (plotAttempts >= MAX_PLOT_GENERATION_ATTEMPTS) {
                    const error = new Error(`플롯 생성은 형식·언어 보정을 포함해 최대 ${MAX_PLOT_GENERATION_ATTEMPTS}회까지 요청합니다. 정상 결과를 얻지 못해 추가 호출을 중단했어요.`);
                    error.code = "STORYBOOSTER_REQUEST_BUDGET_EXHAUSTED";
                    error.stage = "response_validation";
                    throw error;
                }
                plotAttempts += 1;
                plotDiagnostic.retryCount = plotAttempts - 1;
                const result = await generateStructuredAnalysis({
                    prompt: [
                        plotPrompt,
                        extraRequirement,
                        tagged
                            ? plotTaggedOutputInstruction
                            : plotJsonOutputInstruction,
                        repair
                            ? "FINAL REPAIR: The previous tagged response was empty, incomplete, or invalid. Return one complete non-empty plot_event tag immediately."
                            : "",
                    ]
                        .filter(Boolean)
                        .join("\n"),
                    transcript: plotTranscript,
                    jsonSchema: tagged ? null : plotJsonSchema,
                    responseLength: repair
                        ? Math.max(2400, plotTokenBudget * 2)
                        : plotTokenBudget,
                    retryOnLength: false,
                    connectionSnapshot,
                    task: plotDiagnostic.task,
                    diagnostic: plotDiagnostic,
                    recordErrors: false,
                    validateJson: !tagged,
                });
                return parsePlotEventResult(result, {
                    allowTagged: tagged,
                });
            };

            try {
                return await runAttempt();
            } catch (error) {
                if (
                    error?.code === "STORYBOOSTER_REQUEST_BUDGET_EXHAUSTED" ||
                    !shouldRetryPlotEventWithoutSchema(
                        error,
                        connectionSnapshot
                    )
                ) {
                    throw error;
                }
                plotUseTagged = true;
                plotDiagnostic.compatibilityFallback = true;
                plotDiagnostic.retryReason = error?.missingFields?.length
                    ? "필수 사건 필드 누락"
                    : error?.invalidFields?.length
                      ? "사건 필드 오류"
                      : error?.code === "STORYBOOSTER_EMPTY_STRUCTURED_OUTPUT"
                        ? "빈 구조화 응답"
                        : error?.code === "STORYBOOSTER_INCOMPLETE_JSON"
                          ? "불완전한 JSON 응답"
                          : "구조화 출력 요청 오류";
                try {
                    return await runAttempt({ tagged: true });
                } catch (taggedError) {
                    if (!shouldRetryTaggedPlotEvent(taggedError)) {
                        throw taggedError;
                    }
                    plotDiagnostic.retryReason = `${plotDiagnostic.retryReason} · 태그 응답 복구`;
                    return runAttempt({ tagged: true, repair: true });
                }
            }
        };

        let eventText = await requestPlotCandidate();
        if (isRoleplayLikePlotCandidate(eventText)) {
            status.textContent =
                "다음 플롯 자체가 바로 보이도록 형식을 다시 정리하고 있어요…";
            plotDiagnostic.retryReason = [plotDiagnostic.retryReason, "플롯 형식 보정"].filter(Boolean).join(" · ");
            eventText = await requestPlotCandidate(
                [
                    "FORMAT CORRECTION: The previous attempt resembled a performed roleplay response, a completed scene, or a meta description of an episode or scene.",
                    surpriseType === "crazy"
                        ? "Preserve only the strange underlying occurrence. Rewrite it as a direct, concrete event that begins immediately when injected. Do not make it more coherent, plausible, useful, contextual, or character-driven."
                        : "Preserve only its underlying event idea and rewrite it as the direct next plot development. Begin immediately with the behavior, condition, information, interaction, or change appropriate to the selected category instead of introducing or labeling the output.",
                    surpriseType === "crazy"
                        ? "Keep the result context-free, inexplicable, and maximally unpredictable while preserving the no-metagaming and {{user}}-agency boundaries."
                        : "Use prospective or planning language. State the category-specific development, its effect on the current situation, and the unresolved opening it creates.",
                    "Do not use framing such as 'This episode...', 'This scene...', 'The plot...', '이 에피소드는', '이 장면은', '~한 에피소드입니다', or '~한 장면입니다'.",
                    "Do not include direct dialogue, quoted speech, internal monologue, first-person narration, roleplay actions, or scene prose.",
                    `<invalid_scene_output>${eventText}</invalid_scene_output>`,
                ].join("\n")
            );
            if (!eventText || isRoleplayLikePlotCandidate(eventText)) {
                throw new Error(
                    "모델이 직접적인 플롯 형식을 따르지 않았습니다. 다시 생성해 주세요."
                );
            }
        }
        if (
            isPlotOutputLanguageMismatch(
                eventText,
                plotOutputLanguage
            )
        ) {
            status.textContent = "설정한 출력 언어로 다시 맞추고 있어요…";
            plotDiagnostic.retryReason = [plotDiagnostic.retryReason, "출력 언어 보정"].filter(Boolean).join(" · ");
            eventText = await requestPlotCandidate(
                `${getPlotOutputInstruction(plotOutputLanguage)} The previous attempt used the wrong output language. Follow this language requirement without exception.`
            );
            if (
                !eventText ||
                isPlotOutputLanguageMismatch(
                    eventText,
                    plotOutputLanguage
                ) ||
                isRoleplayLikePlotCandidate(eventText)
            ) {
                throw new Error(
                    "모델이 설정한 플롯 출력 언어 또는 직접적인 플롯 형식을 따르지 않았습니다."
                );
            }
        }

        if (isRoleplayLikePlotCandidate(eventText)) {
            throw new Error(
                "모델이 플롯 대신 롤플 장면을 반환했습니다. 다시 생성해 주세요."
            );
        }

        if (!isBoosterFeatureEnabled("plot")) {
            status.textContent =
                "플롯 부스터가 꺼져 있어 생성 결과를 적용하지 않았어요.";
            return;
        }

        const historyEntry = recordPlotHistory({
            text: eventText,
            mode,
            categoryId: category?.id || "",
            userIdea,
            surpriseType,
            chatId: taskChatId,
            updateUi: isOperationContextCurrentChat(operationContext),
        });
        if (autoInject && !isAutoApplyContextCurrent()) {
            const message = '대화나 캐릭터 기준·설정이 바뀌어 이번 플롯을 자동 적용하지 않았어요. 후보는 최근 추천에 보관했어요.';
            if (isOperationContextCurrentChat(operationContext)) {
                (getBoosterElement('rp-event-status') || status).textContent = message;
            }
            showPlotGenerationToast('info', message);
            return;
        }
        showPlotGenerationToast(
            "success",
            surpriseType === "random"
                ? "랜덤박스 플롯을 준비했어요."
                : surpriseType === "crazy"
                  ? "미친 랜덤박스 플롯을 준비했어요."
                  : surpriseType === "secret"
                    ? "비밀 플롯을 준비했어요."
                    : operation === "refine"
                ? "플롯 다듬기가 완료됐어요."
                : operation === "new_direction"
                  ? "새 플롯 방향이 완성됐어요."
                  : "플롯 생성이 완료됐어요."
        );
        if (!isOperationContextCurrentChat(operationContext)) {
            return;
        }
        if (autoInject) {
            const liveResultField =
                getBoosterElement("rp-event-result") || resultField;
            const liveResultWrap =
                getBoosterElement("rp-event-result-wrap") || resultWrap;
            liveResultField.value = eventText;
            if (historyEntry?.id) {
                liveResultField.dataset.historyId = historyEntry.id;
            }
            liveResultWrap.hidden = true;
            getPlotModeDrafts(taskChatId).free = {
                text: eventText,
                historyId: historyEntry?.id || "",
            };
            await injectEventAndGenerateReply(eventText, {
                source: surpriseType,
                isCurrent: isAutoApplyContextCurrent,
            });
            return;
        }
        getPlotModeDrafts(taskChatId)[mode] = {
            text: eventText,
            historyId: historyEntry?.id || "",
        };
        const livePopupRoot = getActiveBoosterPopupRoot();
        const liveResultField = getBoosterElement("rp-event-result") || resultField;
        const liveResultWrap = getBoosterElement("rp-event-result-wrap") || resultWrap;
        const liveStatus = getBoosterElement("rp-event-status") || status;
        if ((livePopupRoot?.dataset.plotMode || mode) === mode) {
            liveResultField.value = eventText;
            if (historyEntry?.id) {
                liveResultField.dataset.historyId = historyEntry.id;
            }
            liveResultWrap.hidden = false;
        }
        liveStatus.textContent = "";
        liveResultField.focus();
    } catch (err) {
        console.error(`[${MODULE_NAME}] event generation failed:`, err);
        recordStoryBoosterError(err, {
            task: plotDiagnostic.task,
            diagnostic: plotDiagnostic,
        });
        const liveStatus =
            isOperationContextCurrentChat(operationContext)
                ? getBoosterElement("rp-event-status") || status
                : status;
        const timedOut = err?.code === "STORYBOOSTER_REQUEST_TIMEOUT";
        liveStatus.textContent = timedOut
            ? "플롯 생성 시간 초과: 3분 안에 완료되지 않았어요. 다시 시도해 주세요."
            : `플롯 생성 실패: ${err?.message || err}`;
        showPlotGenerationToast(
            "error",
            timedOut
                ? "플롯 생성 시간이 초과됐어요. 다시 시도해 주세요."
                : "플롯을 생성하지 못했어요. 연결 상태를 확인해 주세요."
        );
    } finally {
        if (eventGenerationPendingTasks.get(taskChatId)?.id === task.id) {
            eventGenerationPendingTasks.delete(taskChatId);
        }
        updatePlotGenerationPendingUi(taskChatId);
    }
}

// @source-order 324
function clearGeneratedEventResult() {
    const resultWrap = getBoosterElement("rp-event-result-wrap");
    const resultField = getBoosterElement("rp-event-result");
    const status = getBoosterElement("rp-event-status");
    if (resultField) {
        resultField.value = "";
        delete resultField.dataset.historyId;
    }
    const mode =
        getActiveBoosterPopupRoot()?.dataset.plotMode || "free";
    if (["free", "guided"].includes(mode)) {
        getPlotModeDrafts()[mode] = { text: "", historyId: "" };
    }
    if (resultWrap) resultWrap.hidden = true;
    if (status) status.textContent = "생성 결과를 지웠습니다.";
    updatePlotHistoryUI();
}

// @source-order 325
function getGeneratedEventText() {
    return getBoosterElement("rp-event-result")?.value.trim() || "";
}

// @source-order 326
function closeBoosterPopup() {
    const popupRoot = getActiveBoosterPopupRoot();
    const popup = popupRoot?.closest(".popup, .dialogue_popup, #dialogue_popup");
    const closeButton =
        popup?.querySelector(".popup-button-ok, .popup_ok, .popup-button-close") ||
        document.getElementById("dialogue_popup_ok");

    closeButton?.click();
    return popupRoot;
}

// @source-order 327
async function waitForBoosterPopupToClose(popupRoot, timeoutMs = 1200) {
    if (!popupRoot) return;
    const startedAt = Date.now();
    while (
        popupRoot.isConnected &&
        popupRoot.getClientRects().length > 0 &&
        Date.now() - startedAt < timeoutMs
    ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

// @source-order 328
function insertEventIntoComposer() {
    if (!isBoosterFeatureEnabled("plot")) {
        toastr?.info?.("전역 설정에서 플롯 부스터를 켜 주세요.");
        return;
    }
    const eventText = getGeneratedEventText();
    if (!eventText) {
        toastr?.warning?.("먼저 사건 후보를 생성하세요.");
        return;
    }

    const composer = document.getElementById("send_textarea");
    if (!composer) {
        toastr?.error?.("채팅 입력창을 찾을 수 없습니다.");
        return;
    }

    const currentText = String(composer.value || "");
    composer.value = currentText ? `${currentText.replace(/\s+$/, "")}\n${eventText}` : eventText;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));

    closeBoosterPopup();
    setTimeout(() => composer.focus(), 100);
    toastr?.success?.("사건을 채팅 입력창에 넣었습니다.");
}

// @source-order 329
async function injectEventAndGenerateReply(eventTextOverride = "", options = {}) {
    if (options.isCurrent && !options.isCurrent()) {
        toastr?.info?.('대화나 캐릭터 기준·설정이 바뀌어 플롯 적용을 취소했어요.');
        return;
    }
    cancelAutomaticPlot();
    if (!isBoosterFeatureEnabled("plot")) {
        toastr?.info?.("전역 설정에서 플롯 부스터를 켜 주세요.");
        return;
    }
    const eventText = String(eventTextOverride || getGeneratedEventText()).trim();
    const instructionText = String(options.instructionText || "").trim();
    if (!eventText && !instructionText) {
        toastr?.warning?.("먼저 사건 후보를 생성하세요.");
        return;
    }

    const chatId = String(getCurrentChatId());
    const injectionContext = createOperationContextSnapshot({ chatId, chatSnapshot: snapshotCurrentChatMessages() });
    const context = getContext();
    if (typeof context?.generate !== "function") {
        toastr?.error?.("이 SillyTavern 버전에서는 즉시 응답 생성 API를 찾을 수 없습니다.");
        return;
    }

    try {
        if (instructionText) {
            registerOneShotRoleplayInstruction(instructionText);
        } else {
            triggerPlotEvent(eventText, options.source);
        }
    } catch (error) {
        console.error(`[${MODULE_NAME}] plot injection failed:`, error);
        recordStoryBoosterError(error, {
            task:
                options.source === "character_question"
                    ? "character_question_injection"
                    : "plot_injection",
            stage: "prompt_injection",
        });
        toastr?.error?.(
            `플롯을 주입하지 못했습니다: ${error?.message || "SillyTavern 연결 상태를 확인해 주세요."}`
        );
        return;
    }
    const injectedPrompt = runtime.currentPlotInjectionText;
    const clearOwnedPrompt = () => {
        if (runtime.currentPlotInjectionText === injectedPrompt) clearPlotPromptIfPending();
    };
    const popupRoot = closeBoosterPopup();
    toastr?.info?.(
        options.source === "character_question"
            ? "캐릭터의 질문을 현재 채팅 연결로 생성합니다."
            : "플롯을 주입하고 현재 채팅 연결로 응답 생성을 시작합니다."
    );

    // Wait for the active popup rather than a fixed delay. Some mobile themes
    // use a longer close animation and can otherwise block normal generation.
    await waitForBoosterPopupToClose(popupRoot);

    if (!isBoosterFeatureEnabled('plot') || !isOperationContextCurrentMessages(injectionContext) ||
        (options.isCurrent && !options.isCurrent()) || runtime.currentPlotInjectionText !== injectedPrompt) {
        clearOwnedPrompt();
        toastr?.warning?.(
            "대화나 캐릭터 기준·설정이 변경되어 플롯 주입과 응답 생성을 취소했습니다."
        );
        return;
    }

    let roleplayStopRequested = false;
    try {
        // This path starts generation without a user MESSAGE_SENT event, so
        // explicitly arm only corrections that were already pending now.
        // Audits that finish after generation starts remain queued for a later
        // response instead of being falsely marked as applied here.
        armPendingGenreCorrectionForNextResponse();
        await withRequestTimeout(
            context.generate("normal"),
            "AI 응답 생성이 10분 안에 완료되지 않아 중단을 요청했습니다.",
            600000,
            () => {
                roleplayStopRequested = requestCurrentRoleplayGenerationStop();
            }
        );
    } catch (err) {
        console.error(`[${MODULE_NAME}] reply generation failed:`, err);
        recordStoryBoosterError(err, {
            task:
                options.source === "character_question"
                    ? "character_question_reply_generation"
                    : "roleplay_reply_generation",
            stage: "reply_generation",
            timeoutMs: 600000,
        });
        const timedOut = err?.code === "STORYBOOSTER_REQUEST_TIMEOUT";
        toastr?.error?.(
            timedOut
                ? roleplayStopRequested
                    ? "AI 응답 생성 시간이 초과되어 중단을 요청했습니다."
                    : "AI 응답 생성 시간이 초과됐지만 자동 중단 기능을 찾지 못했습니다. SillyTavern의 정지 버튼을 확인해 주세요."
                : options.source === "character_question"
                  ? "질문 지침을 주입했지만 AI 응답 생성에 실패했습니다."
                  : "사건을 주입했지만 AI 응답 생성에 실패했습니다."
        );
    } finally {
        // MESSAGE_RECEIVED normally clears this first. The finally block also
        // covers cancellation and failed generations so no stale event remains.
        clearOwnedPrompt();
    }
}

// @source-order 330
async function generateCharacterQuestionReply() {
    if (!isBoosterFeatureEnabled("plot")) {
        toastr?.info?.("전역 설정에서 플롯 부스터를 켜 주세요.");
        return;
    }
    const chatId = String(getCurrentChatId());
    if (runtime.plotPending || eventGenerationPendingTasks.has(chatId)) {
        toastr?.info?.("현재 다른 전개를 생성하거나 적용하고 있어요.");
        return;
    }
    const { characterName } = getCurrentRoleDisplayNames();
    showPlotGenerationToast(
        "info",
        `${characterName}의 새로운 질문을 준비해요.`
    );
    await injectEventAndGenerateReply("", {
        source: "character_question",
        instructionText: buildCharacterQuestionInstruction(),
    });
}


export { requestHeadlessPlotEvent, recordPlotHistory, activatePlotGenerationMode, addCustomPlotCategory, buildCharacterQuestionInstruction, buildEventGenerationPrompt, capturePlotModeDraft, clearGeneratedEventResult, clearPlotHistory, clearPlotPromptIfPending, clearSecretPlotAction, closeBoosterPopup, createEmptyPlotModeDrafts, deleteCustomPlotCategory, deletePlotHistoryItem, extractTaggedPlotEventResult, generateCharacterQuestionReply, generateEventCandidate, getGeneratedEventText, getPlotCandidateFormatIssues, getPlotGenerateButtonLabel, getPlotHistory, getPlotHistoryModeLabel, getPlotModeDrafts, getPlotOutputInstruction, getSelectedSecretPlotAction, injectEventAndGenerateReply, insertEventIntoComposer, isPlotOutputLanguageMismatch, isPlotSecretMode, isRoleplayLikePlotCandidate, launchSecretSurprise, loadPlotHistoryItem, parsePlotEventResult, refreshPlotCategoryCards, registerOneShotRoleplayInstruction, renderPlotCategoryCards, renderPlotHistoryCards, restorePlotModeDraft, runSelectedPlotGenerationAction, selectPlotCategory, selectSecretPlotAction, setPlotSecretMode, shouldRetryPlotEventWithoutSchema, shouldRetryTaggedPlotEvent, showPlotGenerationToast, togglePlotHistoryDrawer, triggerPlotEvent, updatePlotGenerationPendingUi, updatePlotHistoryUI, updatePlotSecretModeUi, waitForBoosterPopupToClose };
