import { auditAnalysisLabel, auditComparisonText } from '../core/audit-history.js';
import { getJevConnectionBadge, getJevConnectionStatus, hasJevSessionKey } from '../core/jev-client.js';
import { cancelAutomaticPlot } from '../core/automatic-plot-state.js';
// StoryBooster: ui/panels.js
import { CHARACTER_AUDIT_DISPLAY_ITEMS, CHARACTER_BASELINE_FIELDS, CHARACTER_BASELINE_FIELD_MAX_CHARS, CHARACTER_BOOST_CORRECTION_CODES, CHARACTER_REVISION_ASSISTANT_REPLIES, GENRE_AUDIT_DISPLAY_ITEMS, GENRE_BOOST_CORRECTION_CODES, GENRE_CORRECTION_DESCRIPTIONS, GENRE_CORRECTION_LABELS, MAX_AUDIT_INTERVAL, MAX_CHARACTER_BASELINE_VERSIONS, MIN_AUDIT_INTERVAL, MODULE_NAME } from "../core/constants.js";
import { getCurrentChatId, getCurrentRoleDisplayNames, getLatestAssistantMessageId, resolveRoleMacrosForDisplay } from "../core/context.js";
import { recordStoryBoosterError } from "../core/diagnostics.js";
import { escapeHtml, getActiveBoosterPopupRoot, getBoosterElement, getBoosterElements } from "../core/dom.js";
import { characterBaselinePendingTasks, characterBaselineRevisionProposals, genreAuditPendingChats } from "../core/runtime.js";
import { saveSettingsDebounced } from "../core/sillytavern.js";
import { ensureChatState, ensureGenreAnchorState, ensureModuleSettings, formatSavedAt, getCharacterAnchorDisplayValue, getCharacterBaselineVersionOptions, getCharacterBoosterReadiness, getCharacterCardChangeStatus, getCurrentCharacterBaseline, getGlobalAuditInterval, hasCharacterDisplayLanguageMismatch, isBoosterFeatureEnabled, removeLiveCorrectionCodes } from "../core/storage.js";
import { canQueueManualAuditBoost, getGenreAnchorSelection, updateGenrePrompt } from "../features/audit.js";
import { ensureCharacterRevisionReview, getCharacterBaselineFieldDefinition, getCharacterRevisionProposalKey } from "../features/character.js";
import { getGenreProfile } from "../features/genre-model.js";
import { clearPlotPromptIfPending, updatePlotGenerationPendingUi } from "../features/plot.js";
import { renderGenreRecommendation } from "../features/recommendation.js";
import { populateGenreSelectionControls } from "./genre-controls.js";

export function updateJevConnectionBadges() {
    const settings = document.getElementById('rp-storybooster-settings');
    const status = settings?.querySelector('#rp-jev-status');
    if (status) status.textContent = getJevConnectionStatus();
    const keyInput = settings?.querySelector('#rp-jev-key');
    if (keyInput) keyInput.placeholder = hasJevSessionKey() ? '키 저장됨 · 변경할 키만 입력' : '키 입력';
    const badge = getJevConnectionBadge(ensureModuleSettings().jevEnabled);
    for (const id of ['rp-genre-jev-status', 'rp-character-jev-status']) {
        const el = getBoosterElement(id);
        if (!el) continue;
        el.hidden = badge.hidden;
        el.className = `rp-booster-live-status rp-jev-badge is-${badge.state}`;
        const label = el.querySelector('.rp-booster-live-status-text');
        if (label) label.textContent = badge.text;
    }
}

// @source-order 202
function safelyUpdateGenreAnchorPanel(contextLabel = "UI 갱신") {
    try {
        updateGenreAnchorPanel();
        return true;
    } catch (error) {
        console.error(
            `[${MODULE_NAME}] booster panel refresh failed (${contextLabel}):`,
            error
        );
        recordStoryBoosterError(error, {
            task: "booster_panel_refresh",
            stage: "ui_refresh",
        });
        return false;
    }
}

// @source-order 203
function safelyUpdateCharacterBoosterPanel(contextLabel = "UI 갱신") {
    try {
        updateCharacterBoosterPanel();
        return true;
    } catch (error) {
        console.error(
            `[${MODULE_NAME}] character panel refresh failed (${contextLabel}):`,
            error
        );
        recordStoryBoosterError(error, {
            task: "character_panel_refresh",
            stage: "ui_refresh",
        });
        return false;
    }
}

// @source-order 341
function getGenreAuditDisplayStatus(audit, code) {
    if (audit.uncertain?.includes(code)) return { text: '판단 보류', className: 'is-off' };
    if (code === "repetition") {
        switch (audit.ratings.repetition) {
            case "weak":
                return { text: "반복 감지", className: "is-weak" };
            case "attention":
                return { text: "주의", className: "is-attention" };
            case "stable":
                return { text: "안정", className: "is-stable" };
            default:
                return { text: "미사용", className: "is-off" };
        }
    }
    const rating = audit.ratings[code];
    if (code === "character_consistency") {
        if (rating === "drifted") return { text: "이탈", className: "is-weak" };
        if (rating === "attention") return { text: "주의", className: "is-attention" };
        if (["unavailable", "na"].includes(rating)) {
            return { text: rating === "unavailable" ? "판단 보류" : "미사용", className: "is-off" };
        }
        return { text: "안정", className: "is-stable" };
    }
    if (code === "character_interpretation") {
        if (rating === "biased") return { text: "편향", className: "is-weak" };
        if (rating === "attention") return { text: "주의", className: "is-attention" };
        if (["unavailable", "na"].includes(rating)) {
            return { text: rating === "unavailable" ? "판단 보류" : "미사용", className: "is-off" };
        }
        return { text: "안정", className: "is-stable" };
    }
    if (code === "support_texture") {
        switch (rating) {
            case "attention": return { text: "주의", className: "is-attention" };
            case "present":
                return { text: "활성", className: "is-stable" };
            case "dormant":
                return { text: "대기", className: "is-dormant" };
            case "weak":
                return { text: "약화", className: "is-weak" };
            default:
                return { text: "미사용", className: "is-off" };
        }
    }
    if (rating === "na") return { text: "미사용", className: "is-off" };
    if (rating === "attention") return { text: "주의", className: "is-attention" };
    return rating === "weak"
        ? { text: "약화", className: "is-weak" }
        : { text: "안정", className: "is-stable" };
}

// @source-order 342
function getAuditRecordForScope(state, scope) {
    return scope === "character"
        ? state.genreAnchor.lastCharacterAudit
        : state.genreAnchor.lastGenreAudit;
}

// @source-order 343
function getAuditDetailPanel(scope) {
    return getBoosterElement(
        scope === "character"
            ? "rp-character-audit-detail"
            : "rp-genre-audit-detail"
    );
}

