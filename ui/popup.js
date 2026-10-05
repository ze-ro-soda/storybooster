import { wireDeveloperModeEntry } from './debug-tools.js';
import { renderBaselineBackupControls, wireBaselineBackupControls } from './baseline-backup.js';
import { updateJevConnectionBadges } from './panels.js';
import { cancelAutomaticPlot } from '../core/automatic-plot-state.js';
import { cancelJevRequests, getJevConnectionBadge, getJevConnectionStatus, hasJevSessionKey, saveJevKey, deleteJevKey, restoreJevKey, setJevUsageConsent, testJevConnection } from '../core/jev-client.js';
import { ensureAutomaticPlotSettings, updateAutomaticPlotStatus, getAutomaticPlotStatusText, cancelPreparedAutomaticPlot, setAutomaticPlotEnabled } from '../features/automatic-plot.js';
// StoryBooster: ui/popup.js
import { CHARACTER_BOOST_ANCHOR_MAX_CHARS, CHARACTER_REVISION_NOTE_MAX_CHARS, DEFAULT_AUDIT_INTERVAL, DEFAULT_PLOT_MAX_TOKENS, MAX_AUDIT_INTERVAL, MAX_PLOT_MAX_TOKENS, MIN_AUDIT_INTERVAL, MIN_PLOT_MAX_TOKENS, MODULE_NAME } from "../core/constants.js";
import { getCurrentCharacterIdentity, getCurrentChatId, getCurrentRoleDisplayNames } from "../core/context.js";
import { recordStoryBoosterError, refreshStoryBoosterErrorLogBadge } from "../core/diagnostics.js";
import { escapeHtml, getActiveBoosterPopupRoot, getBoosterElement } from "../core/dom.js";
import { getConnectionProfileService } from "../core/requests.js";
import { runtime } from "../core/runtime.js";
import { getContext, saveSettingsDebounced } from "../core/sillytavern.js";
import { ensureChatState, ensureModuleSettings, getCharacterAnchorDisplayValue, getCharacterBoosterReadiness, getCharacterCardChangeStatus, getCurrentCharacterBaseline, getGlobalAuditInterval, getSelectedPlotCategory, hasCharacterDisplayLanguageMismatch, isBoosterFeatureEnabled, normalizeGenreSelection } from "../core/storage.js";
import { cancelPendingGenreCorrection, runManualGenreAudit, toggleManualAuditBoost } from "../features/audit.js";
import { acknowledgeCharacterCardChange, applyCharacterBaselineRevisionProposal, beginCharacterBoostAnchorEditing, cancelCharacterBaselineRevisionProposal, cancelCharacterBoostAnchorEditing, captureCharacterRevisionReview, deleteCharacterBaseline, deleteCurrentCharacterBaselineVersion, duplicateCurrentCharacterBaselineVersion, generateCharacterBaseline, generateCharacterBaselineRevisionProposal, getCharacterBaselineFieldDefinition, notifyCharacterCardChangeIfNeeded, regenerateCharacterBoostAnchor, renameCurrentCharacterBaselineVersion, saveEditedCharacterBoostAnchor, scheduleCharacterBaselineAutosave, selectCharacterBaselineVersion, toggleCharacterFieldEditing, toggleCharacterFieldPin } from "../features/character.js";
import { activatePlotGenerationMode, addCustomPlotCategory, capturePlotModeDraft, clearGeneratedEventResult, clearPlotHistory, clearSecretPlotAction, deleteCustomPlotCategory, deletePlotHistoryItem, generateEventCandidate, getPlotHistory, injectEventAndGenerateReply, insertEventIntoComposer, loadPlotHistoryItem, renderPlotCategoryCards, runSelectedPlotGenerationAction, selectPlotCategory, selectSecretPlotAction, setPlotSecretMode, togglePlotHistoryDrawer, updatePlotGenerationPendingUi, updatePlotHistoryUI } from "../features/plot.js";
import { applyGenreRecommendation, cancelGenreRecommendation, generateGenreRecommendation } from "../features/recommendation.js";
import { addCustomGenre, deleteCustomGenre, renderCustomGenreList, renderGenreOptions, syncGenreSelectionFromControls } from "./genre-controls.js";
import { changeBoosterFeature, changeGlobalAuditInterval, getAuditRecordForScope, renderCharacterBaselineFields, renderCharacterBaselineRevisionProposal, renderCharacterBaselineVersionOptions, safelyUpdateCharacterBoosterPanel, selectAuditDetail, updateGenreAnchorPanel } from "./panels.js";
import { openCurrentInjectionPromptViewer, openStoryBoosterErrorLog } from "./tools.js";

function renderJevConnectionBadge(id) {
    const badge = getJevConnectionBadge(ensureModuleSettings().jevEnabled);
    return `<div id="${id}" class="rp-booster-live-status rp-jev-badge is-${badge.state}" aria-live="polite" ${badge.hidden ? 'hidden' : ''}><span class="rp-live-status-dot" aria-hidden="true"></span><span class="rp-booster-live-status-text">${escapeHtml(badge.text)}</span></div>`;
}

// @source-order 367
function activateBoosterTab(tabName, { focus = false } = {}) {
    const popupRoot = getActiveBoosterPopupRoot();
    if (!popupRoot) return;

    const tabButtons = [...popupRoot.querySelectorAll(".rp-booster-tab")];
    const tabPanels = [...popupRoot.querySelectorAll(".rp-booster-tab-panel")];

    tabButtons.forEach((button) => {
        const isActive = button.dataset.tab === tabName;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-selected", String(isActive));
        button.tabIndex = isActive ? 0 : -1;
        if (isActive && focus) button.focus();
    });

    tabPanels.forEach((panel) => {
        panel.hidden = panel.dataset.tabPanel !== tabName;
    });
}

// @source-order 368
function handleBoosterTabKeydown(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    const tabs = [...event.currentTarget.querySelectorAll(".rp-booster-tab")];
    const currentIndex = tabs.indexOf(document.activeElement);
    if (currentIndex < 0) return;

    event.preventDefault();
    let nextIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else {
        const direction = event.key === "ArrowRight" ? 1 : -1;
        nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
    }

    activateBoosterTab(tabs[nextIndex].dataset.tab, { focus: true });
}

