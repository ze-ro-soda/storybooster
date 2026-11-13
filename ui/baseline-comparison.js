import { CHARACTER_BASELINE_FIELDS, CHARACTER_BASELINE_FIELD_MAX_CHARS } from '../core/constants.js';
import { escapeHtml } from '../core/dom.js';
import { getCurrentCharacterBaseline } from '../core/storage.js';
import { getComparableBaselines, createBaselineComparison, editComparedField, copyComparedField,
    resetComparedSide, comparedChanges, saveComparedSide, assertBaselineComparisonScope } from '../core/baseline-comparison.js';
import { invalidateCharacterAuditAfterBaselineChange } from '../features/character.js';
import { safelyUpdateGenrePrompt } from '../features/audit.js';
import { safelyUpdateCharacterBoosterPanel, safelyUpdateGenreAnchorPanel } from '../core/ui-hooks.js';
import { copyStoryBoosterText } from './tools.js';

export function renderBaselineComparisonControls() {
    return `<details id="rp-baseline-comparison" class="rp-baseline-comparison">
        <summary>⇄ 저장된 기준 비교·편집</summary>
        <p class="rp-workspace-help">A·B를 골라 비교하고 항목을 옮겨 편집하세요. 저장 버튼을 누르기 전까지는 초안입니다.</p>
        <div class="rp-compare-selectors">
            <label for="rp-compare-a">A 기준<select id="rp-compare-a"></select></label>
            <label for="rp-compare-b">B 기준<select id="rp-compare-b"></select></label>
        </div>
        <div class="rp-workspace-actions"><button id="rp-compare-load" type="button">비교 불러오기</button></div>
        <p id="rp-compare-status" class="rp-workspace-help" role="status"></p>
        <div id="rp-compare-workspace" hidden>
            <label class="rp-compare-filter"><input id="rp-compare-only-different" type="checkbox" checked> 서로 다른 항목만 보기</label>
            <p id="rp-compare-count" class="rp-workspace-help"></p>
            <div id="rp-compare-fields"></div>
            <div class="rp-compare-save-grid">
                <div><p id="rp-compare-a-changes"></p><div class="rp-workspace-actions"><button id="rp-compare-a-copy" type="button">A 전체 복사</button><button id="rp-compare-a-reset" type="button">A 초안 되돌리기</button><button id="rp-compare-a-save" type="button">A 저장</button></div></div>
                <div><p id="rp-compare-b-changes"></p><div class="rp-workspace-actions"><button id="rp-compare-b-copy" type="button">B 전체 복사</button><button id="rp-compare-b-reset" type="button">B 초안 되돌리기</button><button id="rp-compare-b-save" type="button">B 저장</button></div></div>
            </div>
            <p class="rp-workspace-help">원본을 수정한 초안은 새 갱신본으로 저장·선택합니다. 갱신본은 해당 버전에 저장되어 그 버전을 사용하는 다른 채팅에도 반영됩니다. 복사할 때 대상의 핀 설정은 유지해요.</p>
            <p class="rp-workspace-help">비교·복사·저장은 AI를 호출하지 않아요. 내용 변경 후 실제 부스팅에는 앵커 갱신이 필요하며, 기존 앵커 갱신 버튼을 누르면 API 비용이 발생합니다.</p>
        </div>
    </details>`;
}