// @source-order 344
function renderAuditDetailPanel(panel, audit, item, state) {
    if (!panel) return;
    panel.replaceChildren();
    if (!audit?.ratings || !item) {
        panel.hidden = true;
        return;
    }

    const status = getGenreAuditDisplayStatus(audit, item.code);
    const heading = document.createElement("div");
    heading.className = "rp-audit-detail-heading";
    const title = document.createElement("strong");
    title.textContent = item.label;
    const chip = document.createElement("span");
    chip.className = `rp-audit-status-chip ${status.className}`;
    chip.textContent = status.text;
    heading.append(title, chip);

    const reason = document.createElement("p");
    reason.className = "rp-audit-detail-reason";
    reason.textContent =
        String(audit.reasons?.[item.code] || "").trim() ||
        "이전 버전의 진단에는 상세 사유가 저장되어 있지 않아요.";

    const action = document.createElement("button");
    action.type = "button";
    action.className = "menu_button rp-audit-manual-boost";
    action.dataset.auditCode = item.code;
    action.dataset.auditScope = GENRE_BOOST_CORRECTION_CODES.has(item.code)
        ? "genre"
        : "character";
    const queued =
        state.genreAnchor.correctionRemaining > 0 &&
        state.genreAnchor.correctionAppliedMessageId === null &&
        state.genreAnchor.correctionCodes.includes(item.code);
    const applied =
        state.genreAnchor.correctionAppliedMessageId !== null &&
        state.genreAnchor.correctionCodes.includes(item.code);
    action.textContent = applied
        ? "이번 응답에 보강 적용됨"
        : queued
          ? "보강 대기 중 · 선택 해제"
          : "다음 응답 1회 보강";
    action.disabled = applied || !canQueueManualAuditBoost(item.code);

    const help = document.createElement("small");
    help.className = "rp-audit-detail-help";
    help.textContent = action.disabled && !applied
        ? "현재 부스터 설정에서는 이 항목을 수동 보강할 수 없어요."
        : "다음 캐릭터 응답 한 번에만 적용되며 상시 부스팅 설정은 바뀌지 않아요.";

    const comparison = document.createElement('p');
    comparison.className = 'rp-audit-comparison';
    comparison.textContent = auditComparisonText(audit, item.code);
    comparison.hidden = !comparison.textContent;
    const deferredHelp = document.createElement('small');
    deferredHelp.className = 'rp-audit-detail-help';
    deferredHelp.textContent = '판단 보류는 이 항목의 추가 보정을 준비하지 않았다는 뜻이며, 기존 부스팅을 끄지 않아요.';
    deferredHelp.hidden = !(audit.uncertain?.includes(item.code));
    panel.append(heading, reason, comparison, deferredHelp, action, help);
    panel.hidden = false;
}

// @source-order 345
function renderAuditStatusGrid(grid, audit, items, scope) {
    if (!grid) return;
    grid.replaceChildren();
    const detailPanel = getAuditDetailPanel(scope);
    const selectedCode = String(detailPanel?.dataset.selectedCode || "");
    if (audit?.ratings) {
        items.forEach((item) => {
            const status = getGenreAuditDisplayStatus(audit, item.code);
            const displayTitle =
                scope === "character" && item.code === "relationship"
                    ? (() => {
                          const { characterName, userName } =
                              getCurrentRoleDisplayNames();
                          return `${characterName}-${userName} 관계 반응`;
                      })()
                    : item.title;
            const row = document.createElement("button");
            row.type = "button";
            row.className = "rp-audit-status-item";
            row.title = displayTitle;
            row.dataset.auditScope = scope;
            row.dataset.auditCode = item.code;
            row.setAttribute("aria-expanded", selectedCode === item.code ? "true" : "false");
            const label = document.createElement("span");
            label.className = "rp-audit-status-label";
            label.textContent = item.label;
            const chip = document.createElement("span");
            chip.className = `rp-audit-status-chip ${status.className}`;
            chip.textContent = status.text;
            row.append(label, chip);
            grid.append(row);
        });
    }
    grid.hidden = !audit?.ratings;
    const selectedItem = items.find((item) => item.code === selectedCode);
    renderAuditDetailPanel(detailPanel, audit, selectedItem, ensureChatState());
}

// @source-order 346
function selectAuditDetail(scope, code) {
    const state = ensureChatState();
    const audit = getAuditRecordForScope(state, scope);
    const items = scope === "character"
        ? CHARACTER_AUDIT_DISPLAY_ITEMS
        : GENRE_AUDIT_DISPLAY_ITEMS;
    const item = items.find((candidate) => candidate.code === code);
    const panel = getAuditDetailPanel(scope);
    if (!panel || !audit || !item) return;
    panel.dataset.selectedCode = code;
    renderAuditDetailPanel(panel, audit, item, state);
    const grid = getBoosterElement(
        scope === "character"
            ? "rp-character-last-audit-grid"
            : "rp-last-audit-grid"
    );
    grid?.querySelectorAll(".rp-audit-status-item").forEach((button) => {
        button.setAttribute(
            "aria-expanded",
            button.dataset.auditCode === code ? "true" : "false"
        );
    });
}

// @source-order 347
function getGenreAuditResultStatusText(audit, state = null, items = []) {
    const itemCodes = new Set(items.map((item) => item.code));
    const relevantCodes = state?.genreAnchor?.correctionCodes?.filter((code) =>
        itemCodes.has(code)
    ) || [];
    if (relevantCodes.length && state.genreAnchor.correctionAppliedMessageId !== null) {
        return "이번 응답에 1회 보강 적용 완료";
    }
    if (relevantCodes.length && state.genreAnchor.correctionRemaining > 0) {
        return "다음 응답에 1회 보강 대기";
    }
    const auditRelevantCodes = (audit?.correctionCodes || []).filter((code) =>
        itemCodes.has(code)
    );
    if (audit?.ratings && itemCodes.size && !auditRelevantCodes.length) {
        const scopedRatings = items.filter(item => !(audit.uncertain?.includes(item.code))).map((item) => audit?.ratings?.[item.code]);
        if (scopedRatings.some((rating) => ["weak", "drifted", "biased"].includes(rating))) {
            return "약화 항목 있음 · 상세 결과 확인";
        }
        if (scopedRatings.includes("attention")) {
            return "주의 항목 있음 · 상세 결과 확인";
        }
        if (audit.uncertain?.some(code => itemCodes.has(code))) return "판단 보류 항목 있음 · 상세 결과 확인";
        return "추가 보정이 필요하지 않음";
    }
    switch (audit?.status) {
        case "pending":
            return "다음 응답에 보정 적용 대기";
        case "applied":
            return Number.isSafeInteger(audit.appliedMessageId)
                ? `메시지 #${audit.appliedMessageId}에 보정 적용 완료`
                : "보정 적용 완료";
        case "cancelled":
            return "이번 진단 보정은 적용하지 않음";
        case "stable":
            return "추가 보정이 필요하지 않음";
        case "attention":
            return "주의 항목 있음 · 상세 결과 확인";
        case "deferred":
            return "판단 보류 항목 있음 · 상세 결과 확인";
        case "error":
            return "진단 실패 · 부스팅은 유지";
        default:
            return "";
    }
}