// @source-order 369
function renderBoosterPopupHtml(popupInstanceId = "") {
    const chatId = String(getCurrentChatId());
    const s = ensureChatState(chatId);
    const genreSelection = normalizeGenreSelection(s);
    const auditInterval = getGlobalAuditInterval();
    const auditIntervalLabel =
        auditInterval === 0 ? "꺼짐" : `${auditInterval}회마다`;
    const genreFeatureEnabled = isBoosterFeatureEnabled("genre");
    const characterFeatureEnabled = isBoosterFeatureEnabled("character");
    const plotFeatureEnabled = isBoosterFeatureEnabled("plot");
    const plotSecretMode = s.plotSecretMode === true;
    const automaticPlot = ensureAutomaticPlotSettings(s);
    const { characterName, userName } = getCurrentRoleDisplayNames();
    const characterBaselineState = getCurrentCharacterBaseline(chatId);
    const characterReadiness = getCharacterBoosterReadiness(
        characterBaselineState
    );
    const characterCardChange = getCharacterCardChangeStatus(
        characterBaselineState
    );
    const characterLanguageMismatch = hasCharacterDisplayLanguageMismatch(
        characterBaselineState.baseline
    );
    const genreLiveActive = genreFeatureEnabled && Boolean(genreSelection.primaryId);
    const characterLiveActive = characterReadiness.boostActive;
    const characterLiveLabel = !characterFeatureEnabled
        ? "부스터 꺼짐"
        : characterLiveActive
          ? "부스팅 중"
          : !characterReadiness.baselineAvailable
            ? "캐릭터 기준 필요"
            : characterReadiness.needsAnchorRefresh
                ? "앵커 갱신 필요"
              : "앵커 생성 필요";

    return `
    <div id="rp-booster-popup" data-storybooster-popup-instance="${escapeHtml(
        popupInstanceId
    )}">
        <div class="rp-booster-header">
            <h3>📖 스토리부스터 <small>(이 채팅에만 적용)</small></h3>

            <div class="rp-booster-tabs" role="tablist" aria-label="스토리부스터 기능">
                <button id="rp-tab-genre" type="button" class="rp-booster-tab is-active" role="tab" aria-selected="true" aria-controls="rp-booster-genre-panel" data-tab="genre">
                    🎭 장르 부스터
                </button>
                <button id="rp-tab-character" type="button" class="rp-booster-tab" role="tab" aria-selected="false" aria-controls="rp-booster-character-panel" data-tab="character" tabindex="-1">
                    👤 캐릭터 부스터
                </button>
                <button id="rp-tab-plot" type="button" class="rp-booster-tab" role="tab" aria-selected="false" aria-controls="rp-booster-plot-panel" data-tab="plot" tabindex="-1">
                    🎲 플롯 부스터
                </button>
            </div>
        </div>

        <section id="rp-booster-genre-panel" class="rp-booster-tab-panel" role="tabpanel" aria-labelledby="rp-tab-genre" data-tab-panel="genre">
        <div class="rp-booster-section-heading">
            <h4>장르 부스터 <small>(채팅별 저장)</small></h4>
            <div class="rp-booster-heading-statuses">
            <div id="rp-genre-live-status" class="rp-booster-live-status ${!genreFeatureEnabled ? "is-off" : genreLiveActive ? "is-active" : "is-setup"}" aria-live="polite">
                <span class="rp-live-status-dot" aria-hidden="true"></span>
                <span class="rp-booster-live-status-text">${!genreFeatureEnabled ? "부스터 꺼짐" : genreLiveActive ? "부스팅 중" : "주 장르 선택 필요"}</span>
            </div>
            ${renderJevConnectionBadge("rp-genre-jev-status")}
            </div>
        </div>
        <p id="rp-genre-feature-disabled" class="rp-feature-disabled-notice" ${genreFeatureEnabled ? "hidden" : ""}>전역 설정에서 장르 부스터가 꺼져 있습니다. 저장된 장르 설정은 유지돼요.</p>
        <p class="rp-genre-help">주 장르는 캐릭터와 장면의 중심 논리를 잡고, 보조 장르는 자연스러운 기회에서 압력·세계 논리·분위기와 질감을 보강합니다.</p>
        <div class="rp-genre-select-grid">
            <label class="rp-primary-select" for="rp-primary-genre">
                <span>⭐ 주 장르</span>
                <select id="rp-primary-genre">${renderGenreOptions(
                    genreSelection.primaryId,
                    "사용하지 않음"
                )}</select>
            </label>
            <label for="rp-support-genre">
                <span>＋ 보조 장르</span>
                <select id="rp-support-genre">${renderGenreOptions(
                    genreSelection.supportIds[0] || null,
                    "없음"
                )}</select>
            </label>
        </div>
        <p id="rp-genre-selection-summary" class="rp-genre-selection-summary" hidden></p>

        <section id="rp-genre-anchor">
            <div class="rp-anchor-title">🧭 장르 앵커</div>
            <p id="rp-anchor-empty">주 장르를 선택하면 부스팅을 시작합니다.</p>

            <div id="rp-anchor-content" hidden>
                <div id="rp-anchor-primary"></div>
                <div id="rp-anchor-support" hidden></div>
                <p id="rp-anchor-status" aria-live="polite"></p>
                <div id="rp-anchor-focus" hidden></div>
                <p id="rp-anchor-count"></p>
                <details id="rp-last-audit" class="rp-last-audit" hidden>
                    <summary>최근 진단 결과</summary>
                    <div class="rp-last-audit-body">
                        <p id="rp-last-audit-meta" class="rp-last-audit-meta"></p>
                        <p id="rp-last-audit-genres"></p>
                        <div id="rp-last-audit-grid" class="rp-audit-status-grid" hidden></div>
                        <div id="rp-genre-audit-detail" class="rp-audit-detail" hidden></div>
                        <p id="rp-last-audit-correction"></p>
                        <p id="rp-last-audit-connection" class="rp-last-audit-connection"></p>
                        <p id="rp-last-audit-status" class="rp-last-audit-status" aria-live="polite"></p>
                        <button id="rp-cancel-audit-correction" type="button" class="menu_button" hidden>
                            이번 보정 적용 안 하기
                        </button>
                    </div>
                </details>
            </div>

            <p class="rp-global-audit-summary">자동 진단 ${auditIntervalLabel} · 확장 설정에서 변경</p>
            <button id="rp-manual-audit-btn" type="button" class="menu_button">
                🔍 지금 진단하기
            </button>
            <p class="rp-anchor-help">최근 응답의 주 장르·보조 렌즈·장르 표현·장면 밀도를 확인해 다음 응답 한 번만 보정합니다.</p>
        </section>

        <section id="rp-genre-recommendation">
            <div class="rp-recommend-title">🔎 현재 롤플 장르 추천</div>
            <p>현재 롤플에 어울리는 주 장르와 보조 장르를 추천합니다.</p>
            <button id="rp-recommend-genre-btn" type="button" class="menu_button">현재 롤플 분석</button>
            <p id="rp-recommend-status" aria-live="polite">추천은 자동 적용되지 않습니다.</p>
            <div id="rp-recommend-result" hidden>
                <strong id="rp-recommend-genres"></strong>
                <p id="rp-recommend-reason"></p>
                <div class="rp-recommend-actions">
                    <button id="rp-recommend-apply-btn" type="button" class="menu_button">추천 적용</button>
                    <button id="rp-recommend-cancel-btn" type="button" class="menu_button">취소</button>
                </div>
            </div>
        </section>

        <details id="rp-custom-genre-editor">
            <summary>✨ 원하는 장르 직접 추가</summary>
            <p class="rp-custom-help">한 번 추가한 장르는 모든 채팅의 선택 목록에서 재사용할 수 있습니다.</p>
            <label for="rp-custom-genre-name">장르 이름</label>
            <input id="rp-custom-genre-name" type="text" maxlength="50" placeholder="예: Gothic Romance, Court Intrigue">
            <label for="rp-custom-genre-description">장르 방향 <small>(선택)</small></label>
            <textarea id="rp-custom-genre-description" rows="3" maxlength="500" placeholder="AI가 반드시 살렸으면 하는 분위기와 전개를 자유롭게 적어 주세요. 한국어도 사용할 수 있습니다."></textarea>
            <button id="rp-custom-genre-add-btn" type="button" class="menu_button">장르 목록에 추가</button>
            <p id="rp-custom-genre-status" aria-live="polite"></p>
            <div id="rp-custom-genre-list"></div>
        </details>
        </section>

        <section id="rp-booster-character-panel" class="rp-booster-tab-panel" role="tabpanel" aria-labelledby="rp-tab-character" data-tab-panel="character" hidden>
        <div class="rp-booster-section-heading">
            <h4>캐릭터 부스터 <small>(캐릭터별 기준 저장)</small></h4>
            <div class="rp-booster-heading-statuses">
            <div id="rp-character-live-status" class="rp-booster-live-status ${!characterFeatureEnabled ? "is-off" : characterLiveActive ? "is-active" : "is-setup"}" aria-live="polite">
                <span class="rp-live-status-dot" aria-hidden="true"></span>
                <span class="rp-booster-live-status-text">${characterLiveLabel}</span>
            </div>
            ${renderJevConnectionBadge("rp-character-jev-status")}
            </div>
        </div>
        <p id="rp-character-feature-disabled" class="rp-feature-disabled-notice" ${characterFeatureEnabled ? "hidden" : ""}>전역 설정에서 캐릭터 부스터가 꺼져 있습니다. 저장된 기준과 앵커는 유지돼요.</p>
        <p class="rp-genre-help">캐릭터의 성격·대사·행동·관계 반응을 살리고, 캐릭터성 이탈과 한쪽으로 치우친 해석을 점검합니다.</p>

        <section class="rp-character-baseline-card">
            <div class="rp-anchor-title">📋 캐릭터 기준</div>
            <p id="rp-character-current-name"></p>
            <p id="rp-character-baseline-status" aria-live="polite"></p>
            <div id="rp-character-card-change-notice" class="rp-character-card-change-notice" ${characterCardChange.changed ? "" : "hidden"}>
                <strong>캐릭터 카드 변경을 감지했어요</strong>
                <span>현재는 기존 기준과 앵커로 계속 부스팅하고 있습니다.</span>
                <div class="rp-character-card-change-actions">
                    <button id="rp-character-card-reanalyze" type="button">다시 분석하기</button>
                    <button id="rp-character-card-keep" type="button">기존 기준 유지</button>
                </div>
            </div>
            <p id="rp-character-language-status" class="rp-character-language-status" ${characterLanguageMismatch ? "" : "hidden"}>출력 언어가 변경됐어요. 기준을 다시 요약하고 앵커를 갱신하면 현재 언어로 표시됩니다.</p>
            <div class="rp-character-version-manager">
                <label for="rp-character-baseline-version">이 채팅에서 사용할 기준</label>
                <select id="rp-character-baseline-version">
                    ${renderCharacterBaselineVersionOptions(characterBaselineState)}
                </select>
                <div class="rp-character-version-actions">
                    <button id="rp-character-version-rename" type="button">이름 변경</button>
                    <button id="rp-character-version-delete" type="button">갱신본 삭제</button>
                </div>
                <small>원본과 갱신본은 캐릭터별로 보관되며, 여기서 고른 한 버전만 현재 채팅의 진단·부스팅에 사용됩니다.</small>
            </div>
            ${renderBaselineBackupControls()}
            <details class="rp-character-revision-maker">
                <summary>🌱 새 버전 만들기</summary>
                <p>변화 분석 없이 현재 기준과 앵커를 그대로 복사해 새 버전으로 만들 수 있습니다. 복사 후 이름을 바꾸거나 원하는 항목을 직접 수정할 수 있으며 AI는 호출되지 않습니다.</p>
                <button id="rp-character-version-duplicate" type="button" class="rp-character-wide-button">현재 기준 복사본 만들기</button>
                <hr class="rp-character-revision-divider">
                <p>변화 방향을 입력하면 현재 기준에 자연스럽게 이어지는 새 기준을 만듭니다. 최근 AI 답변 20개와 각 답변 직전의 유저 입력은 변화의 표현과 강도를 구체화하는 참고 자료로 사용합니다.</p>
                <label for="rp-character-revision-note">반영할 변화 방향</label>
                <textarea id="rp-character-revision-note" rows="4" maxlength="${CHARACTER_REVISION_NOTE_MAX_CHARS}" placeholder="예: 여전히 무뚝뚝하지만 ${escapeHtml(
                    userName
                )}에게는 먼저 애정을 표현하는 일이 늘었어. 갑자기 다정해진 것처럼 바꾸지 말고 서툰 표현의 변화를 반영해 줘."></textarea>
                <button id="rp-character-revision-generate" type="button" class="rp-character-wide-button">요청대로 갱신안 만들기</button>
                <div class="rp-character-revision-auto">
                    <small>방향을 직접 정하지 않고 최근 롤플에서 지속적인 변화만 보수적으로 찾아볼 수도 있습니다.</small>
                    <button id="rp-character-revision-auto-generate" type="button" class="rp-character-wide-button">최근 변화 자동 탐색</button>
                </div>
            </details>
            <div id="rp-character-revision-proposal-container">
                ${renderCharacterBaselineRevisionProposal(
                    characterBaselineState,
                    chatId
                )}
            </div>
            <p class="rp-character-privacy">캐릭터 기준은 진단에 사용됩니다. 최신 캐릭터 전용 앵커가 준비되면 캐릭터 부스팅을 시작해요. 기준 전체는 매번 주입하지 않고 필요한 일회성 보정에만 사용합니다.</p>
            <p class="rp-character-field-guide">📌 전체 다시 요약에서도 유지 · ✏️ 편집 · ↻ 항목만 다시 생성<br>원본에서 수정·재생성하면 원본은 유지되고 새 갱신본으로 저장됩니다.</p>
            <div id="rp-character-baseline-fields" class="rp-character-baseline-fields">
                ${renderCharacterBaselineFields(
                    characterBaselineState.baseline,
                    characterBaselineState.identity,
                    chatId,
                    characterBaselineState.versionId
                )}
            </div>
            <div class="rp-character-field-card rp-character-boost-anchor-card">
                <div class="rp-character-field-header">
                    <strong>🧭 캐릭터 전용 상시 앵커</strong>
                    <div class="rp-character-field-tools">
                        <button id="rp-character-boost-anchor-edit" type="button" class="rp-character-tool-button" title="상시 앵커 직접 편집">✏️</button>
                        <button id="rp-character-boost-anchor-save" type="button" class="rp-character-tool-button" title="편집 내용 저장" hidden>✅</button>
                        <button id="rp-character-boost-anchor-cancel" type="button" class="rp-character-tool-button" title="편집 취소" hidden>✕</button>
                        <button id="rp-character-boost-anchor-regenerate" type="button" class="rp-character-tool-button" title="현재 기준으로 상시 앵커 다시 만들기">↻</button>
                    </div>
                </div>
                <textarea id="rp-character-boost-anchor-text" class="rp-character-field-text" data-identity-key="${escapeHtml(characterBaselineState.identity?.key || "")}" data-character-name="${escapeHtml(characterBaselineState.identity?.name || "")}" data-source-hash="${escapeHtml(characterBaselineState.identity?.sourceHash || "")}" data-chat-id="${escapeHtml(getCurrentChatId())}" data-baseline-version-id="${escapeHtml(characterBaselineState.versionId || "")}" rows="4" maxlength="${CHARACTER_BOOST_ANCHOR_MAX_CHARS}" placeholder="전체 요약을 실행하면 캐릭터별 짧은 앵커가 생성됩니다." readonly>${escapeHtml(getCharacterAnchorDisplayValue(characterBaselineState.baseline))}</textarea>
                <small id="rp-character-boost-anchor-status" class="rp-character-field-save-status">표시 언어와 관계없이 실제 부스팅에는 영문 앵커를 사용합니다.</small>
                <small id="rp-character-boost-anchor-saved-at" class="rp-character-anchor-saved-at"></small>
            </div>
            <div class="rp-character-baseline-actions">
                <button id="rp-character-baseline-generate" type="button" class="rp-character-wide-button">전체 요약하기</button>
                <button id="rp-character-baseline-delete" type="button" class="rp-character-wide-button rp-character-delete-button">선택 버전 삭제</button>
            </div>
        </section>

        <section class="rp-character-audit-card">
            <div class="rp-anchor-title">🔍 캐릭터 진단</div>
            <p class="rp-anchor-help">캐릭터성·캐릭터 해석·능동성·관계 반응·연속성·표현 반복을 최근 캐릭터 응답에서 확인합니다.</p>
            <p class="rp-global-audit-summary">자동 진단 ${auditIntervalLabel} · 확장 설정에서 변경</p>
            <button id="rp-character-manual-audit-btn" type="button" class="menu_button">🔍 지금 진단하기</button>
            <p id="rp-character-audit-count" class="rp-anchor-help"></p>
            <details id="rp-character-last-audit" class="rp-last-audit" hidden>
                <summary>최근 진단 결과</summary>
                <div class="rp-last-audit-body">
                    <p id="rp-character-last-audit-meta" class="rp-last-audit-meta"></p>
                    <div id="rp-character-last-audit-grid" class="rp-audit-status-grid" hidden></div>
                    <div id="rp-character-audit-detail" class="rp-audit-detail" hidden></div>
                    <p id="rp-character-last-audit-correction"></p>
                    <p id="rp-character-last-audit-connection" class="rp-last-audit-connection"></p>
                    <p id="rp-character-last-audit-status" class="rp-last-audit-status" aria-live="polite"></p>
                    <button id="rp-character-cancel-correction" type="button" class="menu_button" hidden>이번 보정 적용 안 하기</button>
                </div>
            </details>
        </section>
        </section>

        <section id="rp-booster-plot-panel" class="rp-booster-tab-panel" role="tabpanel" aria-labelledby="rp-tab-plot" data-tab-panel="plot" hidden>
        <div class="rp-plot-panel-heading">
            <h4>플롯 부스터</h4>
            <button
                id="rp-plot-history-btn"
                type="button"
                class="rp-plot-history-button"
                aria-label="기존 추천 보기"
                aria-controls="rp-plot-history-drawer"
                aria-expanded="false"
                title="기존 추천 보기"
            >
                🕘
                <span id="rp-plot-history-count" class="rp-plot-history-count" ${
                    getPlotHistory().length ? "" : "hidden"
                }>${getPlotHistory().length}</span>
            </button>
        </div>
        <p id="rp-plot-feature-disabled" class="rp-feature-disabled-notice" ${plotFeatureEnabled ? "hidden" : ""}>전역 설정에서 플롯 부스터가 꺼져 있습니다. 생성과 일회성 주입을 사용하지 않아요.</p>
        <div id="rp-plot-history-drawer" class="rp-plot-history-drawer" hidden>
            <div class="rp-plot-history-drawer-head">
                <strong>최근 추천</strong>
                <button
                    id="rp-plot-history-close"
                    type="button"
                    class="rp-plot-history-close"
                    aria-label="기존 추천 닫기"
                >×</button>
            </div>
            <p class="rp-plot-history-help">‘불러오기’를 눌러 추천창에 옮길 수 있어요.</p>
            <div id="rp-plot-history-list"></div>
            <button id="rp-plot-history-clear" type="button" class="menu_button rp-plot-history-clear">
                기록 전체 삭제
            </button>
        </div>
        <p class="rp-event-help">현재 롤플에 맞는 플롯을 생성하거나 내 아이디어를 다듬습니다.</p>
        <details class="rp-automatic-plot-settings">
            <summary>🎁 자동 랜덤박스</summary>
            <div class="rp-automatic-plot-body">
            <label class="rp-settings-check-row"><input id="rp-automatic-plot-enabled" type="checkbox" ${automaticPlot.enabled ? 'checked' : ''}> <span>이 채팅에서 자동 랜덤박스 허용</span></label>
            <p class="rp-settings-help">자동 진단 주기마다 사건이 필요한지 함께 확인합니다. 확인된 장르·캐릭터 문제는 보정을 우선하고, 판단 보류만 있으면 사건 필요성을 별도로 확인합니다. 전개 정체와 삽입 적합성이 확인된 경우에만 일반 랜덤박스를 다음 응답에 1회 반영합니다. 조용한 일상이나 감정 교류가 진행 중이면 넣지 않습니다.</p>
            <p id="rp-automatic-plot-status" aria-live="polite" ${getAutomaticPlotStatusText(automaticPlot) ? '' : 'hidden'}>${escapeHtml(getAutomaticPlotStatusText(automaticPlot))}</p>
            <button id="rp-automatic-plot-cancel" type="button" class="menu_button" hidden>이번 랜덤박스 취소</button>
            </div>
        </details>

        <div class="rp-plot-mode-switch" role="group" aria-label="플롯 생성 방식">
            <button type="button" class="rp-plot-mode-button is-active" data-mode="free" aria-pressed="true">
                🎲 자유 생성
            </button>
            <button type="button" class="rp-plot-mode-button" data-mode="guided" aria-pressed="false">
                ✨ 내 아이디어
            </button>
        </div>

        <div id="rp-plot-category-section">
            <div class="rp-plot-category-heading">
                <div class="rp-plot-section-title">카테고리</div>
                <label class="rp-plot-secret-switch" title="비밀모드 켜기 또는 끄기">
                    <span class="rp-plot-secret-label">🔒 비밀</span>
                    <input id="rp-plot-secret-toggle" type="checkbox" ${
                        plotSecretMode ? "checked" : ""
                    } aria-checked="${plotSecretMode}">
                    <span class="rp-plot-secret-track" aria-hidden="true"></span>
                </label>
            </div>
            <div id="rp-plot-category-grid" class="rp-plot-category-grid">
                ${renderPlotCategoryCards()}
            </div>
            <p id="rp-plot-category-description" class="rp-plot-category-description"></p>

            <details id="rp-custom-plot-editor">
                <summary>➕ 플롯 카테고리 직접 추가</summary>
                <p class="rp-custom-help">추가한 카테고리는 모든 채팅에서 카드로 재사용할 수 있습니다.</p>
                <div class="rp-custom-plot-row">
                    <label for="rp-custom-plot-emoji">
                        이모지 <small>(선택)</small>
                        <input id="rp-custom-plot-emoji" type="text" maxlength="8" placeholder="✨">
                    </label>
                    <label for="rp-custom-plot-name">
                        카테고리 이름
                        <input id="rp-custom-plot-name" type="text" maxlength="40" placeholder="예: 과거의 일">
                    </label>
                </div>
                <label for="rp-custom-plot-direction">생성 방향 <small>(선택)</small></label>
                <textarea id="rp-custom-plot-direction" rows="3" maxlength="500" placeholder="예: 현재 관계나 갈등에 영향을 주는 과거의 사건을 드러낸다."></textarea>
                <button id="rp-custom-plot-add-btn" type="button" class="menu_button">카테고리 추가</button>
                <p id="rp-custom-plot-status" aria-live="polite"></p>
            </details>

            <div id="rp-plot-secret-tools" class="rp-plot-secret-tools" ${
                plotSecretMode ? "" : "hidden"
            }>
                <div class="rp-plot-section-title">깜짝 전개</div>
                <div class="rp-plot-secret-action-grid">
                    <button type="button" id="rp-plot-random-box" class="menu_button rp-secret-action" data-secret-action="random" aria-pressed="false">
                        <span class="rp-secret-action-icon">🎁</span>
                        <span><strong>랜덤박스</strong><small>카테고리와 결과를 숨긴 채 무작위 사건을 전개합니다</small></span>
                    </button>
                    <button type="button" id="rp-plot-crazy-box" class="menu_button rp-secret-action" data-secret-action="crazy" aria-pressed="false">
                        <span class="rp-secret-action-icon">💥</span>
                        <span><strong>미친 랜덤박스</strong><small>현재 흐름과 개연성을 벗어난 예상 밖의 전개까지 허용합니다</small></span>
                    </button>
                    <button type="button" id="rp-character-question" class="menu_button rp-secret-action" data-secret-action="character_question" aria-pressed="false">
                        <span class="rp-secret-action-icon">❓</span>
                        <span><strong>${escapeHtml(characterName)}의 질문박스</strong><small>${escapeHtml(
                            characterName
                        )}가 ${escapeHtml(userName)}에게 무작위 질문을 던집니다</small></span>
                    </button>
                </div>
            </div>
        </div>

        <div id="rp-plot-idea-wrap" hidden>
            <label for="rp-plot-idea">원하는 플롯의 키워드나 대략적인 내용</label>
            <textarea id="rp-plot-idea" rows="4" maxlength="2000" placeholder="예: ${escapeHtml(
                characterName
            )}이 ${escapeHtml(
                userName
            )}에게 숨기던 사실을 털어놓으려 하지만 예상치 못한 방해가 생긴다. 핵심 의도와 현재 관계를 유지해 자연스럽게 다듬어 줘."></textarea>
        </div>

        <button id="rp-event-generate-btn" type="button" class="menu_button">🎲 사건 생성</button>
        <p id="rp-event-status" aria-live="polite">${
            plotSecretMode
                ? "선택한 카테고리에 맞는 사건을 플롯 공개 없이 바로 전개합니다."
                : "결과는 아래에 표시됩니다."
        }</p>

        <div id="rp-event-result-wrap" hidden>
            <label for="rp-event-result">플롯 결과 <small>(직접 수정 가능)</small></label>
            <textarea id="rp-event-result" rows="5"></textarea>

            <div class="rp-event-actions">
                <button id="rp-event-refine-btn" type="button" class="menu_button rp-event-result-action">🔄 다듬기</button>
                <button id="rp-event-new-direction-btn" type="button" class="menu_button rp-event-result-action">✨ 새 방향</button>
                <button id="rp-event-insert-btn" type="button" class="menu_button rp-event-result-action">✍️ 입력창에 넣기</button>
                <button id="rp-event-inject-btn" type="button" class="menu_button rp-event-result-action">⚡ 주입 후 AI 응답 생성</button>
                <button id="rp-event-clear-btn" type="button" class="menu_button rp-event-result-action rp-event-clear-action">🗑️ 결과 지우기</button>
            </div>
        </div>
        </section>
    </div>`;
}

