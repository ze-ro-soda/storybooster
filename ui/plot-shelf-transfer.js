import { assertPlotShelfScope, getPlotShelf } from '../core/plot-shelf.js';
import { exportPlotShelf, parsePlotShelfFile, capturePlotImportTarget, planPlotShelfImport, applyPlotShelfImport, PLOT_SHELF_FILE_MAX_BYTES } from '../core/plot-shelf-transfer.js';

export function wirePlotShelfTransfer(root, { scope, refresh }) {
    const picker = root.querySelector('#rp-shelf-file'), transfer = root.querySelector('#rp-shelf-transfer');
    const exportList = root.querySelector('#rp-shelf-export-items'), preview = root.querySelector('#rp-shelf-import-preview');
    if (!picker || !transfer || !exportList || !preview) return;
    const report = message => { root.querySelector('#rp-shelf-status').textContent = message; };
    const node = (tag, content) => { const value = document.createElement(tag); value.textContent = content; return value; };
    let exported = [], pending = null, sequence = 0;
    function renderExport() {
        exported = getPlotShelf(scope); exportList.replaceChildren();
        for (const item of exported) {
            const label = node('label', ''); label.className = 'rp-backup-select';
            const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true; input.value = item.id;
            label.append(input, node('span', item.title || item.text.slice(0, 45))); exportList.append(label);
        }
        if (!exported.length) exportList.append(node('p', '내보낼 아이디어가 없어요.'));
    }
    function checkScope() {
        if (root.isConnected === false) throw new Error('스토리부스터를 다시 열어 주세요.');
        assertPlotShelfScope(scope);
    }
    transfer.addEventListener('toggle', () => {
        if (transfer.open) try { checkScope(); renderExport(); } catch (error) { report(error.message); }
    });
    root.querySelector('#rp-shelf-export')?.addEventListener('click', () => {
        let url;
        try {
            checkScope();
            if (JSON.stringify(getPlotShelf(scope)) !== JSON.stringify(exported)) throw new Error('보관함이 변경됐습니다. 파일 메뉴를 다시 열어 주세요.');
            const ids = [...exportList.querySelectorAll('input:checked')].map(input => input.value);
            const backup = exportPlotShelf(ids, scope);
            url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }));
            const link = document.createElement('a'); link.href = url;
            link.download = `storybooster-plot-shelf-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.append(link);
            try { link.click(); } finally { link.remove(); }
            report('파일 다운로드를 시작했어요. 플롯 문구가 포함되니 공유 전 확인해 주세요.');
        } catch (error) { report(error.message); }
        finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 30000); }
    });
    root.querySelector('#rp-shelf-import')?.addEventListener('click', () => {
        try { checkScope(); picker.value = ''; picker.click(); } catch (error) { report(error.message); }
    });
    function clearPreview() { pending = null; preview.replaceChildren(); preview.hidden = true; }
    function renderPreview() {
        preview.replaceChildren(); preview.hidden = false;
        const { items, selected, target } = pending;
        const count = node('p', ''); count.setAttribute('aria-live', 'polite');
        const apply = node('button', '선택 항목 가져오기'); apply.type = 'button';
        const update = () => {
            try {
                const plan = planPlotShelfImport(items, [...selected], target);
                count.textContent = `추가 ${plan.additions.length}개 · 중복 제외 ${plan.duplicates}개`;
                apply.disabled = plan.additions.length === 0;
            } catch (error) { count.textContent = error.message; apply.disabled = true; }
        };
        for (const [index, item] of items.entries()) {
            const label = node('label', ''); label.className = 'rp-backup-select';
            const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true;
            input.addEventListener('change', () => { input.checked ? selected.add(index) : selected.delete(index); update(); });
            label.append(input, node('span', item.title || item.text.slice(0, 45)));
            const detail = node('details', ''), summary = node('summary', ''); summary.append(label);
            input.addEventListener('click', event => event.stopPropagation());
            const content = node('p', item.text); content.className = 'rp-shelf-entry-text'; detail.append(summary, content); preview.append(detail);
        }
        apply.addEventListener('click', () => {
            try {
                checkScope();
                const result = applyPlotShelfImport(items, [...selected], target);
                clearPreview(); refresh(); renderExport(); report(`${result.added}개를 가져왔어요. 중복 ${result.duplicates}개는 제외했어요.`);
            } catch (error) { report(error.message); }
        });
        const cancel = node('button', '가져오기 취소'); cancel.type = 'button'; cancel.addEventListener('click', clearPreview);
        preview.append(count, apply, cancel); update();
    }
    picker.addEventListener('change', async () => {
        const ticket = ++sequence; clearPreview();
        const file = picker.files?.[0]; if (!file) return;
        try {
            checkScope(); const target = capturePlotImportTarget(scope);
            if (file.size > PLOT_SHELF_FILE_MAX_BYTES) throw new Error('파일은 2MB 이하여야 합니다.');
            const content = await file.text(); if (ticket !== sequence) return;
            checkScope(); const items = parsePlotShelfFile(content);
            planPlotShelfImport(items, [], target);
            pending = { items, target, selected: new Set(items.map((_, index) => index)) };
            renderPreview(); report('가져올 아이디어를 선택해 주세요. 아직 저장하지 않았어요.');
        } catch (error) { if (ticket === sequence) report(error.message); }
    });
}
