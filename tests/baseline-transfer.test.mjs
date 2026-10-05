import assert from 'node:assert/strict';
import { fixture } from './helpers/diagnosis-fixture.mjs';
const clone = value => JSON.parse(JSON.stringify(value));
async function setup() {
    const f = await fixture();
    return { ...f, transfer: f.m.namespace('core/baseline-transfer.js'), identity: f.m.namespace('core/context.js').getCurrentCharacterIdentity() };
}
const source = await setup();
const baseline = source.storage.getCurrentCharacterBaseline().baseline;
const revision = clone(baseline); revision.fields.core_identity.text = 'A changed but still independent investigator.';
revision.boostAnchorNeedsRefresh = true;
source.settings.characterBaselineVersions[source.identity.key] = { nextNumber: 3, versions: {
    source_A: { id: 'source_A', label: 'Saved A', baseline: revision, parentVersionId: '', createdAt: 1, updatedAt: 1, revisionMode: 'directed', evidenceLevel: 'partial' },
    source_B: { id: 'source_B', label: 'Saved B', baseline: { ...clone(revision), boostAnchor: 'Different meaningful English anchor.' }, parentVersionId: 'source_A', createdAt: 2, updatedAt: 2 },
} };
source.settings.secretCanary = 'never-export-settings';
const raw = source.transfer.createCharacterBackup();
const encoded = JSON.stringify(raw);
assert.equal(encoded.includes('never-export-settings'), false);
assert.equal(encoded.includes('synthetic-key'), false);
assert.equal(encoded.includes('partner offers an option'), false);
assert.equal(encoded.includes('character-A.png'), false);
const backup = source.transfer.parseCharacterBackup(encoded);
assert.equal(backup.entries.length, 3);
assert.equal(backup.entries[0].baseline.fields.core_identity.pinned, true);

