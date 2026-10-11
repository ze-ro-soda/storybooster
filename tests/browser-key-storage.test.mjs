import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { environment, loadModules } from './vm-harness.mjs';
import { atomicIndexedDB } from './helpers/atomic-indexeddb.mjs';
import { browserStorage } from './helpers/browser-storage.mjs';
import { fixture as diagnosisFixture } from './helpers/diagnosis-fixture.mjs';
const KEY = 'synthetic-browser-key';
const ORIGIN = 'http://remote.test:8000';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture({ browser = browserStorage(), db = atomicIndexedDB(), crypto, origin = ORIGIN,
    account = { handle: 'default-user', created: 1 }, accountsEnabled = false, onRelay } = {}) {
    const env = environment(), events = new Map(), relay = [];
    env.st.accountsEnabled = accountsEnabled;
    env.settings['rp-genre-plot-booster'] = { settingsSchemaVersion: 25, jevEnabled: true, jevConsentVersion: 1 };
    env.context.getRequestHeaders = () => ({ 'X-CSRF-Token': 'synthetic' });
    Object.assign(env.globals, { crypto, indexedDB: crypto ? db.indexedDB : undefined,
        localStorage: browser.storage, location: { origin }, TextEncoder, TextDecoder,
        addEventListener: (name, cb) => events.set(name, cb) });
    env.globals.fetch = async (url, options) => {
        if (url === '/api/users/me') return { ok: true, json: async () => ({ ...account }) };
        assert.equal(url, '/api/backends/chat-completions/generate');
        const body = JSON.parse(options.body); relay.push(body);
        if (onRelay) return onRelay(body, options);
        return { ok: true, json: async () => ({ answers: { connection_test: { type: 'noul', noul: 1 } } }) };
    };
    const m = await loadModules(env);
    return { env, m, browser, db, account, events, relay, client: m.namespace('core/jev-client.js'),
        store: m.namespace('core/jev-browser-store.js'), legacy: m.namespace('core/jev-vault.js'),
        trace: m.namespace('core/audit-run-trace.js') };
}

test('remote HTTP saves, restores after server restart and uses the existing relay without Crypto/IDB/plugin', async () => {
    const a = await fixture();
    assert.equal(await a.client.saveJevKey(KEY), true);
    const b = await fixture({ browser: a.browser, account: { handle: 'default-user', created: 900 } });
    await b.env.ready[0](); await b.client.ensureJevKeyReady();
    assert.equal(b.client.hasJevSessionKey(), true); assert.equal(b.relay.length, 0);
    await b.client.testJevConnection();
    assert.equal(JSON.parse(b.relay[0].custom_include_headers).Authorization, `Bearer ${KEY}`);
    assert.equal(b.relay[0].custom_url, 'https://api.typesafe.ai/v1/systemone?via=');
    assert.ok(!JSON.stringify(b.env.settings).includes(KEY));
    assert.ok(!b.trace.buildAuditRunReport().includes(KEY));
    assert.equal(a.db.records.size, 0);
});

test('old encrypted key migrates once, verifies plaintext, retires old key and isolates real accounts', async () => {
    const browser = browserStorage(), db = atomicIndexedDB();
    const a = await fixture({ browser, db, crypto: webcrypto, accountsEnabled: true });
    const scope = await a.legacy.resolveJevVaultScope();
    await a.legacy.saveJevVaultRecord(scope, KEY);
    assert.equal(await a.client.restoreJevKey(), true);
    assert.equal(await a.store.readJevVaultRecord(scope), KEY);
    assert.equal(db.records.get(scope).deleted, true);
    assert.equal(db.records.get(scope).ciphertext, undefined);
    const recreated = await fixture({ browser, db, crypto: webcrypto, accountsEnabled: true,
        account: { handle: 'default-user', created: 2 } });
    assert.equal(await recreated.client.restoreJevKey(), false);
    const other = await fixture({ browser, db, crypto: webcrypto, accountsEnabled: true,
        account: { handle: 'other-user', created: 1 } });
    assert.equal(await other.client.restoreJevKey(), false);
    const anotherOrigin = await fixture({ browser, db, origin: 'http://another.test:8000', accountsEnabled: true });
    assert.equal(await anotherOrigin.client.restoreJevKey(), false);
    await a.client.deleteJevKey();
    await a.legacy.saveJevVaultRecord(scope, KEY); // Simulate an obsolete tab.
    const fresh = await fixture({ browser, db, crypto: webcrypto, accountsEnabled: true });
    assert.equal(await fresh.client.restoreJevKey(), false, 'Persistent plaintext tombstone blocks old-key resurrection');
});

test('blocked storage, quota errors and malformed records fail safely without losing an existing key', async () => {
    const a = await fixture(); await a.client.saveJevKey(KEY);
    a.browser.faults.write = true;
    await assert.rejects(a.client.saveJevKey('synthetic-replacement'));
    assert.ok([...a.browser.records.values()].some(v => v.includes(KEY)));
    await assert.rejects(a.client.deleteJevKey());
    assert.equal(await a.client.ensureJevKeyReady(), false); assert.equal(a.client.hasJevSessionKey(), false);
    a.browser.faults.write = false;
    const b = await fixture({ browser: a.browser }); assert.equal(await b.client.restoreJevKey(), true);
    const recordKey = [...a.browser.records.keys()].find(k => k.startsWith('storybooster-jev-key-v2:'));
    a.browser.records.set(recordKey, '{incomplete');
    assert.equal(await b.client.restoreJevKey(), false); assert.equal(b.client.getJevCredentialState(), 'error');
    await b.client.deleteJevKey(); assert.equal(await b.client.ensureJevKeyReady(), false);
    const blocked = await fixture();
    Object.defineProperty(blocked.env.globals, 'localStorage', { get() { throw new Error(`blocked ${KEY}`); } });
    await assert.rejects(blocked.client.saveJevKey(KEY), error => !error.message.includes(KEY));
    assert.equal(await blocked.client.restoreJevKey(), false);
    assert.ok(!blocked.client.getJevConnectionStatus().includes(KEY));
});