// @source-order 348
function renderLastGenreAudit(state) {
    const details = getBoosterElement("rp-last-audit");
    if (!details) return;
    const audit = state.genreAnchor.lastGenreAudit;
    if (!audit) {
        details.hidden = true;
        return;
    }

    details.hidden = false;
    const meta = getBoosterElement("rp-last-audit-meta");
    const genres = getBoosterElement("rp-last-audit-genres");
    const statusGrid = getBoosterElement("rp-last-audit-grid");
    const correction = getBoosterElement("rp-last-audit-correction");
    const connection = getBoosterElement("rp-last-audit-connection");
    const resultStatus = getBoosterElement("rp-last-audit-status");
    const cancelButton = getBoosterElement("rp-cancel-audit-correction");

    if (meta) {
        const date = new Date(audit.createdAt);
        const timeText = Number.isNaN(date.getTime())
            ? ""
            : date.toLocaleString("ko-KR", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
              });
        meta.textContent = `${audit.mode === "manual" ? "수동" : "자동"} 진단${
            timeText ? ` · ${timeText}` : ""
        }${auditAnalysisLabel(audit) ? `\n${auditAnalysisLabel(audit)}` : ''}`;
    }
    if (genres) {
        genres.textContent = audit.supportLabel
            ? `진단 장르: ${audit.primaryLabel} + ${audit.supportLabel}`
            : `진단 장르: ${audit.primaryLabel || "기록 없음"}`;
    }
    if (statusGrid) {
        renderAuditStatusGrid(
            statusGrid,
            audit,
            GENRE_AUDIT_DISPLAY_ITEMS,
            "genre"
        );
    }
    if (correction) {
        const liveCodes = state.genreAnchor.correctionCodes.filter((code) =>
            GENRE_AUDIT_DISPLAY_ITEMS.some((item) => item.code === code)
        );
        const hasLiveCorrection = liveCodes.length &&
            (state.genreAnchor.correctionRemaining > 0 || state.genreAnchor.correctionAppliedMessageId !== null);
        const isApplied = hasLiveCorrection
            ? state.genreAnchor.correctionAppliedMessageId !== null
            : audit.status === 'applied';
        const displayCodes = hasLiveCorrection
                ? liveCodes
                : ["pending", "applied"].includes(audit.status)
                  ? audit.correctionCodes
                  : [];
        const descriptions = displayCodes
            .filter((code) =>
                GENRE_AUDIT_DISPLAY_ITEMS.some((item) => item.code === code)
            )
            .map((code) => audit.correctionSummaries?.[code] || GENRE_CORRECTION_DESCRIPTIONS[code]);
        correction.textContent = descriptions.length
            ? `${isApplied ? "적용한 보정" : "다음 보정"}: ${descriptions.join(" · ")}`
            : "다음 보정: 없음";
        correction.hidden = audit.status === "error";
    }
    if (connection) {
        const modelText = audit.connection?.model
            ? ` · ${audit.connection.model}`
            : "";
        connection.textContent = `진단 연결: ${
            (audit.jevFallback ? "Jev 실패 → " : "") + (audit.connection?.profileName || "현재 채팅 연결")
        }${modelText}`;
    }
    if (resultStatus) {
        resultStatus.textContent = `상태: ${getGenreAuditResultStatusText(
            audit,
            state,
            GENRE_AUDIT_DISPLAY_ITEMS
        )}${
            ["error", "cancelled"].includes(audit.status) && audit.errorMessage
                ? ` · ${audit.errorMessage}`
                : ""
        }`;
    }
    if (cancelButton) {
        const canCancel =
            state.genreAnchor.correctionCodes.some((code) =>
                GENRE_AUDIT_DISPLAY_ITEMS.some((item) => item.code === code)
            ) &&
            state.genreAnchor.correctionRemaining > 0 &&
            state.genreAnchor.correctionAppliedMessageId === null;
        cancelButton.hidden = !canCancel;
        cancelButton.disabled = !canCancel;
        cancelButton.title = "";
    }
}

// @source-order 349
function renderLastCharacterAudit(state) {
    const details = getBoosterElement("rp-character-last-audit");
    if (!details) return;
    const audit = state.genreAnchor.lastCharacterAudit;
    if (!audit) {
        details.hidden = true;
        return;
    }
    details.hidden = false;
    const meta = getBoosterElement("rp-character-last-audit-meta");
    const grid = getBoosterElement("rp-character-last-audit-grid");
    const correction = getBoosterElement("rp-character-last-audit-correction");
    const connection = getBoosterElement("rp-character-last-audit-connection");
    const resultStatus = getBoosterElement("rp-character-last-audit-status");
    const cancelButton = getBoosterElement("rp-character-cancel-correction");
    if (meta) {
        const date = new Date(audit.createdAt);
        const timeText = Number.isNaN(date.getTime())
            ? ""
            : date.toLocaleString("ko-KR", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
              });
        meta.textContent = `${audit.mode === "manual" ? "수동" : "자동"} 진단${
            timeText ? ` · ${timeText}` : ""
        }${auditAnalysisLabel(audit) ? `\n${auditAnalysisLabel(audit)}` : ''}`;
    }
    renderAuditStatusGrid(
        grid,
        audit,
        CHARACTER_AUDIT_DISPLAY_ITEMS,
        "character"
    );
    if (correction) {
        const liveCodes = state.genreAnchor.correctionCodes.filter((code) =>
            CHARACTER_AUDIT_DISPLAY_ITEMS.some((item) => item.code === code)
        );
        const hasLiveCorrection = liveCodes.length &&
            (state.genreAnchor.correctionRemaining > 0 || state.genreAnchor.correctionAppliedMessageId !== null);
        const isApplied = hasLiveCorrection
            ? state.genreAnchor.correctionAppliedMessageId !== null
            : audit.status === 'applied';
        const displayCodes = hasLiveCorrection
                ? liveCodes
                : ["pending", "applied"].includes(audit.status)
                  ? audit.correctionCodes
                  : [];
        const descriptions = displayCodes
            .filter((code) =>
                CHARACTER_AUDIT_DISPLAY_ITEMS.some((item) => item.code === code)
            )
            .map((code) => audit.correctionSummaries?.[code] || GENRE_CORRECTION_DESCRIPTIONS[code]);
        correction.textContent = descriptions.length
            ? `${isApplied ? "적용한 보정" : "다음 보정"}: ${descriptions.join(" · ")}`
            : "다음 보정: 없음";
        correction.hidden = audit.status === "error";
    }
    if (connection) {
        connection.textContent = `진단 연결: ${
            (audit.jevFallback ? "Jev 실패 → " : "") + (audit.connection?.profileName || "현재 채팅 연결")
        }${audit.connection?.model ? ` · ${audit.connection.model}` : ""}`;
    }
    if (resultStatus) {
        resultStatus.textContent = `상태: ${getGenreAuditResultStatusText(
            audit,
            state,
            CHARACTER_AUDIT_DISPLAY_ITEMS
        )}${
            ["error", "cancelled"].includes(audit.status) && audit.errorMessage
                ? ` · ${audit.errorMessage}`
                : ""
        }`;
    }
    if (cancelButton) {
        const canCancel =
            state.genreAnchor.correctionCodes.some((code) =>
                CHARACTER_AUDIT_DISPLAY_ITEMS.some((item) => item.code === code)
            ) &&
            state.genreAnchor.correctionRemaining > 0 &&
            state.genreAnchor.correctionAppliedMessageId === null;
        cancelButton.hidden = !canCancel;
        cancelButton.disabled = !canCancel;
    }
}

