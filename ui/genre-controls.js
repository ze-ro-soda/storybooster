// StoryBooster: ui/genre-controls.js
import { GENRE_BOOST_CORRECTION_CODES, GENRE_GROUPS } from "../core/constants.js";
import { getCurrentChatId, getLatestAssistantMessageId } from "../core/context.js";
import { escapeHtml, getBoosterElement } from "../core/dom.js";
import { saveSettingsDebounced } from "../core/sillytavern.js";
import { bumpCorrectionRevision, ensureChatState, ensureGenreAnchorState, ensureModuleSettings, getAvailableGenres, isBoosterFeatureEnabled, normalizeGenreSelection, removeLiveCorrectionCodes } from "../core/storage.js";
import { updateGenreAnchorPanel } from "../core/ui-hooks.js";
import { markPendingGenreAuditCancelled, resyncLastCountedMessageId, updateGenrePrompt } from "../features/audit.js";

// @source-order 332
function renderGenreOptions(selectedId, emptyLabel) {
    const availableGenres = getAvailableGenres();
    const groups = GENRE_GROUPS.map((group) => {
        const options = availableGenres
            .filter((genre) => genre.group === group.id)
            .map(
                (genre) =>
                    `<option value="${escapeHtml(genre.id)}" ${
                        genre.id === selectedId ? "selected" : ""
                    }>${escapeHtml(`${genre.emoji} ${genre.label}`)}</option>`
            )
            .join("");

        return options
            ? `<optgroup label="${escapeHtml(group.label)}">${options}</optgroup>`
            : "";
    }).join("");

    return `<option value="" ${selectedId ? "" : "selected"}>${escapeHtml(
        emptyLabel
    )}</option>${groups}`;
}

// @source-order 333
function renderCustomGenreList() {
    const list = getBoosterElement("rp-custom-genre-list");
    if (!list) return;

    const customGenres = ensureModuleSettings().customGenres;
    if (customGenres.length === 0) {
        list.innerHTML = '<p class="rp-custom-empty">아직 추가한 장르가 없습니다.</p>';
        return;
    }

    list.innerHTML = customGenres
        .map(
            (genre) => `
            <div class="rp-custom-genre-item">
                <div>
                    <strong>✨ ${escapeHtml(genre.label)}</strong>
                    ${
                        genre.description
                            ? `<small>${escapeHtml(genre.description)}</small>`
                            : '<small>별도 방향 설명 없음</small>'
                    }
                </div>
                <button type="button" class="menu_button rp-custom-genre-delete" data-id="${escapeHtml(
                    genre.id
                )}" aria-label="${escapeHtml(genre.label)} 삭제">삭제</button>
            </div>`
        )
        .join("");
}

// @source-order 334
function populateGenreSelectionControls() {
    const state = ensureChatState();
    const selection = normalizeGenreSelection(state);
    const primarySelect = getBoosterElement("rp-primary-genre");
    const supportSelect = getBoosterElement("rp-support-genre");

    if (!primarySelect || !supportSelect) return;

    primarySelect.innerHTML = renderGenreOptions(selection.primaryId, "사용하지 않음");
    supportSelect.innerHTML = renderGenreOptions(selection.supportIds[0] || null, "없음");
    const featureEnabled = isBoosterFeatureEnabled("genre");
    primarySelect.disabled = !featureEnabled;
    supportSelect.disabled = !featureEnabled;
}

// @source-order 335
function syncGenreSelectionFromControls() {
    const primarySelect = getBoosterElement("rp-primary-genre");
    const supportSelect = getBoosterElement("rp-support-genre");
    if (!primarySelect || !supportSelect) return;

    const primaryId = primarySelect.value || null;
    const supportId =
        supportSelect.value && supportSelect.value !== primaryId
            ? supportSelect.value
            : null;

    const state = ensureChatState();
    state.genreSelection = { primaryId, supportIds: supportId ? [supportId] : [] };
    state.genreAnchor.responseCount = 0;
    markPendingGenreAuditCancelled(state);
    state.genreAnchor.correctionCodes = [];
    state.genreAnchor.correctionText = "";
    state.genreAnchor.correctionFieldIds = [];
    state.genreAnchor.correctionRemaining = 0;
    state.genreAnchor.correctionAppliedMessageId = null;
    state.genreAnchor.correctionArmedRevision = 0;
    state.genreAnchor.auditStatus = "waiting";
    state.genreAnchor.recommendation = null;
    state.genreAnchor.lastCountedMessageId = getLatestAssistantMessageId();

    populateGenreSelectionControls();
    saveSettingsDebounced();
    updateGenrePrompt();
    updateGenreAnchorPanel();
}

