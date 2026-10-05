import { isDeveloperModeUnlocked } from '../core/debug-mode.js';
// StoryBooster: ui/tools.js
import { MODULE_NAME } from "../core/constants.js";
import { resolveRoleMacrosForDisplay } from "../core/context.js";
import { clearStoryBoosterErrorLog, formatStoryBoosterErrorEntry, readStoryBoosterErrorLog, recordStoryBoosterError } from "../core/diagnostics.js";
import { escapeHtml } from "../core/dom.js";
import { runtime } from "../core/runtime.js";
import { getContext } from "../core/sillytavern.js";
import { auditRunStatusText, buildAuditRunReport, clearAuditRuns } from '../core/audit-run-trace.js';

export function refreshAuditRunTraceUi() {
    const status = document.getElementById('rp-audit-run-status');
    if (status) status.textContent = auditRunStatusText();
    for (const textarea of document.querySelectorAll('[data-rp-audit-run-report]')) textarea.value = buildAuditRunReport();
}

export function openAuditRunTraceLog() {
    if (!isDeveloperModeUnlocked()) { toastr?.info?.('개발자 모드를 먼저 열어 주세요.'); return; }
    const popupId = `rp-audit-run-log-${Date.now()}`;
    const html = `<div id="${popupId}" class="rp-tool-popup">
        <h3>🔎 진단 진행 기록</h3>
        <p class="rp-tool-popup-help">자동·수동 진단의 단계, 소요 시간, 재시도와 종료 이유를 확인합니다. API 키와 롤플 원문은 포함하지 않습니다. 이 탭의 최근 실행 12건을 보관합니다.</p>
        <div class="rp-tool-popup-actions">
            <button type="button" class="menu_button rp-audit-run-copy">기록 복사</button>
            <button type="button" class="menu_button rp-audit-run-refresh">새로 보기</button>
            <button type="button" class="menu_button rp-audit-run-clear">기록 비우기</button>
        </div>
        <textarea class="rp-tool-popup-text" data-rp-audit-run-report readonly>${escapeHtml(buildAuditRunReport())}</textarea>
    </div>`;
    if (!callStoryBoosterToolPopup(html)) { toastr?.error?.('진단 진행 기록 창을 열 수 없습니다.'); return; }
    wireStoryBoosterToolPopup(popupId, root => {
        root.querySelector('.rp-audit-run-copy')?.addEventListener('click', async () => {
            try { await copyStoryBoosterText(buildAuditRunReport()); toastr?.success?.('진단 진행 기록을 복사했어요.'); }
            catch { toastr?.error?.('진단 진행 기록을 복사하지 못했습니다.'); }
        });
        root.querySelector('.rp-audit-run-refresh')?.addEventListener('click', refreshAuditRunTraceUi);
        root.querySelector('.rp-audit-run-clear')?.addEventListener('click', () => {
            clearAuditRuns(); refreshAuditRunTraceUi(); toastr?.success?.('완료된 진단 진행 기록을 비웠어요. 진행 중인 기록은 유지됩니다.');
        });
    });
}

// @source-order 79
function buildStoryBoosterErrorReport(entries = readStoryBoosterErrorLog()) {
    if (!entries.length) return "저장된 오류 진단 로그가 없습니다.";
    return [
        "[STORYBOOSTER ERROR DIAGNOSTIC REPORT]",
        ...entries.flatMap((entry, index) => [
            formatStoryBoosterErrorEntry(entry, index),
            "",
        ]),
    ].join("\n").trim();
}

// @source-order 80
async function copyStoryBoosterText(text) {
    const value = String(text || "");
    if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(value);
        return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
}

// @source-order 81
function callStoryBoosterToolPopup(html, options = {}) {
    const context = getContext();
    if (typeof context?.callGenericPopup === "function") {
        context.callGenericPopup(html, context.POPUP_TYPE.TEXT, "", {
            wide: true,
            large: false,
            ...options,
        });
        return true;
    }
    if (typeof globalThis.callPopup === "function") {
        globalThis.callPopup(html, "text", "", options);
        return true;
    }
    return false;
}

// @source-order 82
function wireStoryBoosterToolPopup(popupId, callback, attempt = 0) {
    const root = document.getElementById(popupId);
    if (root) {
        callback(root);
        return;
    }
    if (attempt < 20) {
        setTimeout(
            () => wireStoryBoosterToolPopup(popupId, callback, attempt + 1),
            50
        );
        return;
    }
    const error = new Error("StoryBooster tool popup DOM was not found after opening");
    error.code = "STORYBOOSTER_TOOL_POPUP_DOM_MISSING";
    recordStoryBoosterError(error, {
        task: "settings_tool_popup",
        stage: "popup_dom_binding",
    });
    toastr?.error?.("도구 창을 불러오지 못했습니다. 다시 시도해 주세요.");
}