// @source-order 350
function renderCharacterBaselineFields(
    baseline,
    identity = null,
    chatId = getCurrentChatId(),
    versionId = ""
) {
    const identityAttributes = identity?.key
        ? `data-identity-key="${escapeHtml(identity.key)}" data-character-name="${escapeHtml(identity.name || "")}" data-source-hash="${escapeHtml(identity.sourceHash || "")}" data-chat-id="${escapeHtml(chatId)}" data-baseline-version-id="${escapeHtml(versionId)}"`
        : "";
    return CHARACTER_BASELINE_FIELDS.map((definition) => {
        const field = baseline?.fields?.[definition.id] || {
            text: "",
            pinned: false,
            source: "ai",
        };
        const hasText = Boolean(String(field.text || "").trim());
        const displayText = resolveRoleMacrosForDisplay(field.text || "");
        return `
            <article class="rp-character-field-card" data-field-id="${definition.id}">
                <div class="rp-character-field-header">
                    <label for="rp-character-field-${definition.id}">${definition.label}</label>
                    <div class="rp-character-field-tools" aria-label="${definition.label} 항목 도구">
                        <button
                            type="button"
                            class="rp-character-tool-button rp-character-pin-button ${field.pinned ? "is-active" : ""}"
                            data-field-id="${definition.id}"
                            aria-pressed="${field.pinned ? "true" : "false"}"
                            aria-label="${definition.label} 고정"
                            title="전체 다시 요약할 때 이 항목 유지"
                            ${hasText ? "" : "disabled"}
                        >📌</button>
                        <button
                            type="button"
                            class="rp-character-tool-button rp-character-edit-button"
                            data-field-id="${definition.id}"
                            aria-label="${definition.label} 직접 편집"
                            title="직접 편집"
                        >✏️</button>
                        <button
                            type="button"
                            class="rp-character-tool-button rp-character-regenerate-button"
                            data-field-id="${definition.id}"
                            aria-label="${definition.label} 다시 생성"
                            title="이 항목만 다시 생성"
                        >↻</button>
                    </div>
                </div>
                <textarea
                    id="rp-character-field-${definition.id}"
                    class="rp-character-field-text"
                    data-field-id="${definition.id}"
                    data-original-text="${escapeHtml(field.text || "")}"
                    data-original-display-text="${escapeHtml(displayText)}"
                    ${identityAttributes}
                    rows="3"
                    maxlength="${CHARACTER_BASELINE_FIELD_MAX_CHARS}"
                    placeholder="직접 입력하거나 ↻ 버튼으로 이 항목만 생성할 수 있어요."
                    readonly
                >${escapeHtml(displayText)}</textarea>
                <small class="rp-character-field-save-status" data-field-id="${definition.id}">${
                    hasText
                        ? field.source === "user"
                            ? "직접 수정 · 저장됨"
                            : "AI 요약 · 저장됨"
                        : "비어 있음"
                }</small>
            </article>`;
    }).join("");
}

// @source-order 351
function renderCharacterBaselineVersionOptions(baselineState) {
    if (!baselineState?.identity) {
        return '<option value="">원본</option>';
    }
    const options = [
        { id: "", label: "원본" },
        ...getCharacterBaselineVersionOptions(baselineState.identity.key).map(
            (record) => ({ id: record.id, label: record.label })
        ),
    ];
    return options
        .map(
            (option) =>
                `<option value="${escapeHtml(option.id)}" ${
                    option.id === String(baselineState.versionId || "")
                        ? "selected"
                        : ""
                }>${escapeHtml(option.label)}</option>`
        )
        .join("");
}

