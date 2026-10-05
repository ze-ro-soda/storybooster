import { isDeveloperModeUnlocked, lockDeveloperMode, unlockDeveloperMode } from '../core/debug-mode.js';
import { auditRunStatusText } from '../core/audit-run-trace.js';
import { escapeHtml } from '../core/dom.js';
import { runAutomaticAuditTest } from '../features/audit.js';
import { callStoryBoosterToolPopup, openAuditRunTraceLog, wireStoryBoosterToolPopup } from './tools.js';

let opening = false;
let popupSequence = 0;

function renderDeveloperWindow(root) {
    if (!isDeveloperModeUnlocked()) {
        root.innerHTML = `<h3>개발자 모드</h3>
            <form class="rp-debug-unlock-form">
                <label>비밀번호 <input class="rp-debug-password" type="text" autocomplete="off" spellcheck="false" maxlength="100" placeholder="비밀번호 입력"></label>
                <p class="rp-debug-unlock-error" role="alert" hidden></p>
                <button type="submit" class="menu_button">개발자 도구 열기</button>
            </form>`;
        const input = root.querySelector('.rp-debug-password');
        root.querySelector('.rp-debug-unlock-form')?.addEventListener('submit', event => {
            event.preventDefault();
            const password = input?.value || '';
            if (input) input.value = '';
            if (unlockDeveloperMode(password)) renderDeveloperWindow(root);
            else {
                const error = root.querySelector('.rp-debug-unlock-error');
                if (error) { error.hidden = false; error.textContent = '비밀번호가 일치하지 않습니다.'; }
                input?.focus();
            }
        });
        input?.focus();
        return;
    }
    root.innerHTML = `<h3>개발자 도구</h3>
        <p class="rp-tool-popup-help">현재 설정으로 실제 자동진단을 1회 실행합니다. API 비용이 발생하며 보정·자동 랜덤박스가 준비될 수 있습니다. 답변 수와 진단 주기는 바꾸지 않습니다.</p>
        <div class="rp-tool-popup-actions">
            <button type="button" class="menu_button rp-debug-auto-test">자동진단 테스트</button>
            <button type="button" class="menu_button rp-debug-audit-log">진단 진행 기록</button>
            <button type="button" class="menu_button rp-debug-lock">모드 잠그기</button>
        </div>
        <p id="rp-audit-run-status" aria-live="polite">${escapeHtml(auditRunStatusText())}</p>`;
    root.querySelector('.rp-debug-auto-test')?.addEventListener('click', async event => {
        if (!isDeveloperModeUnlocked()) { renderDeveloperWindow(root); return; }
        const button = event.currentTarget;
        button.disabled = true;
        try { await runAutomaticAuditTest(); }
        finally { button.disabled = false; }
    });
    root.querySelector('.rp-debug-audit-log')?.addEventListener('click', () => {
        if (isDeveloperModeUnlocked()) openAuditRunTraceLog();
        else renderDeveloperWindow(root);
    });
    root.querySelector('.rp-debug-lock')?.addEventListener('click', () => { lockDeveloperMode(); renderDeveloperWindow(root); });
}

export function openDeveloperMode() {
    if (opening) return;
    opening = true;
    const popupId = `rp-debug-popup-${Date.now()}-${++popupSequence}`;
    if (!callStoryBoosterToolPopup(`<div id="${popupId}" class="rp-tool-popup rp-debug-popup"></div>`, { okButton: '닫기' })) {
        opening = false; toastr?.error?.('개발자 도구 창을 열 수 없습니다.'); return;
    }
    // The standard popup mounts asynchronously. The existing binder handles it.
    wireStoryBoosterToolPopup(popupId, root => { opening = false; renderDeveloperWindow(root); });
    // A failed host popup must not lock out later attempts permanently.
    setTimeout(() => { opening = false; }, 1200);
}

export function wireDeveloperModeEntry(panel) {
    const title = panel.querySelector('[data-rp-debug-entry]');
    if (!title) return;
    let taps = 0, lastTap = 0;
    const tap = event => {
        if (Date.now() - lastTap > 4000) taps = 0;
        lastTap = Date.now();
        if (++taps < 5) return;
        taps = 0; event.preventDefault?.(); event.stopPropagation?.(); openDeveloperMode();
    };
    title.addEventListener('click', tap);
    title.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tap(event); }
    });
}
