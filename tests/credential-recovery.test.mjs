import { sharedBrowserStorage } from './helpers/browser-storage.mjs';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { environment, loadModules } from './vm-harness.mjs';
import { atomicIndexedDB } from './helpers/atomic-indexeddb.mjs';
const KEY = 'synthetic-recovery-key';
const tick = () => new Promise(resolve => setImmediate(resolve));
function channels() {
    const peers = [];
    return class Channel {
        constructor(name) { this.name = name; peers.push(this); }
        postMessage(data) { for (const peer of peers) if (peer !== this && peer.name === this.name) queueMicrotask(() => peer.onmessage?.({ data })); }
    };
}
async function fixture(db, { BroadcastChannel, accountRequest } = {}) {
    const env = environment(), bodies = [];
    env.settings['rp-genre-plot-booster'] = { settingsSchemaVersion: 25, jevEnabled: true, jevConsentVersion: 1 };
    env.context.getRequestHeaders = () => ({ 'X-CSRF-Token': 'synthetic' });
    Object.assign(env.globals, { crypto: webcrypto, indexedDB: db.indexedDB, localStorage: sharedBrowserStorage(db).storage, TextEncoder, TextDecoder,
        location: { origin: 'http://localhost:8000' }, BroadcastChannel });
    env.globals.fetch = async (url, options) => {
        if (url === '/api/users/me') {
            if (accountRequest) await accountRequest();
            return { ok: true, json: async () => ({ handle: 'test-user', created: 1 }) };
        }
        const body = JSON.parse(options.body); bodies.push(body);
        return { ok: true, json: async () => ({ answers: { connection_test: { type: 'noul', noul: 1 } } }) };
    };
    const m = await loadModules(env);
    return { env, m, client: m.namespace('core/jev-client.js'), vault: m.namespace('core/jev-vault.js'), trace: m.namespace('core/audit-run-trace.js'), bodies };
}
// Storage is read back before claiming success; a transient startup account
// error is retried, and parallel readers share one restoration.
{
    const db = atomicIndexedDB(), seed = await fixture(db);
    assert.equal(await seed.client.saveJevKey(KEY), true);
    assert.ok(seed.trace.readCredentialEvents().some(e => e.event === 'save_verified'));
    let attempts = 0;
    const fresh = await fixture(db, { accountRequest: async () => { if (++attempts === 1) throw new Error('transient-account-error'); } });
    const a = fresh.client.restoreJevKey(), b = fresh.client.restoreJevKey();
    assert.equal(a, b); assert.equal(await a, true); assert.equal(attempts, 2);
    assert.ok(fresh.trace.readCredentialEvents().some(e => e.event === 'restore_retry' && e.reason === 'account'));
    assert.equal(fresh.client.getJevCredentialState(), 'ready');
    assert.equal(fresh.client.getJevConnectionBadge(true).text, 'Jev 사용 준비됨');
    assert.ok(!fresh.trace.buildAuditRunReport().includes(KEY));
}
// A temporary storage read failure keeps the saved key and reports error,
// then a connection test can recover it without re-entering the key.
{
    const db = atomicIndexedDB(), seed = await fixture(db); await seed.client.saveJevKey(KEY);
    const scope = [...sharedBrowserStorage(db).records.keys()].find(k => k.startsWith('storybooster-jev-key-v2:'));
    const fresh = await fixture(db); sharedBrowserStorage(db).faults.read = true;
    assert.equal(await fresh.client.restoreJevKey(), false);
    assert.equal(fresh.client.getJevCredentialState(), 'error'); assert.ok(sharedBrowserStorage(db).records.get(scope).includes(KEY));
    sharedBrowserStorage(db).faults.read = false; await fresh.client.testJevConnection();
    assert.equal(fresh.client.hasJevSessionKey(), true); assert.equal(fresh.bodies.length, 1);
}
// Cross-tab replacement reloads the new saved key; deletion clears live use and
// never permits an automatic restoration to revive a deleted or failed-delete key.
{
    const db = atomicIndexedDB(), BroadcastChannel = channels();
    const a = await fixture(db, { BroadcastChannel }), b = await fixture(db, { BroadcastChannel });
    await a.client.saveJevKey(KEY); await b.client.restoreJevKey();
    await a.client.saveJevKey('synthetic-replacement-key');
    for (let n = 0; n < 6; n++) await tick();
    assert.equal(await b.client.ensureJevKeyReady(), true);
    await b.client.testJevConnection();
    assert.equal(JSON.parse(b.bodies.at(-1).custom_include_headers).Authorization, 'Bearer synthetic-replacement-key');
    await a.client.deleteJevKey(); await tick();
    assert.equal(b.client.hasJevSessionKey(), false); assert.equal(await b.client.ensureJevKeyReady(), false);
    await a.client.saveJevKey(KEY); await tick(); await b.client.ensureJevKeyReady();
    sharedBrowserStorage(db).faults.write = true;
    await assert.rejects(b.client.deleteJevKey());
    assert.equal(await b.client.ensureJevKeyReady(), false);
    assert.equal(b.client.hasJevSessionKey(), false);
    sharedBrowserStorage(db).faults.write = false;
}
// Starting a diagnosis waits for key restoration before capturing revisions,
// and a second start remains busy while that restoration is in flight.
{
    const db = atomicIndexedDB(), seed = await fixture(db); await seed.client.saveJevKey(KEY);
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const fresh = await fixture(db, { accountRequest: () => { started(); return new Promise(resolve => { release = resolve; }); } });
    const audit = fresh.m.namespace('features/audit.js'), storage = fresh.m.namespace('core/storage.js');
    const state = storage.ensureChatState(); state.genreSelection.primaryId = 'romance';
    const selection = audit.getScopedAuditSelection(audit.getBoosterSelection(state), 'genre');
    const running = audit.runGenreDriftAudit('chat_A', selection, { scope: 'genre' });
    await ready;
    const busy = await audit.runGenreDriftAudit('chat_A', selection, { scope: 'genre' });
    assert.equal(busy.reason, 'busy'); assert.equal(fresh.bodies.length, 0);
    // A chat edit during restoration cancels the request before any RP is sent.
    fresh.env.context.chat[1].mes = 'Edited during key restoration'; release();
    const result = await running;
    assert.equal(result.reason, 'messages_changed'); assert.equal(fresh.bodies.length, 0);
    assert.ok(!fresh.trace.buildAuditRunReport().includes(KEY));
}
console.log('Credential recovery: verified browser saves, deduplicated retries, read errors vs missing, cross-tab replacement/deletion, failed-delete safety, pre-audit waits, busy guards and private traces passed.');