// @source-order 352
function renderCharacterBaselineRevisionProposal(
    baselineState,
    chatId = getCurrentChatId()
) {
    const identityKey = baselineState?.identity?.key || "";
    const proposal = identityKey
        ? characterBaselineRevisionProposals.get(
              getCharacterRevisionProposalKey(identityKey, chatId)
          )
        : null;
    if (!proposal) return "";
    const reviewFields = ensureCharacterRevisionReview(proposal);
    const modeLabel =
        proposal.mode === "automatic" ? "자동 탐색" : "요청 기반";
    const evidenceLabel =
        proposal.evidenceLevel === "strong"
            ? "최근 롤플 근거 충분"
            : proposal.evidenceLevel === "partial"
              ? "최근 롤플 일부 참고"
              : "최근 롤플 근거 적음";
    const maintainedFields = CHARACTER_BASELINE_FIELDS.filter(
        (definition) => !proposal.changedFields.includes(definition.id)
    )
        .map((definition) => definition.label)
        .join(", ");
    const fieldCards = proposal.changedFields
        .map((fieldId) => {
            const definition = getCharacterBaselineFieldDefinition(fieldId);
            const currentText = String(
                baselineState.baseline?.fields?.[fieldId]?.text || ""
            );
            const proposed = proposal.fields[fieldId];
            const review = reviewFields[fieldId];
            const pinned = Boolean(baselineState.baseline?.fields?.[fieldId]?.pinned);
            return `
                <article class="rp-character-revision-field-card">
                    <label class="rp-character-revision-choice">
                        <input class="rp-character-revision-include" data-field-id="${fieldId}" type="checkbox" ${review.included && !pinned ? "checked" : ""} ${pinned ? "disabled" : ""}>
                        <span>${escapeHtml(definition?.label || fieldId)} ${pinned ? "📌 고정 · 현재 내용 유지" : "반영"}</span>
                    </label>
                    <small class="rp-character-revision-reason">${escapeHtml(
                        resolveRoleMacrosForDisplay(proposed.reason ||
                            (proposal.mode === "automatic"
                                ? "롤플에서 지속적인 변화가 확인됨"
                                : "요청한 변화 방향을 현재 기준에 맞춰 반영함"))
                    )}</small>
                    <details>
                        <summary>현재 내용 보기</summary>
                        <p>${escapeHtml(resolveRoleMacrosForDisplay(currentText))}</p>
                    </details>
                    <textarea class="rp-character-revision-field" data-field-id="${fieldId}" rows="4" maxlength="${CHARACTER_BASELINE_FIELD_MAX_CHARS}" ${pinned ? "readonly" : ""}>${escapeHtml(
                        review.text
                    )}</textarea>
                </article>`;
        })
        .join("");
    return `
        <div class="rp-character-revision-proposal" data-proposal-key="${escapeHtml(getCharacterRevisionProposalKey(identityKey, chatId))}" data-proposal-created-at="${proposal.createdAt}">
            <div class="rp-character-revision-proposal-header">
                <strong>AI 갱신안</strong>
                <small>기준: ${escapeHtml(proposal.baseVersionLabel || "원본")}</small>
            </div>
            <div class="rp-character-revision-summary">
                <span>${escapeHtml(modeLabel)}</span>
                <span>${escapeHtml(evidenceLabel)}</span>
                <span>최근 AI 답변 최대 ${Number(proposal.analyzedAssistantReplies) || CHARACTER_REVISION_ASSISTANT_REPLIES}개 + 직전 유저 입력</span>
            </div>
            ${
                proposal.evidenceSummary
                    ? `<p class="rp-character-revision-evidence">${escapeHtml(
                          proposal.evidenceSummary
                      )}</p>`
                    : ""
            }
            <p class="rp-character-revision-maintained"><strong>유지된 항목:</strong> ${escapeHtml(
                maintainedFields || "없음"
            )}</p>
            <p>반영할 항목만 체크하고 문구를 직접 다듬은 뒤 새 버전으로 저장하세요.</p>
            <div class="rp-character-revision-fields">${fieldCards}</div>
            <div class="rp-character-revision-actions">
                <button id="rp-character-revision-apply" type="button" class="rp-character-wide-button">선택 항목으로 새 버전 저장</button>
                <button id="rp-character-revision-cancel" type="button" class="rp-character-wide-button">취소</button>
            </div>
        </div>`;
}

// @source-order 353
function hasOpenCharacterBaselineEditor() {
    return Boolean(
        getActiveBoosterPopupRoot()?.querySelector(
            ".rp-character-field-text:not([readonly])"
        )
    );
}

// @source-order 354
function updateCharacterBaselineActionStates() {
    const baselineState = getCurrentCharacterBaseline();
    const featureEnabled = isBoosterFeatureEnabled("character");
    const task = baselineState.identity
        ? characterBaselinePendingTasks.get(baselineState.identity.key)
        : null;
    const pending = Boolean(task);
    const editing = hasOpenCharacterBaselineEditor();
    const baseline = baselineState.baseline;
    const allPinned = Boolean(
        baseline &&
            CHARACTER_BASELINE_FIELDS.every(
                (definition) => baseline.fields[definition.id]?.pinned
            )
    );
    const atVersionLimit = Boolean(
        baselineState.identity &&
            baselineState.isOriginal &&
            getCharacterBaselineVersionOptions(baselineState.identity.key)
                .length >= MAX_CHARACTER_BASELINE_VERSIONS
    );
    const generate = getBoosterElement("rp-character-baseline-generate");
    const remove = getBoosterElement("rp-character-baseline-delete");
    if (generate) {
        generate.disabled =
            !featureEnabled ||
            !baselineState.identity ||
            pending ||
            editing ||
            allPinned ||
            atVersionLimit;
        generate.textContent = pending
            ? task === "all"
                ? "전체 요약 중…"
                : task === "anchor"
                  ? "상시 앵커 생성 중…"
                  : task === "revision"
                    ? "AI 갱신안 분석 중…"
                    : task === "revision-apply"
                      ? "새 버전 저장 중…"
                  : `${getCharacterBaselineFieldDefinition(task)?.label || "항목"} 생성 중…`
            : baseline
              ? "전체 다시 요약"
              : "전체 요약하기";
    }
    if (remove) {
        remove.disabled =
            !featureEnabled ||
            !baseline ||
            baselineState.isOriginal ||
            pending ||
            editing;
        remove.textContent = baselineState.isOriginal
            ? "원본은 삭제할 수 없음"
            : "선택 버전 삭제";
    }
    const versionSelect = getBoosterElement("rp-character-baseline-version");
    const renameVersion = getBoosterElement("rp-character-version-rename");
    const deleteVersion = getBoosterElement("rp-character-version-delete");
    const duplicateVersion = getBoosterElement("rp-character-version-duplicate");
    const proposeRevision = getBoosterElement("rp-character-revision-generate");
    const autoProposeRevision = getBoosterElement(
        "rp-character-revision-auto-generate"
    );
    if (versionSelect) versionSelect.disabled = pending || editing;
    if (renameVersion) {
        renameVersion.disabled = pending || editing || baselineState.isOriginal;
    }
    if (deleteVersion) {
        deleteVersion.disabled = pending || editing || baselineState.isOriginal;
    }
    if (duplicateVersion) {
        const revisionLimitReached = baselineState.identity
            ? getCharacterBaselineVersionOptions(baselineState.identity.key)
                  .length >= MAX_CHARACTER_BASELINE_VERSIONS
            : false;
        duplicateVersion.disabled =
            !featureEnabled ||
            !baseline ||
            pending ||
            editing ||
            revisionLimitReached;
        duplicateVersion.textContent = revisionLimitReached
            ? "갱신본 최대 10개"
            : "현재 기준 복사본 만들기";
    }
    if (proposeRevision) {
        const revisionLimitReached = baselineState.identity
            ? getCharacterBaselineVersionOptions(baselineState.identity.key)
                  .length >= MAX_CHARACTER_BASELINE_VERSIONS
            : false;
        proposeRevision.disabled =
            !featureEnabled ||
            !baseline ||
            pending ||
            editing ||
            allPinned ||
            revisionLimitReached;
        proposeRevision.textContent =
            task === "revision"
                ? "AI가 변화 분석 중…"
                : revisionLimitReached
                  ? "갱신본 최대 10개"
                  : "요청대로 갱신안 만들기";
    }
    if (autoProposeRevision) {
        const revisionLimitReached = baselineState.identity
            ? getCharacterBaselineVersionOptions(baselineState.identity.key)
                  .length >= MAX_CHARACTER_BASELINE_VERSIONS
            : false;
        autoProposeRevision.disabled =
            !featureEnabled ||
            !baseline ||
            pending ||
            editing ||
            allPinned ||
            revisionLimitReached;
        autoProposeRevision.textContent =
            task === "revision"
                ? "AI가 갱신안 생성 중…"
                : revisionLimitReached
                  ? "갱신본 최대 10개"
                  : "최근 변화 자동 탐색";
    }
    getBoosterElements(".rp-character-tool-button").forEach((button) => {
        const fieldId = button.dataset.fieldId;
        const field = baseline?.fields?.[fieldId];
        if (button.classList.contains("rp-character-pin-button")) {
            button.disabled =
                !featureEnabled || pending || editing || !String(field?.text || "").trim();
        } else if (button.classList.contains("rp-character-regenerate-button")) {
            button.disabled =
                !featureEnabled ||
                !baselineState.identity ||
                pending ||
                editing ||
                atVersionLimit;
        } else if (button.classList.contains("rp-character-edit-button")) {
            const ownTextarea = button.closest(".rp-character-field-card")?.querySelector(
                `.rp-character-field-text[data-field-id="${fieldId}"]`
            );
            const editingThis = ownTextarea && !ownTextarea.readOnly;
            button.disabled =
                !featureEnabled ||
                !baselineState.identity ||
                pending ||
                atVersionLimit ||
                (editing && !editingThis);
        }
    });
}

