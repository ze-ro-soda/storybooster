import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { environment, loadModules } from './vm-harness.mjs';
import { atomicIndexedDB } from './helpers/atomic-indexeddb.mjs';
import { fixture } from './helpers/diagnosis-fixture.mjs';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const pause = () => new Promise(resolve => setImmediate(resolve));
const normal = (id, q) => id.includes('__facet_') ? 'yes' : id.includes('__') ? 'positive' : Object.hasOwn(q.criteria, 'stable') ? 'stable' : 'present';

// Deferred is not healthy in the notification, saved record or reloaded record.
{
    const f = await fixture();
    f.decide((id, q) => id === 'character_consistency' ? 'context_missing' : normal(id, q));
    f.env.responses([JSON.stringify(f.feedback('character'))]);
    await f.audit.runGenreDriftAudit('chat_A', f.audit.getScopedAuditSelection(f.selection(), 'character'), { manual: true, scope: 'character' });
    const record = f.state.genreAnchor.lastCharacterAudit;
    assert.ok(record.uncertain.includes('character_consistency'));
    assert.equal(record.status, 'deferred');
    assert.equal(f.state.genreAnchor.auditStatus, 'deferred');
    assert.match(f.env.notices.at(-1).join(' '), /판단 보류/);
    assert.equal(f.storage.normalizeGenreAuditRecord(record).status, 'deferred');
    assert.equal(f.storage.normalizeGenreAuditRecord({ ...record, status: 'stable' }).status, 'deferred');
}

// Schema, prompt and parser agree at the summary boundary.
{
    const f = await fixture();
    const result = await f.run('character'); result.correctionCodes = ['character_consistency'];
    for (const length of [9, 10, 140, 141, 180]) {
        const payload = f.feedback('character', result.correctionCodes);
        payload.next_corrections.character_consistency = 'a'.repeat(length);
        const action = () => f.diagnosis.writeJevFeedback(result, f.audit.getScopedAuditSelection(f.selection(), 'character'), 'test', async options => {
            const limits = options.jsonSchema.schema.properties.next_corrections.properties.character_consistency;
            assert.equal(limits.minLength, 10); assert.equal(limits.maxLength, 140);
            return options.parseResult(JSON.stringify(payload));
        }, 'en');
        if (length < 10 || length > 140) await assert.rejects(action, e => e.code === 'STORYBOOSTER_INVALID_FIELDS');
        else assert.equal((await action()).correctionSummaries.character_consistency.length, length);
    }
}

// Invalid saved collection types are sanitized without stopping initialization.
for (const correctionCodes of ['primary_genre', {}, 7, null]) {
    const env = environment();
    env.settings['rp-genre-plot-booster'] = { settingsSchemaVersion: 25,
        chats: { chat_A: { genreAnchor: { lastAudit: { createdAt: Date.now(), correctionCodes } } } } };
    const m = await loadModules(env); await env.ready[0]();
    assert.equal(env.errors.length, 0); assert.equal(env.listeners.get('MESSAGE_RECEIVED').length, 1);
    assert.deepEqual([...m.namespace('core/storage.js').ensureChatState().genreAnchor.lastAudit.correctionCodes], []);
}

// Reload drops only transient auto-plot status. Completed history survives.
for (const status of ['observing', 'preparing', 'ready', 'applied']) {
    const env = environment();
    env.settings['rp-genre-plot-booster'] = { settingsSchemaVersion: 25,
        chats: { chat_A: { automaticPlot: { enabled: true, status, lastAppliedCount: 7 } } } };
    const m = await loadModules(env); await env.ready[0]();
    const auto = m.namespace('features/automatic-plot.js');
    assert.equal(m.namespace('core/automatic-plot-state.js').automaticPlotRuntime.pending, null);
    assert.equal(auto.getAutomaticPlotStatusText(), status === 'applied' ? '1회 반영 완료' : '');
    assert.equal(auto.ensureAutomaticPlotSettings().lastAppliedCount, 7);
}
// Explicit cancellation also resets the persisted status of its owner chat.
{
    const f = await fixture();
    const auto = f.m.namespace('features/automatic-plot.js');
    const { automaticPlotRuntime: rt, cancelAutomaticPlot } = f.m.namespace('core/automatic-plot-state.js');
    rt.state = f.state;
    f.state.automaticPlot = { enabled: true, status: 'ready', lastDecision: 'candidate ready' };
    rt.pending = { chatId: 'chat_A' };
    cancelAutomaticPlot();
    assert.equal(auto.getAutomaticPlotStatusText(), ''); assert.equal(rt.pending, null);
    assert.equal(f.state.automaticPlot.status, 'idle');
}