// @source-order 83
function openStoryBoosterErrorLog() {
    const report = buildStoryBoosterErrorReport();
    const popupId = `rp-error-log-popup-${Date.now()}`;
    const html = `
        <div id="${popupId}" class="rp-tool-popup">
            <h3>🐞 오류 진단 로그</h3>
            <p class="rp-tool-popup-help">문제가 발생하면 오류 진단 로그를 복사해 문의해 주세요.</p>
            <div class="rp-tool-popup-actions">
                <button type="button" class="menu_button rp-error-log-copy">로그 복사</button>
                <button type="button" class="menu_button rp-error-log-clear">로그 비우기</button>
            </div>
            <textarea class="rp-tool-popup-text" readonly>${escapeHtml(report)}</textarea>
        </div>
    `;
    if (!callStoryBoosterToolPopup(html)) {
        toastr?.error?.("오류 진단 로그 창을 열 수 없습니다.");
        return;
    }
    wireStoryBoosterToolPopup(popupId, (root) => {
        const textarea = root?.querySelector(".rp-tool-popup-text");
        root?.querySelector(".rp-error-log-copy")?.addEventListener("click", async () => {
            try {
                await copyStoryBoosterText(textarea?.value || report);
                toastr?.success?.("오류 진단 로그를 복사했어요.");
            } catch {
                toastr?.error?.("오류 진단 로그를 복사하지 못했습니다.");
            }
        });
        root?.querySelector(".rp-error-log-clear")?.addEventListener("click", () => {
            clearStoryBoosterErrorLog();
            if (textarea) textarea.value = "저장된 오류 진단 로그가 없습니다.";
            toastr?.success?.("오류 진단 로그를 비웠어요.");
        });
    });
}

// @source-order 84
function estimatePromptTokens(text) {
    const value = String(text || "");
    let ascii = 0;
    let nonAscii = 0;
    for (const character of value) {
        if (character.charCodeAt(0) <= 0x7f) ascii += 1;
        else nonAscii += 1;
    }
    return Math.max(0, Math.ceil(ascii / 4 + nonAscii / 1.6));
}

// @source-order 85
async function countPromptTokens(text) {
    const value = String(text || "");
    if (!value) return { count: 0, estimated: false };
    const context = getContext();
    const counter = context?.getTokenCountAsync || context?.getTokenCount;
    if (typeof counter === "function") {
        try {
            const result = await counter.call(context, value);
            const count = Number(result?.count ?? result);
            if (Number.isFinite(count) && count >= 0) {
                return { count: Math.round(count), estimated: false };
            }
        } catch (error) {
            console.info(`[${MODULE_NAME}] SillyTavern token counter unavailable`, error);
        }
    }
    return { count: estimatePromptTokens(value), estimated: true };
}

// @source-order 86
function getCurrentInjectionPromptSnapshot() {
    const storyPrompt = runtime.currentStoryInjectionText;
    const plotPrompt = runtime.plotPending ? runtime.currentPlotInjectionText : "";
    return {
        storyPrompt,
        plotPrompt,
        combinedPrompt: [storyPrompt, plotPrompt].filter(Boolean).join("\n\n"),
    };
}

// @source-order 87
async function openCurrentInjectionPromptViewer() {
    const snapshot = getCurrentInjectionPromptSnapshot();
    const displayStoryPrompt = resolveRoleMacrosForDisplay(snapshot.storyPrompt);
    const displayPlotPrompt = resolveRoleMacrosForDisplay(snapshot.plotPrompt);
    const displayCombinedPrompt = [displayStoryPrompt, displayPlotPrompt]
        .filter(Boolean)
        .join("\n\n");
    const tokenInfo = await countPromptTokens(displayCombinedPrompt);
    const popupId = `rp-injection-popup-${Date.now()}`;
    const displayText = [
        displayStoryPrompt
            ? `[장르·캐릭터 부스터 · 깊이 1]\n${displayStoryPrompt}`
            : "",
        displayPlotPrompt
            ? `[플롯 1회 주입 · 깊이 0]\n${displayPlotPrompt}`
            : "",
    ]
        .filter(Boolean)
        .join("\n\n") || "현재 채팅방에 주입 중인 프롬프트가 없습니다.";
    const html = `
        <div id="${popupId}" class="rp-tool-popup">
            <h3>📄 주입 프롬프트</h3>
            <p class="rp-tool-popup-help">현재 채팅방의 다음 응답에 적용되는 스토리부스터 프롬프트예요. 대괄호 안의 구분 표시는 확인창에만 표시됩니다.</p>
            <div class="rp-tool-popup-stats">
                <span>${displayCombinedPrompt.length.toLocaleString("ko-KR")}자</span>
                <span>${tokenInfo.estimated ? "예상 " : ""}${tokenInfo.count.toLocaleString("ko-KR")}토큰</span>
            </div>
            <div class="rp-tool-popup-actions">
                <button type="button" class="menu_button rp-injection-copy">프롬프트 복사</button>
            </div>
            <textarea class="rp-tool-popup-text" readonly>${escapeHtml(displayText)}</textarea>
        </div>
    `;
    if (!callStoryBoosterToolPopup(html)) {
        toastr?.error?.("주입 프롬프트 창을 열 수 없습니다.");
        return;
    }
    wireStoryBoosterToolPopup(popupId, (root) => {
        root?.querySelector(".rp-injection-copy")?.addEventListener("click", async () => {
            try {
                await copyStoryBoosterText(displayCombinedPrompt);
                toastr?.success?.("주입 프롬프트를 복사했어요.");
            } catch {
                toastr?.error?.("주입 프롬프트를 복사하지 못했습니다.");
            }
        });
    });
}

export { buildStoryBoosterErrorReport, callStoryBoosterToolPopup, copyStoryBoosterText, countPromptTokens, estimatePromptTokens, getCurrentInjectionPromptSnapshot, openCurrentInjectionPromptViewer, openStoryBoosterErrorLog, wireStoryBoosterToolPopup };