test('deletion or replacement during old-key decryption wins over migration', async () => {
    for (const action of ['delete', 'replace']) {
        const browser = browserStorage(), db = atomicIndexedDB();
        const seed = await fixture({ browser, db, crypto: webcrypto });
        const scope = await seed.legacy.resolveJevVaultScope(); await seed.legacy.saveJevVaultRecord(scope, KEY);
        let started, release;
        const entered = new Promise(r => started = r), gate = new Promise(r => release = r);
        const crypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), subtle: {
            generateKey: webcrypto.subtle.generateKey.bind(webcrypto.subtle),
            encrypt: webcrypto.subtle.encrypt.bind(webcrypto.subtle),
            decrypt: async (...args) => { started(); await gate; return webcrypto.subtle.decrypt(...args); },
        } };
        const a = await fixture({ browser, db, crypto });
        const restoring = a.client.restoreJevKey(); await entered;
        const b = await fixture({ browser });
        if (action === 'delete') await b.client.deleteJevKey();
        else await b.client.saveJevKey('synthetic-new-key');
        release(); await restoring;
        assert.equal(await a.store.readJevVaultRecord(scope), action === 'delete' ? '' : 'synthetic-new-key');
    }
});

test('native storage events reload replacements and remove stale usage even without BroadcastChannel', async () => {
    const a = await fixture(); await a.client.saveJevKey(KEY);
    const b = await fixture({ browser: a.browser }); await b.client.restoreJevKey();
    const key = [...a.browser.records.keys()].find(k => k.startsWith('storybooster-jev-key-v2:'));
    await a.client.saveJevKey('synthetic-native-replacement');
    b.events.get('storage')({ key, newValue: 'must-not-be-read' });
    await b.client.ensureJevKeyReady(); await b.client.testJevConnection();
    assert.equal(JSON.parse(b.relay[0].custom_include_headers).Authorization, 'Bearer synthetic-native-replacement');
    await a.client.deleteJevKey(); b.events.get('storage')({ key }); await tick();
    assert.equal(await b.client.ensureJevKeyReady(), false); assert.equal(b.client.hasJevSessionKey(), false);
});

test('saved key changes block stale transmissions; deletion cancels in-flight responses', async () => {
    const a = await fixture(); await a.client.saveJevKey(KEY);
    const b = await fixture({ browser: a.browser }); await b.client.restoreJevKey();
    await a.client.saveJevKey('synthetic-replacement');
    await assert.rejects(b.client.testJevConnection()); assert.equal(b.relay.length, 0);
    let entered, release;
    const gate = new Promise(r => release = r), ready = new Promise(r => entered = r);
    const c = await fixture({ browser: a.browser, onRelay: async () => {
        entered(); await gate;
        return { ok: true, json: async () => ({ answers: { connection_test: { type: 'noul', noul: 1 } } }) };
    } });
    await c.client.restoreJevKey(); const pending = c.client.testJevConnection(); await ready;
    await c.client.deleteJevKey(); release();
    await assert.rejects(pending, e => e.code === 'STORYBOOSTER_JEV_CANCELLED');
});

test('the actual combined diagnosis uses a persisted HTTP key and saves the validated Jev result', async () => {
    const browser = browserStorage();
    const f = await diagnosisFixture({ configure: env => {
        Object.assign(env.globals, { crypto: undefined, indexedDB: undefined, localStorage: browser.storage, location: { origin: ORIGIN } });
    } });
    const relay = f.env.globals.fetch;
    f.env.globals.fetch = async (url, options) => url === '/api/users/me'
        ? { ok: true, json: async () => ({ handle: 'test-user', created: 1 }) } : relay(url, options);
    assert.equal(await f.client.saveJevKey(KEY), true);
    f.env.context.generateRawData = async () => JSON.stringify(f.feedback());
    const result = await f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: true, scope: 'combined' });
    assert.equal(result.metrics.engine, 'jev'); assert.equal(f.state.genreAnchor.lastAudit.engine, 'jev');
    assert.equal(result.metrics.resultSaved, true); assert.equal(result.metrics.displayUpdated, true);
    assert.equal(f.bodies.length, 2);
    assert.ok(!f.m.namespace('core/audit-run-trace.js').buildAuditRunReport().includes(KEY));
});

test('settings expose three buttons and plaintext notice, retain failed input, and contain no server plugin', () => {
    const ui = fs.readFileSync(new URL('../ui/popup.js', import.meta.url), 'utf8');
    for (const id of ['rp-jev-key-apply', 'rp-jev-test', 'rp-jev-key-delete']) assert.ok(ui.includes(`id="${id}"`));
    assert.match(ui, /이 브라우저에 평문 저장/);
    assert.match(ui, /if \(saved && keyInput\) keyInput.value = ''/);
    for (const file of ['server-plugin', 'core/jev-server.js', 'SERVER-STORAGE.md', 'install-termux.sh'])
        assert.equal(fs.existsSync(new URL('../' + file, import.meta.url)), false);
});