export function wireBaselineComparison(root) {
    const panel = root.querySelector('#rp-baseline-comparison');
    if (!panel) return;
    const selectors = { a: root.querySelector('#rp-compare-a'), b: root.querySelector('#rp-compare-b') };
    const workspace = root.querySelector('#rp-compare-workspace');
    const fields = root.querySelector('#rp-compare-fields');
    const filter = root.querySelector('#rp-compare-only-different');
    let session = null, initialized = false;
    const report = message => { root.querySelector('#rp-compare-status').textContent = message; };
    const guardEditors = () => {
        if (root.querySelector('.rp-character-field-text:not([readonly])')) throw new Error('기존 기준·앵커의 편집을 마친 뒤 비교를 사용해 주세요.');
    };
    const dirty = () => session && ['a', 'b'].some(side => comparedChanges(session, side).length);
    const node = (tag, content, className = '') => { const el = document.createElement(tag); el.textContent = content; if (className) el.className = className; return el; };
    function fillSelectors() {
        const options = getComparableBaselines();
        const selected = getCurrentCharacterBaseline().versionId || '';
        for (const side of ['a', 'b']) {
            selectors[side].innerHTML = options.map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`).join('');
            selectors[side].disabled = !options.length;
            selectors[side].value = session?.sides[side].id ?? (side === 'a' ? options[0]?.id || '' : selected || options.at(-1)?.id || '');
        }
        root.querySelector('#rp-compare-load').disabled = !options.length;
        if (!options.length) report('먼저 캐릭터 기준을 만들어 주세요.');
    }
    function updateIndicators() {
        if (!session) return;
        const changesBySide = { a: new Set(comparedChanges(session, 'a')), b: new Set(comparedChanges(session, 'b')) };
        let differences = 0;
        for (const field of CHARACTER_BASELINE_FIELDS) {
            const different = session.sides.a.draft.fields[field.id].text.trim() !== session.sides.b.draft.fields[field.id].text.trim();
            if (different) differences++;
            const row = fields.querySelector(`[data-compare-field="${field.id}"]`);
            if (!row) continue;
            row.hidden = filter.checked && !different && !row.contains(document.activeElement);
            row.classList.toggle('is-different', different);
            row.querySelector('.rp-compare-difference').textContent = different ? '내용 다름' : '내용 같음';
            for (const side of ['a', 'b']) {
                const changed = changesBySide[side].has(field.id);
                row.querySelector(`[data-draft-label="${side}"]`).textContent = `${side.toUpperCase()} · ${session.sides[side].label}${session.sides[side].draft.fields[field.id].pinned ? ' · 📌' : ''}${changed ? ' · 초안 수정됨' : ''}`;
            }
        }
        root.querySelector('#rp-compare-count').textContent = `서로 다른 항목 ${differences}개 / ${CHARACTER_BASELINE_FIELDS.length}개${!differences && filter.checked ? ' · 같은 항목도 보려면 위 선택을 해제하세요.' : ''}`;
        for (const side of ['a', 'b']) {
            const changed = changesBySide[side].size;
            root.querySelector(`#rp-compare-${side}-changes`).textContent = `${side.toUpperCase()} 초안: ${changed ? `${changed}개 항목 변경` : '저장본과 같음'}`;
            const save = root.querySelector(`#rp-compare-${side}-save`);
            save.textContent = session.sides[side].id ? `${side.toUpperCase()} 기준에 저장` : `${side.toUpperCase()}를 새 갱신본으로 저장·사용`;
            save.disabled = !changed;
            root.querySelector(`#rp-compare-${side}-reset`).disabled = !changed;
        }
    }
    async function copyText(value) {
        try { await copyStoryBoosterText(value); if (root.isConnected) report('복사했어요. 원하는 곳에 붙여넣을 수 있어요.'); }
        catch { if (root.isConnected) report('자동 복사를 사용할 수 없어요. 입력창의 내용을 직접 선택해 복사해 주세요.'); }
    }
    function renderFields() {
        fields.replaceChildren();
        const ordered = [...CHARACTER_BASELINE_FIELDS].sort((a, b) => {
            const diff = field => session.sides.a.draft.fields[field.id].text.trim() !== session.sides.b.draft.fields[field.id].text.trim();
            return Number(diff(b)) - Number(diff(a));
        });
        for (const field of ordered) {
            const card = node('article', '', 'rp-compare-field'); card.dataset.compareField = field.id;
            const heading = node('div', '', 'rp-compare-field-heading');
            heading.append(node('strong', field.label), node('small', '', 'rp-compare-difference')); card.append(heading);
            const grid = node('div', '', 'rp-compare-columns');
            for (const side of ['a', 'b']) {
                const other = side === 'a' ? 'b' : 'a';
                const cell = node('div', '', 'rp-compare-cell');
                const label = node('label', ''); label.dataset.draftLabel = side;
                const id = `rp-compare-${side}-${field.id}`; label.htmlFor = id;
                const textarea = document.createElement('textarea'); textarea.id = id; textarea.className = 'rp-compare-text';
                textarea.rows = 5; textarea.maxLength = CHARACTER_BASELINE_FIELD_MAX_CHARS; textarea.value = session.sides[side].draft.fields[field.id].text;
                textarea.addEventListener('input', () => {
                    try { editComparedField(session, side, field.id, textarea.value); updateIndicators(); }
                    catch (error) { report(error.message); }
                });
                const actions = node('div', '', 'rp-workspace-actions');
                const copy = node('button', `${side.toUpperCase()} 항목 복사`); copy.type = 'button';
                copy.addEventListener('click', () => { try { assertBaselineComparisonScope(session); void copyText(session.sides[side].draft.fields[field.id].text); } catch (error) { report(error.message); } });
                const move = node('button', `${side.toUpperCase()} → ${other.toUpperCase()}`); move.type = 'button';
                move.setAttribute('aria-label', `${field.label}을 ${side.toUpperCase()}에서 ${other.toUpperCase()} 초안으로 복사`);
                move.addEventListener('click', () => {
                    try {
                        copyComparedField(session, side, other, field.id);
                        fields.querySelector(`#rp-compare-${other}-${field.id}`).value = session.sides[other].draft.fields[field.id].text;
                        updateIndicators(); report(`${field.label}을 ${other.toUpperCase()} 초안에 복사했어요. 아직 저장하지 않았습니다.`);
                    } catch (error) { report(error.message); }
                });
                actions.append(copy, move); cell.append(label, textarea, actions); grid.append(cell);
            }
            card.append(grid); fields.append(card);
        }
        workspace.hidden = false; updateIndicators();
    }
    panel.addEventListener('toggle', () => {
        if (!panel.open || initialized) return;
        try { guardEditors(); fillSelectors(); initialized = true; }
        catch (error) { report(error.message); }
    });
    function loadComparison() {
        try {
            guardEditors();
            if (dirty() && !window.confirm('양쪽의 저장하지 않은 초안을 버리고 비교를 다시 불러올까요?')) {
                selectors.a.value = session.sides.a.id; selectors.b.value = session.sides.b.id; return;
            }
            const next = createBaselineComparison(selectors.a.value, selectors.b.value);
            session = next; renderFields(); report('저장본을 불러왔어요. 이동 버튼은 반대편 초안의 해당 항목을 교체합니다.');
        } catch (error) {
            if (session) { selectors.a.value = session.sides.a.id; selectors.b.value = session.sides.b.id; }
            report(error.message);
        }
    }
    root.querySelector('#rp-compare-load').addEventListener('click', loadComparison);
    for (const select of Object.values(selectors)) select.addEventListener('change', () => { if (session) loadComparison(); });
    filter.addEventListener('change', updateIndicators);
    for (const side of ['a', 'b']) {
        root.querySelector(`#rp-compare-${side}-copy`).addEventListener('click', () => {
            try { assertBaselineComparisonScope(session); void copyText(CHARACTER_BASELINE_FIELDS.map(field => `[${field.label}]\n${session.sides[side].draft.fields[field.id].text}`).join('\n\n')); }
            catch (error) { report(error.message); }
        });
        root.querySelector(`#rp-compare-${side}-reset`).addEventListener('click', () => {
            try {
                if (!window.confirm(`${side.toUpperCase()} 초안을 처음 불러온 저장 내용으로 되돌릴까요?`)) return;
                resetComparedSide(session, side); renderFields(); report(`${side.toUpperCase()} 초안을 되돌렸어요.`);
            } catch (error) { report(error.message); }
        });
        root.querySelector(`#rp-compare-${side}-save`).addEventListener('click', () => {
            try {
                guardEditors();
                const result = saveComparedSide(session, side);
                invalidateCharacterAuditAfterBaselineChange(session.chatId, { sharedVersionId: result.versionId });
                safelyUpdateGenrePrompt('기준 비교 초안 저장'); safelyUpdateGenreAnchorPanel('기준 비교 초안 저장');
                safelyUpdateCharacterBoosterPanel('기준 비교 초안 저장');
                fillSelectors(); renderFields(); report(`「${result.label}」에 저장했어요. 사용할 기준을 확인하고 기존 앵커 갱신 버튼으로 갱신해 주세요. API 비용이 발생합니다.`);
            } catch (error) { report(error.message); }
        });
    }
}