// @source-order 336
function addCustomGenre() {
    const nameInput = getBoosterElement("rp-custom-genre-name");
    const descriptionInput = getBoosterElement("rp-custom-genre-description");
    const status = getBoosterElement("rp-custom-genre-status");
    if (!nameInput || !descriptionInput || !status) return;

    const label = nameInput.value.trim().slice(0, 50);
    const description = descriptionInput.value.trim().slice(0, 500);
    if (!label) {
        status.textContent = "장르 이름을 입력해 주세요.";
        nameInput.focus();
        return;
    }

    const settings = ensureModuleSettings();
    const duplicate = getAvailableGenres().some(
        (genre) => genre.label.toLocaleLowerCase() === label.toLocaleLowerCase()
    );
    if (duplicate) {
        status.textContent = "같은 이름의 장르가 이미 있습니다.";
        return;
    }

    settings.customGenres.push({
        id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        label,
        emoji: "✨",
        group: "custom",
        description,
    });

    nameInput.value = "";
    descriptionInput.value = "";
    status.textContent = `“${label}” 장르를 추가했습니다.`;
    populateGenreSelectionControls();
    renderCustomGenreList();
    saveSettingsDebounced();
}

// @source-order 337
function deleteCustomGenre(genreId) {
    const settings = ensureModuleSettings();
    const genre = settings.customGenres.find((item) => item.id === genreId);
    if (!genre) return;
    if (!window.confirm(`“${genre.label}” 장르를 목록에서 삭제할까요?`)) return;

    const affectedChats = [];
    for (const [chatId, state] of Object.entries(settings.chats)) {
        if (!state || typeof state !== "object") continue;
        const selection = normalizeGenreSelection(state);
        const usedAsPrimary = selection.primaryId === genreId;
        const usedAsSupport = selection.supportIds.includes(genreId);
        const recommendationUsesGenre =
            state.genreAnchor?.recommendation?.primaryId === genreId ||
            state.genreAnchor?.recommendation?.supportId === genreId;
        if (usedAsPrimary || usedAsSupport || recommendationUsesGenre) {
            affectedChats.push({
                chatId,
                state,
                usedAsPrimary,
                usedAsSupport,
                recommendationUsesGenre,
            });
        }
    }

    settings.customGenres = settings.customGenres.filter((item) => item.id !== genreId);
    for (const affected of affectedChats) {
        const {
            chatId,
            state,
            usedAsPrimary,
            usedAsSupport,
            recommendationUsesGenre,
        } = affected;
        const anchor = ensureGenreAnchorState(state);
        if (recommendationUsesGenre) anchor.recommendation = null;
        if (!usedAsPrimary && !usedAsSupport) continue;

        state.genreSelection = usedAsPrimary
            ? { primaryId: null, supportIds: [] }
            : {
                  primaryId: state.genreSelection.primaryId,
                  supportIds: [],
              };
        anchor.responseCount = 0;
        const queueChanged = removeLiveCorrectionCodes(
            anchor,
            usedAsPrimary
                ? GENRE_BOOST_CORRECTION_CODES
                : new Set(["support_texture"]),
            { emptyStatus: "waiting" }
        );
        if (!queueChanged) {
            if (!anchor.correctionCodes.length) anchor.auditStatus = "waiting";
            bumpCorrectionRevision(anchor);
        }
        anchor.lastCountedMessageId =
            chatId === getCurrentChatId()
                ? getLatestAssistantMessageId()
                : null;
    }

    populateGenreSelectionControls();
    renderCustomGenreList();
    saveSettingsDebounced();
    updateGenrePrompt();
    updateGenreAnchorPanel();
    resyncLastCountedMessageId();
}

export { addCustomGenre, deleteCustomGenre, populateGenreSelectionControls, renderCustomGenreList, renderGenreOptions, syncGenreSelectionFromControls };
