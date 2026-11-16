import { getCurrentChatId } from '../core/context.js';
import { getBoosterElement } from '../core/dom.js';
import { capturePlotShelfScope, assertPlotShelfScope, getPlotShelf, savePlotShelfItem, deletePlotShelfItem, PLOT_SHELF_TEXT_LIMIT } from '../core/plot-shelf.js';
import { eventGenerationPendingTasks, runtime } from '../core/runtime.js';
import { getPlotHistory, activatePlotGenerationMode, capturePlotModeDraft, updatePlotGenerationPendingUi } from '../features/plot.js';

export function renderPlotShelfControls() {
    return `<details id="rp-plot-shelf" class="rp-plot-shelf">
        <summary>📌 플롯 아이디어 보관함 <span id="rp-plot-shelf-count"></span></summary>
        <p class="rp-workspace-help">이 채팅에 따로 보관합니다. 저장·편집·불러오기는 AI를 호출하지 않아요. 최대 50개.</p>
        <div class="rp-workspace-actions"><button id="rp-shelf-new" type="button">직접 아이디어 쓰기</button></div>
        <div id="rp-shelf-editor" hidden>
            <label for="rp-shelf-title">제목 <small>(선택)</small></label>
            <input id="rp-shelf-title" type="text" maxlength="80" placeholder="나중에 알아볼 이름">
            <label for="rp-shelf-text">내용</label>
            <textarea id="rp-shelf-text" rows="6" maxlength="${PLOT_SHELF_TEXT_LIMIT}" placeholder="나중에 쓰고 싶은 사건이나 아이디어를 적어 주세요."></textarea>
            <div class="rp-workspace-actions"><button id="rp-shelf-save" type="button">보관함에 저장</button><button id="rp-shelf-cancel" type="button">편집 취소</button></div>
        </div>
        <p id="rp-shelf-status" class="rp-workspace-help" role="status"></p>
        <div id="rp-shelf-list"></div>
    </details>`;
}