// @source-order 355
function updateBoosterLiveStatus(elementId, state, text) {
    const element = getBoosterElement(elementId);
    if (!element) return;
    element.classList.remove("is-active", "is-setup", "is-off");
    element.classList.add(
        state === "active" ? "is-active" : state === "setup" ? "is-setup" : "is-off"
    );
    const label = element.querySelector(".rp-booster-live-status-text");
    if (label) label.textContent = text;
}

// @source-order 356
function updateCharacterBoosterPanel() {
    updateJevConnectionBadges();
    const chatId = String(getCurrentChatId());
    const state = ensureChatState(chatId);
    const baselineState = getCurrentCharacterBaseline(chatId);
    const characterReadiness = getCharacterBoosterReadiness(baselineState);
    const {
        featureEnabled,
        baselineAvailable,
        boostActive,
        anchorContentStale,
        needsAnchorRefresh,
    } = characterReadiness;
    const pendingTask = baselineState.identity
        ? characterBaselinePendingTasks.get(baselineState.identity.key)
        : null;
    const pending = Boolean(pendingTask);
    const auditInterval = getGlobalAuditInterval();
    const name = getBoosterElement("rp-character-current-name");
    const status = getBoosterElement("rp-character-baseline-status");
    const fields = getBoosterElement("rp-character-baseline-fields");
    const cardChange = getCharacterCardChangeStatus(baselineState);
    const cardChangeNotice = getBoosterElement(
        "rp-character-card-change-notice"
    );
    const languageStatus = getBoosterElement("rp-character-language-status");
    const versionSelect = getBoosterElement("rp-character-baseline-version");
    const proposalContainer = getBoosterElement(
        "rp-character-revision-proposal-container"
    );
    updateBoosterLiveStatus(
        "rp-character-live-status",
        !featureEnabled ? "off" : boostActive ? "active" : "setup",
        !featureEnabled
            ? "부스터 꺼짐"
            : boostActive
              ? "부스팅 중"
              : !baselineAvailable
                ? "캐릭터 기준 필요"
                : needsAnchorRefresh
                  ? "앵커 갱신 필요"
                  : "앵커 생성 필요"
    );
    if (name) {
        name.textContent = baselineState.identity
            ? `현재 캐릭터: ${baselineState.identity.name}`
            : "개별 캐릭터 채팅에서 사용할 수 있어요.";
    }
    if (status) {
        status.textContent = pending
            ? pendingTask === "all"
                ? "캐릭터 시트를 분석해 전체 기준을 만드는 중이에요…"
                : pendingTask === "anchor"
                  ? "현재 기준으로 캐릭터 전용 상시 앵커를 만드는 중이에요…"
                  : pendingTask === "revision"
                    ? "현재 기준과 최근 20개 롤플을 바탕으로 갱신안을 만드는 중이에요…"
                    : pendingTask === "revision-apply"
                      ? "검토한 갱신본의 전용 앵커를 만들고 저장하는 중이에요…"
                  : `${getCharacterBaselineFieldDefinition(pendingTask)?.label || "선택한 항목"}을 다시 만드는 중이에요…`
            : baselineState.status === "current"
              ? featureEnabled
                  ? boostActive
                      ? "캐릭터 기준 저장됨 · 부스팅 중"
                      : needsAnchorRefresh
                        ? "캐릭터 기준 저장됨 · 앵커 갱신 후 부스팅"
                        : "캐릭터 기준 저장됨 · 앵커 생성 후 부스팅"
                  : "캐릭터 기준 저장됨 · 전역 설정에서 캐릭터 부스터가 꺼져 있어요."
              : baselineState.status === "missing"
                  ? "아직 저장된 캐릭터 기준이 없습니다."
                  : "그룹 채팅이나 캐릭터가 없는 화면에서는 기준을 만들 수 없습니다.";
    }
    if (cardChangeNotice) cardChangeNotice.hidden = !cardChange.changed;
    if (languageStatus) {
        languageStatus.hidden = !hasCharacterDisplayLanguageMismatch(
            baselineState.baseline
        );
    }
    if (versionSelect) {
        versionSelect.innerHTML = renderCharacterBaselineVersionOptions(
            baselineState
        );
        versionSelect.value = String(baselineState.versionId || "");
    }
    if (proposalContainer) {
        proposalContainer.innerHTML = renderCharacterBaselineRevisionProposal(
            baselineState,
            chatId
        );
    }
    if (fields && !hasOpenCharacterBaselineEditor()) {
        fields.innerHTML = renderCharacterBaselineFields(
            baselineState.baseline,
            baselineState.identity,
            chatId,
            baselineState.versionId
        );
    }
    const anchorText = getBoosterElement("rp-character-boost-anchor-text");
    const anchorStatus = getBoosterElement("rp-character-boost-anchor-status");
    const anchorEdit = getBoosterElement("rp-character-boost-anchor-edit");
    const anchorSave = getBoosterElement("rp-character-boost-anchor-save");
    const anchorCancel = getBoosterElement("rp-character-boost-anchor-cancel");
    const anchorRegenerate = getBoosterElement(
        "rp-character-boost-anchor-regenerate"
    );
    const anchorSavedAt = getBoosterElement(
        "rp-character-boost-anchor-saved-at"
    );
    const anchorNeedsRefresh = anchorContentStale;
    const originalAtVersionLimit = Boolean(
        baselineState.identity &&
            baselineState.isOriginal &&
            getCharacterBaselineVersionOptions(baselineState.identity.key)
                .length >= MAX_CHARACTER_BASELINE_VERSIONS
    );
    if (anchorText?.readOnly) {
        anchorText.value = getCharacterAnchorDisplayValue(
            baselineState.baseline
        );
        anchorText.dataset.identityKey = baselineState.identity?.key || "";
        anchorText.dataset.characterName = baselineState.identity?.name || "";
        anchorText.dataset.sourceHash = baselineState.identity?.sourceHash || "";
        anchorText.dataset.chatId = getCurrentChatId();
        anchorText.dataset.baselineVersionId = baselineState.versionId || "";
    }
    if (anchorStatus) {
        anchorStatus.classList.toggle(
            "is-warning",
            anchorNeedsRefresh && pendingTask !== "anchor"
        );
        anchorStatus.textContent = pendingTask === "anchor"
            ? "현재 기준으로 상시 앵커를 만드는 중이에요…"
            : anchorNeedsRefresh
              ? "⚠️ 캐릭터 기준이 변경됐어요. 앵커를 갱신해 주세요."
              : baselineState.baseline?.boostAnchor
                ? baselineState.baseline.boostAnchorDisplayLanguage !==
                  ensureModuleSettings().outputLanguage
                    ? "표시 언어가 달라요. ↻ 버튼으로 현재 언어 표시를 만들 수 있어요. 실제 부스팅은 기존 영문 앵커로 계속됩니다."
                    : "표시 언어와 관계없이 실제 부스팅에는 영문 앵커를 사용합니다."
                : baselineState.baseline
                  ? "상시 앵커가 없습니다. ↻ 버튼으로 만들 수 있어요."
                  : "전체 요약을 실행하면 상시 앵커도 함께 생성됩니다.";
    }
    if (anchorEdit) {
        anchorEdit.disabled =
            !featureEnabled ||
            !baselineState.baseline ||
            pending ||
            originalAtVersionLimit;
    }
    if (anchorSave) anchorSave.disabled = pending;
    if (anchorCancel) anchorCancel.disabled = pending;
    if (anchorRegenerate) {
        anchorRegenerate.disabled =
            !featureEnabled ||
            !baselineState.baseline ||
            pending ||
            originalAtVersionLimit;
        anchorRegenerate.classList.toggle(
            "is-attention",
            anchorNeedsRefresh && pendingTask !== "anchor"
        );
        anchorRegenerate.textContent =
            anchorNeedsRefresh && pendingTask !== "anchor" ? "↻ 갱신" : "↻";
        anchorRegenerate.title = anchorNeedsRefresh
              ? "변경된 캐릭터 기준으로 앵커 갱신"
              : "현재 기준으로 상시 앵커 다시 만들기";
        anchorRegenerate.setAttribute(
            "aria-label",
            anchorNeedsRefresh
                  ? "변경된 캐릭터 기준으로 앵커 갱신"
                  : "현재 기준으로 상시 앵커 다시 만들기"
        );
    }
    if (anchorSavedAt) {
        const savedAt = formatSavedAt(
            baselineState.baseline?.boostAnchorUpdatedAt
        );
        anchorSavedAt.textContent = savedAt
            ? `마지막 저장: ${savedAt}`
            : "아직 저장된 앵커가 없어요.";
    }
    updateCharacterBaselineActionStates();

    const manual = getBoosterElement("rp-character-manual-audit-btn");
    const count = getBoosterElement("rp-character-audit-count");
    if (manual) {
        manual.disabled =
            !featureEnabled ||
            !baselineAvailable ||
            genreAuditPendingChats.has(getCurrentChatId());
        manual.textContent = genreAuditPendingChats.has(getCurrentChatId())
            ? "🔍 진단 중…"
            : "🔍 지금 진단하기";
    }
    if (count) {
        if (!featureEnabled) {
            count.textContent = "전역 설정에서 캐릭터 부스터가 꺼져 있습니다.";
        } else if (!baselineState.baseline) {
            count.textContent = "캐릭터 기준을 만들면 진단을 시작하고, 전용 앵커가 준비되면 부스팅을 시작합니다.";
        }
        else if (auditInterval === 0) {
            count.textContent = "자동 진단 꺼짐 · 수동 진단은 사용할 수 있어요";
        } else {
            const progress = state.genreAnchor.responseCount % auditInterval;
            const remaining = progress === 0
                ? auditInterval
                : auditInterval - progress;
            count.textContent = `자동 진단까지 ${remaining}회`;
        }
    }
    renderLastCharacterAudit(state);
}