// Completed correction text must not promise another future application.
for (const scope of ['genre', 'character']) {
    const f = await fixture();
    const code = scope === 'genre' ? 'primary_genre' : 'character_consistency';
    const recordKey = scope === 'genre' ? 'lastGenreAudit' : 'lastCharacterAudit';
    const prefix = scope === 'genre' ? 'rp-last-audit' : 'rp-character-last-audit';
    const a = f.state.genreAnchor;
    a.correctionCodes = [code]; a.correctionRemaining = 1; a.correctionAppliedMessageId = 19;
    a[recordKey] = { status: 'applied', correctionCodes: [code], correctionSummaries: { [code]: 'Make the established motive visible through a choice.' },
        ratings: { [code]: 'attention' }, reasons: {}, uncertain: [], createdAt: Date.now() };
    const dom = new Map([prefix, prefix + '-correction', prefix + '-status'].map(k => ['#' + k, {}]));
    f.m.runtime.activeBoosterPopupRoot = { isConnected: true, querySelector: sel => dom.get(sel) || null };
    const render = f.m.namespace('ui/panels.js')[scope === 'genre' ? 'renderLastGenreAudit' : 'renderLastCharacterAudit'];
    render(f.state);
    assert.match(dom.get('#' + prefix + '-correction').textContent, /^적용한 보정/);
    a.correctionCodes = []; a.correctionRemaining = 0; a.correctionAppliedMessageId = null;
    render(f.state);
    assert.match(dom.get('#' + prefix + '-correction').textContent, /^적용한 보정/);
    a.correctionCodes = [code]; a.correctionRemaining = 1; a[recordKey].status = 'pending';
    render(f.state);
    assert.match(dom.get('#' + prefix + '-correction').textContent, /^다음 보정/);
}

// Partial uncertainty is excluded when the remaining evidence is sufficient.
{
    const f = await fixture();
    f.decide((id, q) => id === 'character_consistency__1' ? 'uncertain' : normal(id, q));
    const result = await f.run('character');
    assert.ok(!result.uncertain.includes('character_consistency'));
    assert.equal(result.ratings.character_consistency, 'stable');
}

// Both ordinary legacy and Jev fallback must discard a result after new input.
for (const useJev of [true, false]) {
    const f = await fixture();
    if (!useJev) f.client.setJevUsageConsent(false);
    f.env.globals.fetch = async () => ({ ok: false, status: 503 });
    const started = deferred(), response = deferred();
    f.env.context.generateRawData = async () => { started.resolve(); return response.promise; };
    const schema = f.audit.buildGenreAuditJsonSchema('genre', 'en');
    const raw = f.diagnosis.createEmptyJevPayload(schema);
    for (const k of ['primary_genre', 'genre_expression', 'scene_density']) {
        raw[k] = 'present'; raw[k + '_evidence'] = [1, 2, 3, 4]; raw[k + '_reason'] = 'Concrete supporting evidence in the earlier window.';
    }
    raw.primary_genre = 'weak'; raw.primary_genre_evidence = [];
    raw.primary_genre_failure_evidence = [8, 9, 10]; raw.support_texture = 'dormant';
    const run = f.audit.runGenreDriftAudit('chat_A', f.audit.getScopedAuditSelection(f.selection(), 'genre'), { manual: true, scope: 'genre' });
    await started.promise;
    f.env.context.chat.push({ is_user: true, mes: 'A new situation materially changes this scene.' });
    response.resolve(JSON.stringify(raw)); await run;
    assert.equal(f.state.genreAnchor.lastGenreAudit, null);
    assert.equal(f.state.genreAnchor.correctionRemaining, 0);
}