// Empty destination restores original + revisions together, including parent remapping.
{
    const f = await setup(); delete f.settings.characterBaselines[f.identity.key];
    const target = f.transfer.captureBaselineImportTarget(), selection = f.state.characterBoost.baselineVersionId;
    const result = f.transfer.applyBaselineImport(backup, ['', 'source_A', 'source_B'], target);
    assert.equal(result.added, 3); assert.equal(result.restoredOriginal, true);
    assert.equal(f.state.characterBoost.baselineVersionId, selection);
    assert.equal(f.settings.characterBaselines[f.identity.key].boostAnchor, baseline.boostAnchor);
    const versions = Object.values(f.settings.characterBaselineVersions[f.identity.key].versions);
    assert.equal(versions.length, 2); assert.equal(versions[1].parentVersionId, versions[0].id);
    assert.equal(versions[0].baseline.boostAnchorNeedsRefresh, true);
    assert.equal(versions[0].baseline.fields.core_identity.pinned, true);
    assert.equal(versions[0].revisionMode, 'directed'); assert.equal(versions[0].evidenceLevel, 'partial');
    assert.equal(f.transfer.planBaselineImport(backup, ['', 'source_A', 'source_B'], f.transfer.captureBaselineImportTarget()).canImport, false);
    assert.equal(f.env.requests.length, 0); assert.equal(f.bodies.length, 0);
}
// Existing original is preserved; selected versions only, collision-safe labels and IDs.
{
    const f = await setup();
    f.settings.characterBaselines[f.identity.key].fields.core_identity.text = 'Destination original is intentionally different.';
    f.settings.characterBaselineVersions[f.identity.key] = { nextNumber: 1, versions: { saved: { id: 'saved', label: 'Saved A', baseline: clone(baseline), createdAt: 1, updatedAt: 1 } } };
    const before = clone(f.settings.characterBaselines[f.identity.key]);
    const target = f.transfer.captureBaselineImportTarget();
    const result = f.transfer.applyBaselineImport(backup, ['source_A'], target);
    assert.equal(result.added, 1); assert.equal(result.restoredOriginal, false);
    assert.deepEqual(clone(f.settings.characterBaselines[f.identity.key]), before);
    const added = Object.values(f.settings.characterBaselineVersions[f.identity.key].versions).find(v => v.id !== 'saved');
    assert.match(added.label, /가져옴/); assert.notEqual(added.id, 'source_A');
}
// Same content is skipped, even with a different name/timestamp; originals become revisions if needed.
{
    const f = await setup(); const target = f.transfer.captureBaselineImportTarget();
    assert.equal(f.transfer.planBaselineImport(backup, [''], target).additions.length, 0);
    f.settings.characterBaselines[f.identity.key].fields.core_identity.text = 'Different existing original.';
    const before = clone(f.settings.characterBaselines[f.identity.key]);
    f.transfer.applyBaselineImport(backup, [''], f.transfer.captureBaselineImportTarget());
    assert.deepEqual(clone(f.settings.characterBaselines[f.identity.key]), before);
    assert.equal(Object.values(f.settings.characterBaselineVersions[f.identity.key].versions)[0].label, '원본 (가져옴)');
}
// Capacity, malformed content and stale context fail before any selected item is committed.
{
    const f = await setup();
    f.settings.characterBaselineVersions[f.identity.key] = { nextNumber: 11, versions: Object.fromEntries(Array.from({ length: 10 }, (_, n) => [String(n),
        { id: String(n), label: `Existing ${n}`, baseline: { ...clone(baseline), boostAnchor: `Existing anchor ${n}` }, createdAt: n + 1, updatedAt: n + 1 }])) };
    const target = f.transfer.captureBaselineImportTarget(), before = JSON.stringify(f.settings);
    const plan = f.transfer.planBaselineImport(backup, ['source_A'], target);
    assert.equal(plan.freeSlots, 0); assert.equal(plan.canImport, false);
    assert.throws(() => f.transfer.applyBaselineImport(backup, ['source_A'], target), /공간이 부족/);
    assert.equal(JSON.stringify(f.settings), before);
}
for (const change of ['chat', 'character', 'card', 'baseline', 'pending']) {
    const f = await setup(), target = f.transfer.captureBaselineImportTarget();
    if (change === 'chat') f.env.context.chatId = 'chat_B';
    if (change === 'character') f.env.context.characters[0].avatar = 'other.png';
    if (change === 'card') f.env.context.characters[0].data.description += ' changed';
    if (change === 'baseline') f.settings.characterBaselines[f.identity.key].fields.core_identity.text += ' edited';
    if (change === 'pending') f.m.namespace('core/runtime.js').characterBaselinePendingTasks.set(f.identity.key, 'anchor');
    assert.throws(() => f.transfer.applyBaselineImport(backup, ['source_A'], target), /변경|끝난 뒤/);
    assert.equal(Object.keys(f.settings.characterBaselineVersions[f.identity.key]?.versions || {}).length, 0);
}
for (const mutate of [
    r => { r.formatVersion = 2; }, r => { r.versions = Array(11).fill(r.versions[0]); },
    r => { r.original.fields.core_identity.text = 'x'.repeat(1001); },
    r => { r.original.fields.core_identity.pinned = 'yes'; },
    r => { r.original.fields.unknown = { text: 'unsupported' }; },
    r => { r.versions[1].id = r.versions[0].id; },
    r => { r.original.fields = {}; }, r => { r.versions = {}; },
]) {
    const data = clone(raw); mutate(data);
    assert.throws(() => source.transfer.parseCharacterBackup(JSON.stringify(data)));
}
assert.throws(() => source.transfer.parseCharacterBackup('{bad json'));
assert.throws(() => source.transfer.parseCharacterBackup('{"__proto__":{}}'));
assert.throws(() => source.transfer.parseCharacterBackup('x'.repeat(2 * 1024 * 1024 + 1)));
assert.equal(source.transfer.parseCharacterBackup('\uFEFF' + encoded).entries.length, 3);
console.log('Baseline backup: original/revision/anchor round trip, pin/freshness/lineage preservation, no keys/chat, duplicate/name conflicts, capacity, atomic failure, context guards and untrusted file validation passed.');