// @source-order 370
function openBoosterPopup() {
    console.log(`[${MODULE_NAME}] booster button clicked`);

    let context;
    try {
        context = getContext();
    } catch (err) {
        console.error(`[${MODULE_NAME}] getContext() threw:`, err);
        recordStoryBoosterError(err, {
            task: "booster_popup_open",
            stage: "context_access",
        });
        alert("getContext() 실패 — 콘솔을 확인하세요.");
        return;
    }

    console.log(`[${MODULE_NAME}] context.callGenericPopup exists?`, typeof context?.callGenericPopup);
    console.log(`[${MODULE_NAME}] window.callPopup exists?`, typeof window.callPopup);

    const popupInstanceId = `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 9)}`;
    notifyCharacterCardChangeIfNeeded();
    const html = renderBoosterPopupHtml(popupInstanceId);
    let popupLifecycle = null;

    try {
        if (context.callGenericPopup) {
            popupLifecycle = context.callGenericPopup(
                html,
                context.POPUP_TYPE.TEXT,
                "",
                { wide: true, large: false }
            );
        } else if (window.callPopup) {
            popupLifecycle = window.callPopup(html, "text");
        } else {
            console.error(`[${MODULE_NAME}] no popup API found on context or window`);
            recordStoryBoosterError(new Error("SillyTavern popup API not found"), {
                task: "booster_popup_open",
                stage: "popup_api",
            });
            alert("팝업 API를 찾을 수 없습니다. ST 버전을 확인하세요.");
            return;
        }
        console.log(`[${MODULE_NAME}] popup call issued`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] popup call threw:`, err);
        recordStoryBoosterError(err, {
            task: "booster_popup_open",
            stage: "popup_call",
        });
        alert("팝업 호출 중 오류 발생 — 콘솔을 확인하세요.");
        return;
    }

    const releasePopupReference = () => {
        if (
            runtime.activeBoosterPopupRoot?.dataset?.storyboosterPopupInstance ===
            popupInstanceId
        ) {
            runtime.activeBoosterPopupRoot = null;
        }
    };
    if (popupLifecycle && typeof popupLifecycle.then === "function") {
        Promise.resolve(popupLifecycle).then(
            releasePopupReference,
            releasePopupReference
        );
    }

    // Some mobile builds attach the popup DOM asynchronously. Retry briefly
    // instead of assuming one fixed render delay.
    const wirePopupControls = (attempt = 0) => {
        const popupRoot = document.querySelector(
            `[data-storybooster-popup-instance="${popupInstanceId}"]`
        );
        if (!popupRoot) {
            if (attempt < 20) {
                setTimeout(() => wirePopupControls(attempt + 1), 50);
                return;
            }
            console.error(`[${MODULE_NAME}] #rp-booster-popup not found after popup call`);
            recordStoryBoosterError(
                new Error("StoryBooster popup DOM was not found after opening"),
                {
                    task: "booster_popup_open",
                    stage: "popup_dom_binding",
                }
            );
            return;
        }
        runtime.activeBoosterPopupRoot = popupRoot;
        console.log(`[${MODULE_NAME}] wiring up popup controls`);

        const tabList = popupRoot.querySelector(".rp-booster-tabs");
        popupRoot.querySelectorAll(".rp-booster-tab").forEach((button) => {
            button.addEventListener("click", () => activateBoosterTab(button.dataset.tab));
        });
        tabList?.addEventListener("keydown", handleBoosterTabKeydown);
        activateBoosterTab("genre");

        popupRoot.querySelector('#rp-automatic-plot-enabled')?.addEventListener('change', event => {
            setAutomaticPlotEnabled(event.currentTarget.checked);
            updateGenreAnchorPanel();
        });

        // Primary/support genre selectors
        [
            popupRoot.querySelector("#rp-primary-genre"),
            popupRoot.querySelector("#rp-support-genre"),
        ].forEach((select) => {
            select?.addEventListener("change", syncGenreSelectionFromControls);
        });

        popupRoot
            .querySelector("#rp-manual-audit-btn")
            ?.addEventListener("click", () => runManualGenreAudit("genre"));
        popupRoot
            .querySelector("#rp-cancel-audit-correction")
            ?.addEventListener("click", () =>
                cancelPendingGenreCorrection("genre")
            );
        popupRoot
            .querySelector("#rp-recommend-genre-btn")
            ?.addEventListener("click", generateGenreRecommendation);
        popupRoot
            .querySelector("#rp-recommend-apply-btn")
            ?.addEventListener("click", applyGenreRecommendation);
        popupRoot.querySelector("#rp-recommend-cancel-btn")?.addEventListener("click", cancelGenreRecommendation);
        popupRoot.querySelector("#rp-automatic-plot-cancel")?.addEventListener("click", cancelPreparedAutomaticPlot);
        updateAutomaticPlotStatus();
        popupRoot
            .querySelector("#rp-custom-genre-add-btn")
            ?.addEventListener("click", addCustomGenre);
        popupRoot
            .querySelector("#rp-character-baseline-generate")
            ?.addEventListener("click", () => {
                const current = getCurrentCharacterBaseline();
                const existing = current.baseline;
                if (
                    !existing ||
                    window.confirm(
                        current.isOriginal
                            ? "원본은 유지하고, 고정하지 않은 항목을 새로 요약한 갱신본을 만들까요?"
                            : "선택한 갱신본의 고정하지 않은 항목을 새 요약으로 바꿀까요?"
                    )
                ) {
                    generateCharacterBaseline();
                }
            });
        popupRoot
            .querySelector("#rp-character-baseline-delete")
            ?.addEventListener("click", deleteCharacterBaseline);
        popupRoot
            .querySelector("#rp-character-baseline-version")
            ?.addEventListener("change", (event) => {
                selectCharacterBaselineVersion(event.currentTarget.value);
            });
        wireBaselineBackupControls(popupRoot);
        popupRoot
            .querySelector("#rp-character-version-rename")
            ?.addEventListener(
                "click",
                renameCurrentCharacterBaselineVersion
            );
        popupRoot
            .querySelector("#rp-character-version-delete")
            ?.addEventListener(
                "click",
                deleteCurrentCharacterBaselineVersion
            );
        popupRoot
            .querySelector("#rp-character-version-duplicate")
            ?.addEventListener(
                "click",
                duplicateCurrentCharacterBaselineVersion
            );
        popupRoot
            .querySelector("#rp-character-revision-generate")
            ?.addEventListener("click", () =>
                generateCharacterBaselineRevisionProposal({ automatic: false })
            );
        popupRoot
            .querySelector("#rp-character-revision-auto-generate")
            ?.addEventListener("click", () =>
                generateCharacterBaselineRevisionProposal({ automatic: true })
            );
        popupRoot
            .querySelector("#rp-character-card-reanalyze")
            ?.addEventListener("click", () => {
                if (
                    window.confirm(
                        getCurrentCharacterBaseline().isOriginal
                            ? "변경된 캐릭터 카드로 새 갱신본과 앵커를 만들까요? 원본은 유지됩니다."
                            : "변경된 캐릭터 카드로 선택한 갱신본과 앵커를 다시 만들까요?"
                    )
                ) {
                    generateCharacterBaseline();
                }
            });
        popupRoot
            .querySelector("#rp-character-card-keep")
            ?.addEventListener("click", acknowledgeCharacterCardChange);
        popupRoot
            .querySelector("#rp-character-boost-anchor-edit")
            ?.addEventListener("click", beginCharacterBoostAnchorEditing);
        popupRoot
            .querySelector("#rp-character-boost-anchor-save")
            ?.addEventListener("click", saveEditedCharacterBoostAnchor);
        popupRoot
            .querySelector("#rp-character-boost-anchor-cancel")
            ?.addEventListener("click", cancelCharacterBoostAnchorEditing);
        popupRoot
            .querySelector("#rp-character-boost-anchor-regenerate")
            ?.addEventListener("click", () => {
                const anchorText = getBoosterElement(
                    "rp-character-boost-anchor-text"
                );
                const hasUnsavedEdit = Boolean(
                    anchorText && !anchorText.readOnly
                );
                if (hasUnsavedEdit) {
                    if (
                        !window.confirm(
                            getCurrentCharacterBaseline().isOriginal
                                ? "저장하지 않은 편집 내용을 버리고, 원본을 유지한 채 새 앵커 갱신본을 만들까요?"
                                : "저장하지 않은 편집 내용을 버리고 앵커를 다시 만들까요?"
                        )
                    ) {
                        return;
                    }
                    cancelCharacterBoostAnchorEditing();
                    regenerateCharacterBoostAnchor();
                    return;
                }
                if (
                    window.confirm(
                        getCurrentCharacterBaseline().isOriginal
                            ? "원본은 유지하고, 새 앵커가 포함된 갱신본을 만들까요?"
                            : "현재 캐릭터 기준으로 캐릭터 앵커를 다시 만들까요?"
                    )
                ) {
                    regenerateCharacterBoostAnchor();
                }
            });
        popupRoot
            .querySelector("#rp-character-manual-audit-btn")
            ?.addEventListener("click", () =>
                runManualGenreAudit("character")
            );
        popupRoot
            .querySelector("#rp-character-cancel-correction")
            ?.addEventListener("click", () =>
                cancelPendingGenreCorrection("character")
            );
        popupRoot.addEventListener("click", (event) => {
            const revisionApply = event.target.closest(
                "#rp-character-revision-apply"
            );
            if (revisionApply) {
                applyCharacterBaselineRevisionProposal();
                return;
            }
            const revisionCancel = event.target.closest(
                "#rp-character-revision-cancel"
            );
            if (revisionCancel) {
                cancelCharacterBaselineRevisionProposal(
                    getCurrentCharacterIdentity()?.key || "",
                    String(getCurrentChatId())
                );
                return;
            }
            const auditStatusItem = event.target.closest(
                ".rp-audit-status-item[data-audit-scope][data-audit-code]"
            );
            if (auditStatusItem) {
                selectAuditDetail(
                    auditStatusItem.dataset.auditScope,
                    auditStatusItem.dataset.auditCode
                );
                return;
            }
            const manualAuditBoostButton = event.target.closest(
                ".rp-audit-manual-boost[data-audit-code]"
            );
            if (manualAuditBoostButton) {
                const scope = manualAuditBoostButton.dataset.auditScope;
                const state = ensureChatState();
                toggleManualAuditBoost(
                    manualAuditBoostButton.dataset.auditCode,
                    getAuditRecordForScope(state, scope)
                );
                return;
            }
            const characterPinButton = event.target.closest(
                ".rp-character-pin-button"
            );
            if (characterPinButton) {
                toggleCharacterFieldPin(characterPinButton.dataset.fieldId);
                return;
            }
            const characterEditButton = event.target.closest(
                ".rp-character-edit-button"
            );
            if (characterEditButton) {
                toggleCharacterFieldEditing(
                    characterEditButton.dataset.fieldId,
                    characterEditButton
                );
                return;
            }
            const characterRegenerateButton = event.target.closest(
                ".rp-character-regenerate-button"
            );
            if (characterRegenerateButton) {
                const fieldId = characterRegenerateButton.dataset.fieldId;
                const definition = getCharacterBaselineFieldDefinition(fieldId);
                const current = getCurrentCharacterBaseline();
                const field = current.baseline?.fields?.[fieldId];
                if (
                    !field?.text ||
                    window.confirm(
                        current.isOriginal
                            ? `원본은 유지하고 ${definition?.label || "이 항목"}을 새로 요약한 갱신본을 만들까요?`
                            : `${definition?.label || "이 항목"}을 새 요약으로 바꿀까요?`
                    )
                ) {
                    generateCharacterBaseline(fieldId);
                }
                return;
            }
            const historyLoadButton = event.target.closest(
                ".rp-plot-history-load"
            );
            if (historyLoadButton) {
                loadPlotHistoryItem(historyLoadButton.dataset.historyId);
                return;
            }
            const historyDeleteButton = event.target.closest(
                ".rp-plot-history-delete"
            );
            if (historyDeleteButton) {
                deletePlotHistoryItem(historyDeleteButton.dataset.historyId);
                return;
            }

            const deleteButton = event.target.closest(".rp-custom-genre-delete");
            if (deleteButton) deleteCustomGenre(deleteButton.dataset.id);

            const categoryDeleteButton = event.target.closest(
                ".rp-plot-category-delete"
            );
            if (categoryDeleteButton) {
                deleteCustomPlotCategory(categoryDeleteButton.dataset.id);
                return;
            }
            const categoryButton = event.target.closest(
                ".rp-plot-category-card"
            );
            if (categoryButton) {
                selectPlotCategory(categoryButton.dataset.id);
                clearSecretPlotAction();
                updatePlotGenerationPendingUi();
            }
        });
        popupRoot.addEventListener("input", (event) => {
            captureCharacterRevisionReview(event.target);
            const textarea = event.target.closest(".rp-character-field-text");
            if (!textarea || textarea.readOnly) return;
            scheduleCharacterBaselineAutosave(textarea);
        });
        popupRoot.addEventListener("change", (event) => {
            captureCharacterRevisionReview(event.target);
        });
        renderCustomGenreList();
        updateGenreAnchorPanel();

        // AI event generator controls
        popupRoot.querySelectorAll(".rp-plot-mode-button").forEach((button) => {
            button.addEventListener("click", () =>
                activatePlotGenerationMode(button.dataset.mode)
            );
        });
        popupRoot
            .querySelector("#rp-custom-plot-add-btn")
            ?.addEventListener("click", addCustomPlotCategory);
        popupRoot
            .querySelector("#rp-plot-secret-toggle")
            ?.addEventListener("change", (event) =>
                setPlotSecretMode(event.currentTarget.checked)
            );
        popupRoot
            .querySelector("#rp-plot-random-box")
            ?.addEventListener("click", () => selectSecretPlotAction("random"));
        popupRoot
            .querySelector("#rp-plot-crazy-box")
            ?.addEventListener("click", () => selectSecretPlotAction("crazy"));
        popupRoot
            .querySelector("#rp-character-question")
            ?.addEventListener("click", () =>
                selectSecretPlotAction("character_question")
            );
        popupRoot
            .querySelector("#rp-event-generate-btn")
            ?.addEventListener("click", runSelectedPlotGenerationAction);
        popupRoot
            .querySelector("#rp-event-refine-btn")
            ?.addEventListener("click", () => generateEventCandidate("refine"));
        popupRoot
            .querySelector("#rp-event-new-direction-btn")
            ?.addEventListener("click", () =>
                generateEventCandidate("new_direction")
            );
        popupRoot
            .querySelector("#rp-event-insert-btn")
            ?.addEventListener("click", insertEventIntoComposer);
        popupRoot
            .querySelector("#rp-event-inject-btn")
            ?.addEventListener("click", () => injectEventAndGenerateReply());
        popupRoot
            .querySelector("#rp-event-clear-btn")
            ?.addEventListener("click", clearGeneratedEventResult);
        popupRoot
            .querySelector("#rp-plot-history-btn")
            ?.addEventListener("click", () => togglePlotHistoryDrawer());
        popupRoot
            .querySelector("#rp-plot-history-close")
            ?.addEventListener("click", () =>
                togglePlotHistoryDrawer(false)
            );
        popupRoot
            .querySelector("#rp-plot-history-clear")
            ?.addEventListener("click", clearPlotHistory);
        popupRoot
            .querySelector("#rp-event-result")
            ?.addEventListener("input", (event) => {
                delete event.currentTarget.dataset.historyId;
                capturePlotModeDraft(popupRoot.dataset.plotMode || "free");
                updatePlotHistoryUI();
            });
        activatePlotGenerationMode("free");
        selectPlotCategory(getSelectedPlotCategory().id);
        updatePlotHistoryUI();
        updatePlotGenerationPendingUi();
    };
    wirePopupControls();
}

