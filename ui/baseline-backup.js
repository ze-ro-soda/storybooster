import { createCharacterBackup, parseCharacterBackup, captureBaselineImportTarget, planBaselineImport, applyBaselineImport, BASELINE_BACKUP_MAX_BYTES } from '../core/baseline-transfer.js';
import { CHARACTER_BASELINE_FIELDS } from '../core/constants.js';
import { safelyUpdateCharacterBoosterPanel } from '../core/ui-hooks.js';
import { safelyUpdateGenrePrompt } from '../features/audit.js';

export function renderBaselineBackupControls() {
    return `<details class="rp-baseline-backup">
        <summary>기준 백업·복원</summary>
        <p>이 캐릭터의 원본·갱신본·앵커를 파일로 보관합니다. API 키와 대화 기록은 포함하지 않습니다.</p>
        <div class="rp-character-version-actions">
            <button id="rp-baseline-export" type="button">백업 파일 저장</button>
            <button id="rp-baseline-import" type="button">백업 가져오기</button>
        </div>
        <input id="rp-baseline-import-file" type="file" accept=".json,application/json" hidden>
        <p id="rp-baseline-backup-status" role="status" hidden></p>
        <div id="rp-baseline-import-preview" hidden></div>
    </details>`;
}

export function wireBaselineBackupControls(root) {
    const picker = root.querySelector('#rp-baseline-import-file');
    const preview = root.querySelector('#rp-baseline-import-preview');
    const status = root.querySelector('#rp-baseline-backup-status');
    if (!picker || !preview || !status) return;
    let sequence = 0, pending = null;
    const report = message => { status.textContent = message; status.hidden = !message; };
    const guardEditors = () => {
        if (root.querySelector('.rp-character-field-text:not([readonly])')) throw new Error('편집 중인 기준이나 앵커를 저장한 뒤 다시 시도해 주세요.');
    };
    const clearPreview = () => { pending = null; preview.replaceChildren(); preview.hidden = true; };
    const element = (tag, content, className = '') => {
        const node = document.createElement(tag); node.textContent = content; if (className) node.className = className; return node;
    };
    root.querySelector('#rp-baseline-export')?.addEventListener('click', () => {
        try {
            guardEditors();
            const backup = createCharacterBackup();
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url; link.download = `storybooster-character-backup-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            report('백업 파일 다운로드를 시작했습니다. 기준 문구가 담긴 파일이므로 공유 전 내용을 확인해 주세요.');
        } catch (error) { report(error.message); }
    });
    root.querySelector('#rp-baseline-import')?.addEventListener('click', () => {
        try { guardEditors(); picker.value = ''; picker.click(); } catch (error) { report(error.message); }
    });
    function renderPreview() {
        if (!pending) return;
        const { backup, target, selected } = pending;
        preview.replaceChildren(); preview.hidden = false;
        preview.append(element('p', `백업: ${backup.characterName || '이름 없음'} → 현재 캐릭터: ${target.identity.name || '이름 없음'}`));
        preview.append(element('p', '원본이 없으면 백업의 원본을 복원합니다. 이미 원본이 있으면 새 갱신본으로 추가합니다. 기준 문구 속 이름은 그대로 유지됩니다.', 'rp-backup-help'));
        for (const entry of backup.entries) {
            const details = document.createElement('details'); details.className = 'rp-backup-entry';
            const summary = document.createElement('summary');
            const label = document.createElement('label'); label.className = 'rp-backup-select';
            const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(entry.sourceId);
            input.addEventListener('click', event => event.stopPropagation());
            input.addEventListener('change', () => { input.checked ? selected.add(entry.sourceId) : selected.delete(entry.sourceId); updatePlan(); });
            label.append(input, element('span', entry.label));
            summary.append(label, element('small', entry.baseline.boostAnchor && !entry.baseline.boostAnchorNeedsRefresh ? '앵커 포함' : '앵커 재생성 필요'));
            details.append(summary);
            for (const field of CHARACTER_BASELINE_FIELDS) {
                const value = entry.baseline.fields[field.id];
                if (!value?.text) continue;
                details.append(element('strong', `${value.pinned ? '📌 ' : ''}${field.label}`), element('p', value.text, 'rp-backup-content'));
            }
            if (entry.baseline.boostAnchor) details.append(element('strong', '상시 앵커'), element('p', entry.baseline.boostAnchor, 'rp-backup-content'));
            preview.append(details);
        }
        const counts = element('p', '', 'rp-backup-counts'); counts.setAttribute('aria-live', 'polite');
        const actions = document.createElement('div'); actions.className = 'rp-character-version-actions';
        const apply = element('button', '선택 항목 가져오기'); apply.type = 'button';
        const cancel = element('button', '취소'); cancel.type = 'button';
        cancel.addEventListener('click', () => { sequence++; clearPreview(); report('가져오기를 취소했습니다.'); });
        function updatePlan() {
            try {
                const plan = planBaselineImport(backup, [...selected], target);
                const skipped = plan.rows.length - plan.additions.length;
                counts.textContent = `추가 ${plan.additions.length}개 · 동일 내용 ${skipped}개 건너뜀 · 갱신본 자리 ${plan.neededSlots}/${plan.freeSlots}개 사용` +
                    (plan.neededSlots > plan.freeSlots ? ' — 저장 공간이 부족합니다. 항목을 줄여 주세요.' : '');
                apply.disabled = !plan.canImport;
            } catch (error) { counts.textContent = error.message; apply.disabled = true; }
        }
        apply.addEventListener('click', () => {
            try {
                guardEditors();
                const result = applyBaselineImport(backup, [...selected], target);
                sequence++; clearPreview();
                safelyUpdateGenrePrompt('캐릭터 기준 가져오기'); safelyUpdateCharacterBoosterPanel('캐릭터 기준 가져오기');
                report(`${result.added}개를 가져왔습니다.${result.restoredOriginal ? ' 비어 있던 원본을 복원했습니다.' : ' 현재 선택은 유지됩니다.'} 사용할 기준은 위 목록에서 선택해 주세요.`);
            } catch (error) { report(error.message); }
        });
        actions.append(apply, cancel); preview.append(counts, actions); updatePlan();
    }
    picker.addEventListener('change', async () => {
        const ticket = ++sequence;
        clearPreview();
        const file = picker.files?.[0];
        if (!file) return;
        try {
            guardEditors();
            const target = captureBaselineImportTarget();
            if (file.size > BASELINE_BACKUP_MAX_BYTES) throw new Error('백업 파일은 2MB 이하여야 합니다.');
            const source = await file.text();
            if (ticket !== sequence || root.isConnected === false) return;
            const current = captureBaselineImportTarget();
            if (current.identity.key !== target.identity.key || current.chatId !== target.chatId || current.snapshot !== target.snapshot)
                throw new Error('파일을 읽는 동안 캐릭터나 기준이 변경됐습니다. 다시 선택해 주세요.');
            const backup = parseCharacterBackup(source);
            pending = { backup, target, selected: new Set(backup.entries.map(e => e.sourceId)) };
            report('가져올 항목을 선택하고 내용을 확인해 주세요. 아직 저장되지 않았습니다.'); renderPreview();
        } catch (error) { if (ticket === sequence) report(error.message); }
    });
}