// @source-order 357
function getGenreAuditStatusText(state) {
    const chatId = getCurrentChatId();
    if (genreAuditPendingChats.has(chatId)) return "최근 응답을 진단하는 중입니다…";
    if (getGlobalAuditInterval() === 0) {
        return "장르 부스팅 중입니다.";
    }

    const audit = state.genreAnchor.lastGenreAudit;
    const genreCodes = GENRE_AUDIT_DISPLAY_ITEMS.map(item => item.code);
    if (audit && !audit.correctionCodes?.length && audit.uncertain?.some(code => genreCodes.includes(code)) &&
        !genreCodes.some(code => !audit.uncertain.includes(code) && ['attention', 'weak'].includes(audit.ratings?.[code]))) {
        return '최근 진단: 판단 보류 항목이 있어요. 상세 사유를 확인해 주세요.';
    }
    switch (state.genreAnchor.auditStatus) {
        case "stable":
            return state.genreAnchor.lastGenreAudit?.ratings?.support_texture ===
                "dormant"
                ? "최근 진단: 주 장르는 안정 · 보조 렌즈는 대기 중이에요."
                : "최근 진단: 안정적으로 유지되고 있어요.";
        case "reinforcing":
            return "최근 진단: 다음 응답에 보정을 적용해요.";
        case "attention":
            return "최근 진단: 주의 항목이 있어요. 상세 사유를 확인해 주세요.";
        case "deferred":
            return "최근 진단: 판단 보류 항목이 있어요. 상세 사유를 확인해 주세요.";
        case "error":
            return "최근 진단 실패 · 부스팅은 유지돼요.";
        case "monitoring":
            return "자동 진단 대기 중입니다.";
        default:
            return "설정한 응답 수가 지나면 자동 진단을 시작해요.";
    }
}