// The actual browser event handlers must preview and wait for an explicit apply.
{
    const f = await setup(), ui = f.m.namespace('ui/baseline-backup.js');
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.textContent = ''; this.hidden = false; this.disabled = false; }
        append(...nodes) { this.children.push(...nodes); }
        appendChild(node) { this.children.push(node); }
        replaceChildren(...nodes) { this.children = nodes; }
        addEventListener(name, fn) { this.events[name] = fn; }
        setAttribute(name, value) { this[name] = value; }
        remove() { this.removed = true; }
        click() { return this.emit('click'); }
        emit(name) { return this.events[name]?.({ currentTarget: this, target: this, stopPropagation() {} }); }
    }
    const ids = Object.fromEntries(['export', 'import', 'import-file', 'backup-status', 'import-preview'].map(k => [`#rp-baseline-${k}`, new Element(k === 'import-file' ? 'input' : 'div')]));
    let editing = false;
    const root = { isConnected: true, querySelector: selector => selector.startsWith('.rp-character-field-text') ? editing ? {} : null : ids[selector] || null };
    let downloaded;
    f.env.globals.document.createElement = tag => new Element(tag);
    f.env.globals.document.body = new Element('body');
    f.env.globals.Blob = Blob;
    f.env.globals.URL = { createObjectURL(blob) { downloaded = blob; return 'blob:test'; }, revokeObjectURL() {} };
    f.env.globals.setTimeout = fn => { fn(); return 1; };
    ui.wireBaselineBackupControls(root);
    await ids['#rp-baseline-export'].click();
    assert.equal(JSON.parse(await downloaded.text()).format, 'storybooster-character-baselines');
    const file = ids['#rp-baseline-import-file'], status = ids['#rp-baseline-backup-status'], preview = ids['#rp-baseline-import-preview'];
    const descendants = node => [node, ...node.children.flatMap(descendants)];
    file.files = [{ size: Buffer.byteLength(encoded), text: async () => encoded }];
    const before = JSON.stringify(f.settings);
    await file.emit('change');
    assert.equal(preview.hidden, false); assert.equal(JSON.stringify(f.settings), before, 'Preview does not import');
    const cancel = descendants(preview).find(n => n.tag === 'button' && n.textContent === '취소');
    await cancel.click(); assert.equal(preview.hidden, true); assert.equal(JSON.stringify(f.settings), before);
    await file.emit('change');
    const boxes = descendants(preview).filter(n => n.tag === 'input' && n.type === 'checkbox');
    boxes[2].checked = false; await boxes[2].emit('change');
    const apply = descendants(preview).find(n => n.tag === 'button' && n.textContent === '선택 항목 가져오기');
    assert.equal(apply.disabled, false); await apply.click();
    assert.equal(Object.keys(f.settings.characterBaselineVersions[f.identity.key].versions).length, 1);
    assert.equal(preview.hidden, true); assert.match(status.textContent, /1개를 가져왔습니다/);
    editing = true; await ids['#rp-baseline-export'].click(); assert.match(status.textContent, /편집 중/); editing = false;
    file.files = [{ size: 3 * 1024 * 1024, text: () => { throw new Error('Must not read oversized file'); } }];
    await file.emit('change'); assert.match(status.textContent, /2MB/);
    let resolveRead;
    file.files = [{ size: 1, text: () => new Promise(resolve => { resolveRead = resolve; }) }];
    const reading = file.emit('change'); f.env.context.chatId = 'chat_B'; resolveRead(encoded); await reading;
    assert.match(status.textContent, /변경/); assert.equal(preview.hidden, true);
    assert.equal(f.env.requests.length, 0); assert.equal(f.bodies.length, 0);
}
console.log('Backup UI: download, preview without writes, checkboxes, explicit apply, cancellation, edit guard, oversized file and delayed read after chat change passed.');

// An empty destination preserves intentionally identical copies within one backup.
{
    const f = await setup(); delete f.settings.characterBaselines[f.identity.key];
    f.settings.characterBaselineVersions[f.identity.key] = { nextNumber: Number.MAX_SAFE_INTEGER, versions: {} };
    const data = clone(raw); data.versions[0].baseline = clone(data.original); data.versions[1].baseline = clone(data.original);
    const parsed = f.transfer.parseCharacterBackup(JSON.stringify(data));
    f.transfer.applyBaselineImport(parsed, ['', 'source_A', 'source_B'], f.transfer.captureBaselineImportTarget());
    const store = f.settings.characterBaselineVersions[f.identity.key];
    assert.equal(Object.keys(store.versions).length, 2); assert.ok(Number.isSafeInteger(store.nextNumber));
}
// A bad later entry cannot leave the valid earlier entry partially imported.
{
    const f = await setup(), target = f.transfer.captureBaselineImportTarget(), before = JSON.stringify(f.settings);
    const invalid = clone(backup); invalid.entries[2].baseline.fields.core_identity.text = 'x'.repeat(1001);
    assert.throws(() => f.transfer.applyBaselineImport(invalid, ['source_A', 'source_B'], target));
    assert.equal(JSON.stringify(f.settings), before);
}
console.log('Backup boundary checks: identical named copies, exhausted counters and no partial commit passed.');