// @source-order 371
function addWandMenuButton() {
    if (document.getElementById("rp-open-booster")) return true; // already attached

    const menu = document.getElementById("extensionsMenu");
    if (!menu) return false; // not in the DOM yet

    const button = document.createElement("div");
    button.id = "rp-open-booster";
    button.className = "list-group-item flex-container flexGap5 interactable";
    button.tabIndex = 0;
    button.innerHTML = `
        <div class="fa-solid fa-fw fa-dice extensionsMenuExtensionButton"></div>
        스토리부스터
    `;
    // no listener attached here on purpose — see delegated listener in init,
    // which survives even if ST re-renders/replaces this element later.

    menu.appendChild(button);
    console.log(`[${MODULE_NAME}] wand menu button attached`);
    return true;
}

// @source-order 372
function attachWandMenuButtonWithRetry() {
    let attempts = 0;
    const maxAttempts = 40; // ~20s at 500ms
    const interval = setInterval(() => {
        attempts++;
        if (addWandMenuButton() || attempts >= maxAttempts) {
            clearInterval(interval);
            if (attempts >= maxAttempts) {
                console.error(`[${MODULE_NAME}] could not find #extensionsMenu after ${maxAttempts} attempts`);
            }
        }
    }, 500);
}

// @source-order 373
async function refreshConnectionProfileSelects() {
    const settings = ensureModuleSettings();
    const targets = [
        {
            selectId: "rp-analysis-profile",
            statusId: "rp-analysis-profile-status",
            settingKey: "analysisProfileId",
            defaultLabel: "현재 채팅 연결 사용 · 권장",
            readyHelp:
                "장르 추천·진단과 캐릭터 기준·앵커 생성에 사용합니다.",
        },
        {
            selectId: "rp-plot-profile",
            statusId: "rp-plot-profile-status",
            settingKey: "plotProfileId",
            defaultLabel: "현재 채팅 연결 사용 · 기본",
            readyHelp:
                "플롯 후보 생성에만 사용합니다. 실제 롤플 응답 연결은 바뀌지 않습니다.",
        },
    ];
    const activeTargets = targets
        .map((target) => ({
            ...target,
            select: document.getElementById(target.selectId),
            status: document.getElementById(target.statusId),
        }))
        .filter((target) => target.select);
    if (!activeTargets.length) return;

    activeTargets.forEach((target) => {
        const defaultOption = document.createElement("option");
        defaultOption.value = "";
        defaultOption.textContent = target.defaultLabel;
        target.select.replaceChildren(defaultOption);
    });

    try {
        const service = getConnectionProfileService();
        if (!service || typeof service.getSupportedProfiles !== "function") {
            throw new Error("연결 프로필 기능을 찾을 수 없음");
        }
        const profiles = [...(await service.getSupportedProfiles())].sort((a, b) =>
            String(a?.name || "").localeCompare(String(b?.name || ""))
        );

        activeTargets.forEach((target) => {
            for (const profile of profiles) {
                if (!profile?.id) continue;
                const option = document.createElement("option");
                option.value = profile.id;
                option.textContent = profile.model
                    ? `${profile.name || "이름 없는 프로필"} · ${profile.model}`
                    : profile.name || "이름 없는 프로필";
                target.select.appendChild(option);
            }
            const selectedId = String(settings[target.settingKey] || "");
            const selectedExists =
                !selectedId ||
                profiles.some(
                    (profile) => String(profile.id) === selectedId
                );
            if (!selectedExists) {
                const missingOption = document.createElement("option");
                missingOption.value = selectedId;
                missingOption.textContent = "선택한 프로필을 찾을 수 없음";
                target.select.appendChild(missingOption);
            }
            target.select.value = selectedId;
            target.select.disabled = false;
            if (target.status) {
                target.status.textContent = !selectedExists
                    ? "선택한 프로필이 없습니다. 다른 프로필이나 현재 채팅 연결을 선택해 주세요."
                    : profiles.length
                      ? target.readyHelp
                      : "저장된 호환 연결 프로필이 없어 현재 채팅 연결을 사용합니다.";
            }
        });
    } catch (err) {
        console.info(`[${MODULE_NAME}] connection profiles unavailable:`, err);
        activeTargets.forEach((target) => {
            const selectedId = String(settings[target.settingKey] || "");
            if (selectedId) {
                const unavailableOption = document.createElement("option");
                unavailableOption.value = selectedId;
                unavailableOption.textContent = "선택한 프로필을 확인할 수 없음";
                target.select.appendChild(unavailableOption);
                target.select.value = selectedId;
            }
            target.select.disabled = false;
            if (target.status) {
                target.status.textContent =
                    "연결 프로필 기능을 확인할 수 없습니다. 기본 연결을 쓰려면 첫 항목을 선택해 주세요.";
            }
        });
    }
}