function vaultFixtures({ broadcast = true, db = atomicIndexedDB() } = {}) {
    const channels = new Set();
    class Channel {
        constructor(name) { this.name = name; channels.add(this); }
        postMessage(data) { for (const c of channels) if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage?.({ data: structuredClone(data) })); }
    }
    async function create({ crypto = webcrypto, accountGate } = {}) {
        const env = environment();
        env.settings['rp-genre-plot-booster'] = { settingsSchemaVersion: 25, jevEnabled: true, jevConsentVersion: 1 };
        env.context.getRequestHeaders = () => ({ 'X-CSRF-Token': 'synthetic-csrf' });
        Object.assign(env.globals, { crypto, indexedDB: db.indexedDB, BroadcastChannel: broadcast ? Channel : undefined,
            location: { origin: 'http://localhost:8000' }, TextEncoder, TextDecoder });
        env.globals.fetch = async url => {
            assert.equal(url, '/api/users/me'); if (accountGate) await accountGate.promise;
            return { ok: true, json: async () => ({ handle: 'test-user', created: 1 }) };
        };
        const m = await loadModules(env);
        return { env, m, client: m.namespace('core/jev-client.js'), vault: m.namespace('core/jev-vault.js') };
    }
    return { create, db };
}

// Slow optional credential restore does not block anchors or message handlers.
{
    const { create } = vaultFixtures();
    const gate = deferred(); const f = await create({ accountGate: gate });
    await f.env.ready[0](); await pause();
    assert.ok(f.env.prompts.length > 0); assert.equal(f.env.listeners.get('MESSAGE_RECEIVED').length, 1);
    gate.resolve(); await f.vault.serializeJevVault(() => {});
}

// Deletion wins over older encryption with and without BroadcastChannel.
for (const broadcast of [true, false]) {
    const { create, db } = vaultFixtures({ broadcast });
    let encryptGate;
    const reached = deferred();
    const crypto = { getRandomValues: a => webcrypto.getRandomValues(a), subtle: {
        generateKey: (...args) => webcrypto.subtle.generateKey(...args), decrypt: (...args) => webcrypto.subtle.decrypt(...args),
        encrypt: async (...args) => { if (encryptGate) { reached.resolve(); await encryptGate.promise; } return webcrypto.subtle.encrypt(...args); },
    } };
    const a = await create({ crypto }); await a.client.saveJevKey('synthetic-old-key');
    const b = await create(); await b.client.restoreJevKey();
    encryptGate = deferred(); const saving = a.client.saveJevKey('synthetic-new-key');
    await reached.promise; await b.client.deleteJevKey(); await pause();
    encryptGate.resolve(); assert.equal(await saving, false);
    assert.ok([...db.records.values()].every(r => r.deleted && !r.key && !r.ciphertext));
    const c = await create(); assert.equal(await c.client.restoreJevKey(), false);
    // A deliberate new save after deletion is allowed and survives refresh.
    assert.equal(await c.client.saveJevKey('synthetic-fresh-key'), true);
    const d = await create(); assert.equal(await d.client.restoreJevKey(), true);
    await c.client.deleteJevKey();
    // create() rejects any relay POST, so this proves the stale key is stopped
    // before external transmission, including browsers without notifications.
    await assert.rejects(d.client.testJevConnection(), e => ['STORYBOOSTER_JEV_CANCELLED', 'STORYBOOSTER_JEV_KEY_MISSING'].includes(e.code));
    assert.equal(d.client.hasJevSessionKey(), false);
}

console.log('Stability: stale legacy/fallback, deferred state, summary boundaries, corrupt records, transient plot state, applied labels, sufficient evidence, nonblocking startup and cross-tab deletion passed.');