// @source-order 358
function updateGenreAnchorPanel() {
    updateJevConnectionBadges();
    const emptyState = getBoosterElement("rp-anchor-empty");
    const content = getBoosterElement("rp-anchor-content");
    const primary = getBoosterElement("rp-anchor-primary");
    const support = getBoosterElement("rp-anchor-support");
    const status = getBoosterElement("rp-anchor-status");
    const focus = getBoosterElement("rp-anchor-focus");
    const count = getBoosterElement("rp-anchor-count");
    const manualAuditButton = getBoosterElement("rp-manual-audit-btn");
    const selectionSummary = getBoosterElement(
        "rp-genre-selection-summary"
    );

    if (
        !emptyState ||
        !content ||
        !primary ||
        !support ||
        !status ||
        !focus ||
        !count
    ) {
        return;
    }

    const state = ensureChatState();
    const genreFeatureEnabled = isBoosterFeatureEnabled("genre");
    const selection = getGenreAnchorSelection(state);
    const auditInterval = getGlobalAuditInterval();
    updateBoosterLiveStatus(
        "rp-genre-live-status",
        !genreFeatureEnabled ? "off" : selection ? "active" : "setup",
        !genreFeatureEnabled
            ? "부스터 꺼짐"
            : selection
              ? "부스팅 중"
              : "주 장르 선택 필요"
    );
    if (manualAuditButton) {
        manualAuditButton.disabled =
            !selection || genreAuditPendingChats.has(getCurrentChatId());
        manualAuditButton.textContent = genreAuditPendingChats.has(
            getCurrentChatId()
        )
            ? "🔍 진단 중…"
            : "🔍 지금 진단하기";
    }

    if (!selection) {
        if (selectionSummary) {
            selectionSummary.hidden = true;
            selectionSummary.textContent = "";
        }
        emptyState.textContent = genreFeatureEnabled
            ? "주 장르를 선택하면 부스팅을 시작합니다."
            : "전역 설정에서 장르 부스터가 꺼져 있습니다.";
        emptyState.hidden = false;
        content.hidden = true;
        renderGenreRecommendation();
        updateCharacterBoosterPanel();
        return;
    }

    emptyState.hidden = true;
    content.hidden = false;
    if (selectionSummary) {
        const primarySummary = getGenreProfile(
            selection.primaryGenre
        ).ui;
        const supportSummary = selection.supportGenre
            ? getGenreProfile(selection.supportGenre).ui
            : "";
        selectionSummary.textContent = supportSummary
            ? `주 장르 · ${primarySummary}\n보조 장르 · ${supportSummary}`
            : `주 장르 · ${primarySummary}`;
        selectionSummary.hidden = false;
    }
    primary.textContent =
        `${selection.primaryGenre.emoji} 주 장르: ` +
        selection.primaryGenre.label;
    if (selection.supportGenre) {
        support.hidden = false;
        support.textContent =
            `${selection.supportGenre.emoji} 보조 장르: ` +
            selection.supportGenre.label;
    } else {
        support.hidden = true;
        support.textContent = "";
    }

    status.textContent = getGenreAuditStatusText(state);
    const genreCorrectionCodes = selection.correctionCodes.filter((code) =>
        GENRE_AUDIT_DISPLAY_ITEMS.some((item) => item.code === code)
    );
    if (genreCorrectionCodes.length) {
        focus.hidden = false;
        focus.textContent =
            "다음 응답 보정: " +
            genreCorrectionCodes
                .map((code) => GENRE_CORRECTION_LABELS[code])
                .join(" · ");
    } else {
        focus.hidden = true;
        focus.textContent = "";
    }

    if (auditInterval === 0) {
        count.textContent =
            "자동 진단 꺼짐 · 수동 진단은 사용할 수 있어요";
    } else {
        const progress = state.genreAnchor.responseCount % auditInterval;
        count.textContent =
            `자동 진단까지 ${
                progress === 0
                    ? auditInterval
                    : auditInterval - progress
            }회 · 진단 주기 ${auditInterval}회`;
    }
    renderGenreRecommendation();
    renderLastGenreAudit(state);
    updateCharacterBoosterPanel();
}

// @source-order 359
function changeGlobalAuditInterval(value) {
    cancelAutomaticPlot();
    const interval = Number(value);
    if (
        !Number.isSafeInteger(interval) ||
        (interval !== 0 &&
            (interval < MIN_AUDIT_INTERVAL ||
                interval > MAX_AUDIT_INTERVAL))
    ) {
        return;
    }

    const settings = ensureModuleSettings();
    settings.auditInterval = interval;
    Object.entries(settings.chats).forEach(([chatId, state]) => {
        if (!state || typeof state !== "object") return;
        const anchor = ensureGenreAnchorState(state);
        anchor.responseCount = 0;
        anchor.auditStatus = interval === 0 ? "waiting" : "monitoring";
        if (chatId === getCurrentChatId()) {
            anchor.lastCountedMessageId = getLatestAssistantMessageId();
        }
    });
    saveSettingsDebounced();
    updateGenreAnchorPanel();
}

// @source-order 360
function changeBoosterFeature(feature, enabled) {
    cancelAutomaticPlot(feature === 'genre' ? 'genre_changed' : feature === 'character' ? 'character_changed' : 'plot_state_changed');
    if (!["genre", "character", "plot"].includes(feature)) return;
    const settings = ensureModuleSettings();
    settings.enabledFeatures[feature] = enabled === true;

    if (feature === "plot" && !settings.enabledFeatures.plot) {
        clearPlotPromptIfPending();
    }
    if (["genre", "character"].includes(feature)) {
        if (!settings.enabledFeatures[feature]) {
            const featureCodes =
                feature === "genre"
                    ? GENRE_BOOST_CORRECTION_CODES
                    : CHARACTER_BOOST_CORRECTION_CODES;
            for (const state of Object.values(settings.chats)) {
                if (!state || typeof state !== "object") continue;
                removeLiveCorrectionCodes(
                    ensureGenreAnchorState(state),
                    featureCodes
                );
            }
        }
        updateGenrePrompt();
        updateGenreAnchorPanel();
    }
    const notice = getBoosterElement(`rp-${feature}-feature-disabled`);
    if (notice) notice.hidden = enabled === true;
    if (feature === "genre") populateGenreSelectionControls();
    if (feature === "character") updateCharacterBoosterPanel();
    if (feature === "plot") updatePlotGenerationPendingUi();
    saveSettingsDebounced();
}

export { changeBoosterFeature, changeGlobalAuditInterval, getAuditDetailPanel, getAuditRecordForScope, getGenreAuditDisplayStatus, getGenreAuditResultStatusText, getGenreAuditStatusText, hasOpenCharacterBaselineEditor, renderAuditDetailPanel, renderAuditStatusGrid, renderCharacterBaselineFields, renderCharacterBaselineRevisionProposal, renderCharacterBaselineVersionOptions, renderLastCharacterAudit, renderLastGenreAudit, safelyUpdateCharacterBoosterPanel, safelyUpdateGenreAnchorPanel, selectAuditDetail, updateBoosterLiveStatus, updateCharacterBaselineActionStates, updateCharacterBoosterPanel, updateGenreAnchorPanel };