export function wirePlotShelf(root) {
    const panel = root.querySelector('#rp-plot-shelf');
    if (!panel) return;
    const list = root.querySelector('#rp-shelf-list'), editor = root.querySelector('#rp-shelf-editor');
    const title = root.querySelector('#rp-shelf-title'), text = root.querySelector('#rp-shelf-text');
    let scope, editing = null;
    const report = message => { root.querySelector('#rp-shelf-status').textContent = message; };
    try { scope = capturePlotShelfScope(); } catch (error) {
        report(error.message); root.querySelector('#rp-shelf-new').disabled = true; return;
    }
    const node = (tag, content, className = '') => { const el = document.createElement(tag); el.textContent = content; if (className) el.className = className; return el; };
    const button = (label, action) => { const el = node('button', label); el.type = 'button'; el.addEventListener('click', () => { try { assertPlotShelfScope(scope); action(); } catch (error) { report(error.message); } }); return el; };
    const unsaved = () => !editor.hidden && (title.value !== (editing?.title || '') || text.value !== (editing?.text || ''));
    const mayReplaceEditor = () => !unsaved() || window.confirm('저장하지 않은 보관함 초안을 바꿀까요?');
    function openEditor(entry = null) {
        assertPlotShelfScope(scope);
        if (!mayReplaceEditor()) return;
        editing = entry; title.value = entry?.title || ''; text.value = entry?.text || '';
        editor.hidden = false; panel.open = true; title.focus();
    }
    function renderList() {
        const entries = getPlotShelf(scope);
        root.querySelector('#rp-plot-shelf-count').textContent = `${entries.length}/50`;
        list.replaceChildren();
        if (!entries.length) { list.append(node('p', '아직 보관한 아이디어가 없어요.', 'rp-workspace-help')); return; }
        for (const entry of entries) {
            const card = node('details', '', 'rp-shelf-entry');
            card.append(node('summary', entry.title || entry.text.slice(0, 45)));
            card.append(node('p', entry.text, 'rp-shelf-entry-text'));
            const actions = node('div', '', 'rp-workspace-actions');
            actions.append(button('플롯창으로 불러오기', () => loadEntry(entry)), button('편집', () => openEditor(entry)), button('삭제', () => {
                if (!window.confirm('이 아이디어를 보관함에서 삭제할까요?')) return;
                deletePlotShelfItem(entry.id, JSON.stringify(entry), scope);
                if (editing?.id === entry.id) { editing = null; editor.hidden = true; }
                renderList(); report('보관함에서 삭제했어요.');
            }));
            card.append(actions); list.append(card);
        }
    }
    function busy() {
        return runtime.plotPending || eventGenerationPendingTasks.has(String(getCurrentChatId()));
    }
    function loadEntry(entry) {
        if (busy()) throw new Error('플롯 생성·적용이 끝난 뒤 불러와 주세요.');
        const current = getBoosterElement('rp-event-result');
        if (current?.value.trim() && current.value.trim() !== entry.text.trim() && !window.confirm('현재 플롯창 내용을 보관한 아이디어로 바꿀까요?')) return;
        activatePlotGenerationMode('guided');
        const field = getBoosterElement('rp-event-result');
        const idea = getBoosterElement('rp-plot-idea');
        if (!field) return;
        field.value = entry.text; delete field.dataset.historyId;
        if (idea) idea.value = '';
        getBoosterElement('rp-event-result-wrap').hidden = false;
        capturePlotModeDraft('guided'); updatePlotGenerationPendingUi();
        getBoosterElement('rp-event-status').textContent = '보관한 아이디어를 불러왔어요. 다듬기·새 방향은 기존 AI 생성 비용이 발생합니다.';
        report('플롯창으로 불러왔어요. 직접 수정하거나 다듬은 뒤 사용할 수 있어요.');
        field.focus(); field.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    root.querySelector('#rp-shelf-new').addEventListener('click', () => { try { openEditor(); } catch (error) { report(error.message); } });
    root.querySelector('#rp-shelf-cancel').addEventListener('click', () => {
        if (!mayReplaceEditor()) return;
        editor.hidden = true; editing = null; title.value = ''; text.value = ''; report('초안 편집을 취소했어요.');
    });
    root.querySelector('#rp-shelf-save').addEventListener('click', () => {
        try {
            savePlotShelfItem({ title: title.value, text: text.value, id: editing?.id || '', expected: editing ? JSON.stringify(editing) : null }, scope);
            editing = null; editor.hidden = true; title.value = ''; text.value = ''; renderList(); report('보관함에 저장했어요.');
        } catch (error) { report(error.message); }
    });
    root.addEventListener('click', event => {
        const historyButton = event.target.closest('.rp-plot-history-save');
        const resultButton = event.target.closest('#rp-event-save-shelf');
        if (!historyButton && !resultButton) return;
        try {
            assertPlotShelfScope(scope);
            if (resultButton && busy()) throw new Error('플롯 생성·적용이 끝난 뒤 보관해 주세요.');
            const value = historyButton ? getPlotHistory().find(entry => entry.id === historyButton.dataset.historyId)?.text : getBoosterElement('rp-event-result')?.value;
            if (!value?.trim()) throw new Error('보관할 플롯이 없습니다.');
            const entries = getPlotShelf(scope);
            if (entries.some(entry => entry.text.trim() === value.trim())) { panel.open = true; report('같은 내용이 이미 보관되어 있어요.'); return; }
            savePlotShelfItem({ text: value }, scope); renderList(); panel.open = true; report('최근 추천과 별도로 보관했어요.');
        } catch (error) { report(error.message); panel.open = true; }
    });
    panel.addEventListener('toggle', () => {
        if (!panel.open) return;
        try { assertPlotShelfScope(scope); renderList(); } catch {
            // A mounted popup can outlive its chat. Preserve the old draft; never rebind a save to the new chat.
            report('채팅이 바뀌었습니다. 스토리부스터를 다시 열어 주세요.');
        }
    });
    renderList();
}