// @source-order 374
function addExtensionSettingsPanel() {
    if (document.getElementById("rp-storybooster-settings")) return true;

    const settingsRoot =
        document.getElementById("extensions_settings2") ||
        document.getElementById("extensions_settings");
    if (!settingsRoot) return false;

    const settings = ensureModuleSettings();
    const auditIntervalOptions = [
        `<option value="0" ${settings.auditInterval === 0 ? "selected" : ""}>자동 진단 끄기 · 추가 호출 없음</option>`,
        ...Array.from(
            { length: MAX_AUDIT_INTERVAL - MIN_AUDIT_INTERVAL + 1 },
            (_, index) => index + MIN_AUDIT_INTERVAL
        ).map(
            (interval) =>
                `<option value="${interval}" ${
                    settings.auditInterval === interval ? "selected" : ""
                }>${interval}회마다${
                    interval === DEFAULT_AUDIT_INTERVAL ? " · 기본" : ""
                }</option>`
        ),
    ].join("");
    const panel = document.createElement("div");
    panel.id = "rp-storybooster-settings";
    panel.className = "extension_container";
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b data-rp-debug-entry tabindex="0" role="button" aria-label="스토리부스터">📖 스토리부스터</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="rp-settings-stack">
                    <section class="rp-settings-card">
                        <div class="rp-settings-card-title">사용 기능</div>
                        <div class="rp-feature-toggle-grid">
                            <label><input type="checkbox" data-rp-feature="genre" ${settings.enabledFeatures.genre ? "checked" : ""}> <span>장르 부스터</span></label>
                            <label><input type="checkbox" data-rp-feature="character" ${settings.enabledFeatures.character ? "checked" : ""}> <span>캐릭터 부스터</span></label>
                            <label><input type="checkbox" data-rp-feature="plot" ${settings.enabledFeatures.plot ? "checked" : ""}> <span>플롯 부스터</span></label>
                        </div>
                        <small class="rp-settings-help">끄면 저장된 설정은 유지하면서 해당 기능의 주입과 보조 AI 호출을 중지합니다.</small>
                    </section>

                    <section class="rp-settings-card">
                        <div class="rp-settings-card-title">연결 프로필</div>
                        <div class="rp-settings-field">
                            <label for="rp-analysis-profile">장르/캐릭터 진단 프로필</label>
                            <select id="rp-analysis-profile">
                                <option value="">현재 채팅 연결 사용 · 권장</option>
                            </select>
                            <small id="rp-analysis-profile-status" class="rp-settings-help">저장된 연결 프로필을 불러오는 중이에요…</small>
                        </div>
                        <div class="rp-settings-field">
                            <label for="rp-plot-profile">플롯 프로필</label>
                            <select id="rp-plot-profile">
                                <option value="">현재 채팅 연결 사용 · 기본</option>
                            </select>
                            <small id="rp-plot-profile-status" class="rp-settings-help">저장된 연결 프로필을 불러오는 중이에요…</small>
                        </div>
                    </section>

                    <section class="rp-settings-card rp-jev-settings-card">
                        <div class="rp-settings-card-title">Jev 진단 · 선택 기능</div>
                        <p class="rp-settings-help">Jev 사용 시 진단에 필요한 롤플 내용과 기준이 Jev로 전송되며, API 비용이 발생합니다.</p>
                        <label class="rp-settings-check-row"><input id="rp-jev-enabled" type="checkbox" ${settings.jevEnabled ? 'checked' : ''}> <span>안내에 동의하고 자동·수동 진단에 Jev 사용</span></label>
                        <div class="rp-settings-field rp-jev-key-field">
                        <label for="rp-jev-key">Jev API 키</label>
                        <input id="rp-jev-key" type="password" autocomplete="off" spellcheck="false" maxlength="512" placeholder="${hasJevSessionKey() ? '키 입력됨 · 변경할 키만 입력' : '키 입력'}">
                        </div>
                        <div class="rp-jev-key-actions">
                            <button id="rp-jev-key-apply" type="button" class="menu_button">키 저장</button>
                            <button id="rp-jev-test" type="button" class="menu_button">연결 테스트</button>
                            <button id="rp-jev-key-delete" type="button" class="menu_button">키 삭제</button>
                        </div>
                        <p id="rp-jev-status" aria-live="polite">${escapeHtml(getJevConnectionStatus())}</p>
                        <small class="rp-settings-help">저장된 키는 새로고침 후 자동으로 불러옵니다. 연결 테스트 없이 진단에 사용할 수 있습니다. 키 미입력·Jev 사용 해제·요청 실패 시 기존 진단을 사용합니다. 판단 이유와 보정문은 진단 프로필의 모델로 작성합니다.</small>
                    </section>

                    <section class="rp-settings-card">
                        <div class="rp-settings-card-title">자동 진단</div>
                        <div class="rp-settings-field">
                            <label for="rp-global-audit-interval">자동 진단 주기</label>
                            <select id="rp-global-audit-interval">${auditIntervalOptions}</select>
                            <small class="rp-settings-help">기본 ${DEFAULT_AUDIT_INTERVAL}회 · 활성화된 장르·캐릭터와 허용한 자동 플롯을 함께 확인합니다. Jev는 근거 확인에 추가 요청을 사용할 수 있습니다. 진행 횟수와 결과는 채팅별로 저장돼요.</small>
                        </div>
                    </section>

                    <section class="rp-settings-card">
                        <div class="rp-settings-card-title">캐릭터 카드</div>
                        <label class="rp-settings-check-row">
                            <input id="rp-character-card-change-detection" type="checkbox" ${settings.characterCardChangeDetection ? "checked" : ""}>
                            <span>캐릭터 시트 변경 알림</span>
                        </label>
                        <small class="rp-settings-help">설명·성격·대화 예시가 변경되면 기준 재확인을 안내합니다. 기존 부스팅은 중단하지 않으며 AI 호출도 발생하지 않습니다.</small>
                    </section>

                    <section class="rp-settings-card">
                        <div class="rp-settings-card-title">생성 설정</div>
                        <div class="rp-settings-field">
                            <label for="rp-plot-max-tokens">플롯 생성 토큰</label>
                            <input id="rp-plot-max-tokens" type="number" min="${MIN_PLOT_MAX_TOKENS}" max="${MAX_PLOT_MAX_TOKENS}" step="100" value="${settings.plotMaxTokens}">
                            <small class="rp-settings-help">기본 ${DEFAULT_PLOT_MAX_TOKENS} · 설정 가능 범위 ${MIN_PLOT_MAX_TOKENS}~${MAX_PLOT_MAX_TOKENS} · 결과가 실제로 잘린 경우에만 한 번 자동 확장합니다.</small>
                        </div>
                        <div class="rp-settings-field">
                            <label for="rp-output-language">출력 언어</label>
                            <select id="rp-output-language">
                                <option value="ko" ${settings.outputLanguage === "ko" ? "selected" : ""}>한국어 · 기본</option>
                                <option value="en" ${settings.outputLanguage === "en" ? "selected" : ""}>English</option>
                            </select>
                            <small class="rp-settings-help">플롯 후보, 장르 추천 이유, 캐릭터 기준 생성에 적용합니다. 내부 명령은 영어로 유지됩니다.</small>
                        </div>
                    </section>

                    <section class="rp-settings-card">
                        <div class="rp-settings-card-title">기타</div>
                        <div class="rp-settings-tool-grid">
                            <button id="rp-view-injection-prompt" type="button" class="menu_button">📄 주입 프롬프트</button>
                            <button id="rp-view-error-log" type="button" class="menu_button">
                                🐞 오류 진단 로그
                                <span id="rp-error-log-count" class="rp-settings-count-badge" hidden>0</span>
                            </button>
                        </div>
                        <small class="rp-settings-help">문제가 발생하면 오류 진단 로그를 복사해 문의해 주세요.</small>
                    </section>
                </div>
            </div>
        </div>
    `;
    settingsRoot.appendChild(panel);

    const keyInput = panel.querySelector('#rp-jev-key');
    const jevStatus = panel.querySelector('#rp-jev-status');
    const updateJevStatus = () => { if (jevStatus) jevStatus.textContent = getJevConnectionStatus(); updateJevConnectionBadges(); };
    let keyBusy = false;
    const setKeyBusy = busy => {
        keyBusy = busy;
        for (const id of ['#rp-jev-key-apply', '#rp-jev-key-delete', '#rp-jev-test']) {
            const button = panel.querySelector(id); if (button) button.disabled = busy;
        }
    };
    const applyKey = async () => {
        const value = keyInput?.value || '';
        if (keyInput) keyInput.value = '';
        if (!value.trim()) return true;
        try { return await saveJevKey(value); }
        catch { return false; }
        finally {
            if (keyInput) keyInput.placeholder = hasJevSessionKey() ? '키 저장됨 · 변경할 키만 입력' : '키 입력';
            cancelAutomaticPlot(); updateJevStatus();
        }
    };
    panel.querySelector('#rp-jev-key-apply')?.addEventListener('click', async () => {
        if (keyBusy) return;
        setKeyBusy(true);
        try { await applyKey(); } finally { setKeyBusy(false); updateJevStatus(); }
    });
    panel.querySelector('#rp-jev-key-delete')?.addEventListener('click', async () => {
        if (keyBusy) return;
        setKeyBusy(true); cancelAutomaticPlot();
        if (keyInput) { keyInput.value = ''; keyInput.placeholder = '키 입력'; }
        try { await deleteJevKey(); } catch { /* Safe status includes storage failure. */ }
        finally { setKeyBusy(false); updateJevStatus(); }
    });
    panel.querySelector('#rp-jev-enabled')?.addEventListener('change', async event => {
        const enabled = event.currentTarget.checked;
        if (!enabled && keyInput) keyInput.value = '';
        setJevUsageConsent(enabled);
        cancelAutomaticPlot(); saveSettingsDebounced(); updateJevStatus();
        if (enabled && !hasJevSessionKey()) { await restoreJevKey(); updateJevStatus(); }
    });
    panel.querySelector('#rp-jev-test')?.addEventListener('click', async () => {
        if (keyBusy) return;
        setKeyBusy(true);
        try { if (await applyKey()) await testJevConnection(); }
        catch { /* Client exposes only sanitized status. */ }
        finally { setKeyBusy(false); updateJevStatus(); }
    });

    panel.querySelectorAll("[data-rp-feature]").forEach((checkbox) => {
        checkbox.addEventListener("change", (event) =>
            changeBoosterFeature(
                event.currentTarget.dataset.rpFeature,
                event.currentTarget.checked
            )
        );
    });

    panel
        .querySelector("#rp-global-audit-interval")
        ?.addEventListener("change", (event) =>
            changeGlobalAuditInterval(event.currentTarget.value)
        );
    panel
        .querySelector("#rp-character-card-change-detection")
        ?.addEventListener("change", (event) => {
            ensureModuleSettings().characterCardChangeDetection =
                event.currentTarget.checked;
            saveSettingsDebounced();
            if (event.currentTarget.checked) {
                notifyCharacterCardChangeIfNeeded();
            }
            safelyUpdateCharacterBoosterPanel("캐릭터 시트 변경 알림 설정");
        });
    [
        ["#rp-analysis-profile", "analysisProfileId"],
        ["#rp-plot-profile", "plotProfileId"],
    ].forEach(([selector, settingKey]) => {
        panel.querySelector(selector)?.addEventListener("change", (event) => {
            cancelAutomaticPlot(settingKey === 'analysisProfileId' ? 'profile_changed' : 'plot_state_changed');
            ensureModuleSettings()[settingKey] = String(
                event.currentTarget.value || ""
            );
            saveSettingsDebounced();
        });
    });
    panel
        .querySelector("#rp-plot-max-tokens")
        ?.addEventListener("change", (event) => {
            cancelAutomaticPlot();
            const rawValue = Number(event.currentTarget.value);
            const roundedValue = Math.round(rawValue);
            const value =
                Number.isSafeInteger(roundedValue) &&
                roundedValue >= MIN_PLOT_MAX_TOKENS
                    ? Math.min(roundedValue, MAX_PLOT_MAX_TOKENS)
                    : DEFAULT_PLOT_MAX_TOKENS;
            ensureModuleSettings().plotMaxTokens = value;
            event.currentTarget.value = String(value);
            saveSettingsDebounced();
        });
    panel
        .querySelector("#rp-output-language")
        ?.addEventListener("change", (event) => {
            cancelAutomaticPlot('language_changed');
            const language = String(event.currentTarget.value || "ko");
            ensureModuleSettings().outputLanguage = ["ko", "en"].includes(
                language
            )
                ? language
                : "ko";
            saveSettingsDebounced();
            safelyUpdateCharacterBoosterPanel("출력 언어 변경");
            toastr?.info?.(
                "저장된 캐릭터 기준과 앵커는 자동 번역하지 않습니다. 다시 요약하거나 갱신하면 현재 출력 언어로 표시돼요."
            );
        });
    panel
        .querySelector("#rp-view-injection-prompt")
        ?.addEventListener("click", openCurrentInjectionPromptViewer);
    panel
        .querySelector("#rp-view-error-log")
        ?.addEventListener("click", openStoryBoosterErrorLog);

    wireDeveloperModeEntry(panel);
    refreshConnectionProfileSelects();
    refreshStoryBoosterErrorLogBadge();
    return true;
}

// @source-order 375
function attachExtensionSettingsWithRetry() {
    let attempts = 0;
    const maxAttempts = 40;
    const interval = setInterval(() => {
        attempts += 1;
        if (addExtensionSettingsPanel() || attempts >= maxAttempts) {
            clearInterval(interval);
            if (attempts >= maxAttempts) {
                console.error(
                    `[${MODULE_NAME}] could not find extension settings after ${maxAttempts} attempts`
                );
            }
        }
    }, 500);
}

export { activateBoosterTab, addExtensionSettingsPanel, addWandMenuButton, attachExtensionSettingsWithRetry, attachWandMenuButtonWithRetry, handleBoosterTabKeydown, openBoosterPopup, refreshConnectionProfileSelects, renderBoosterPopupHtml };
