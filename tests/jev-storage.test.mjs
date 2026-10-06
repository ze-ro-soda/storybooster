import { browserStorage } from './helpers/browser-storage.mjs';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { environment, loadModules } from './vm-harness.mjs';
import { atomicIndexedDB } from './helpers/atomic-indexeddb.mjs';
const db = atomicIndexedDB();
const browser = browserStorage();
let account = { handle: 'test-user', created: 1 };
const requests = [];
const key = 'synthetic-jev-key-not-real';
async function fixture({ consent = true, support = true } = {}) {
    const env = environment();
    env.settings['rp-genre-plot-booster'] = { settingsSchemaVersion: 25, jevEnabled: consent, jevConsentVersion: consent ? 1 : 0 };
    env.context.getRequestHeaders = () => ({ 'X-CSRF-Token': 'synthetic-csrf' });
    Object.assign(env.globals, { crypto: support ? webcrypto : undefined, indexedDB: db.indexedDB, localStorage: browser.storage,
        location: { origin: 'http://localhost:8000' }, TextEncoder, TextDecoder });
    env.globals.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url === '/api/users/me') return { ok: true, json: async () => ({ ...account }) };
        assert.equal(url, '/api/backends/chat-completions/generate');
        return { ok: true, json: async () => ({ answers: { connection_test: { type: 'noul', noul: 1 } } }) };
    };
    const m = await loadModules(env);
    return { env, m, client: m.namespace('core/jev-client.js'), vault: m.namespace('core/jev-browser-store.js'), legacy: m.namespace('core/jev-vault.js') };
}
const original = await fixture();
await original.client.saveJevKey(key);
assert.equal(requests.length, 1);
assert.equal(requests[0].url, '/api/users/me');
assert.equal(db.records.get(JSON.stringify(['http://localhost:8000', 'test-user', 1])).deleted, true);
const scope = JSON.stringify(['http://localhost:8000', 'test-user', 1]);
const storageKey = 'storybooster-jev-key-v2:' + scope;
assert.equal(JSON.parse(browser.records.get(storageKey)).key, key);
assert.ok(!JSON.stringify(original.env.settings).includes(key));
assert.ok(!original.client.getJevConnectionStatus().includes(key));
assert.equal(await original.vault.readJevVaultRecord(scope), key);
// A new module graph models refresh: persistent record, no prior live key.
const refreshed = await fixture();
assert.equal(refreshed.client.hasJevSessionKey(), false);
assert.equal(await refreshed.client.restoreJevKey(), true);
assert.equal(refreshed.client.getJevConnectionBadge(true).text, 'Jev 사용 준비됨');
await refreshed.client.testJevConnection();
const relay = requests.find(r => r.url.includes('generate'));
assert.equal(JSON.parse(JSON.parse(relay.options.body).custom_include_headers).Authorization, `Bearer ${key}`);
assert.ok(!requests.some(r => r.url.includes('secrets') || r.url.startsWith('https:')));
// Turning use off sends neither context nor credentials, and prevents restore.
const beforeOff = requests.length;
refreshed.client.setJevUsageConsent(false);
await assert.rejects(refreshed.client.testJevConnection(), e => e.code === 'STORYBOOSTER_JEV_CONSENT_REQUIRED');
assert.equal(requests.length, beforeOff);
const disabled = await fixture({ consent: false });
await disabled.env.ready[0]();
assert.equal(requests.length, beforeOff);
assert.equal(disabled.client.hasJevSessionKey(), false);
// Account scopes are distinct, including recreated account creation time.
account = { handle: 'other-user', created: 2 };
const other = await fixture();
assert.equal(await other.client.restoreJevKey(), false);
await other.client.saveJevKey('other-synthetic-key');
assert.equal(db.records.size, 2);
account = { handle: 'test-user', created: 1 };
const changed = await fixture(); await changed.client.restoreJevKey();
account = { handle: 'other-user', created: 2 };
const relayCount = requests.filter(r => r.url.includes('generate')).length;
await assert.rejects(changed.client.testJevConnection());
assert.equal(requests.filter(r => r.url.includes('generate')).length, relayCount);
assert.equal(changed.client.hasJevSessionKey(), false);
// A failed replacement transaction retains the original complete record.
account = { handle: 'test-user', created: 1 };
browser.faults.write = true;
await assert.rejects(original.client.saveJevKey('replacement-synthetic-key'));
assert.equal(await original.vault.readJevVaultRecord(scope), key);
browser.faults.write = false;
// HTTP/no Web Crypto saves are now supported, using only localStorage.
const unsupported = await fixture({ support: false });
await unsupported.client.saveJevKey('unsupported-synthetic-key');
assert.equal(await unsupported.vault.readJevVaultRecord(scope), 'unsupported-synthetic-key');
await original.client.saveJevKey(key);
// Failed deletion clears live usage but truthfully reports remaining storage.
const deleting = await fixture(); await deleting.client.restoreJevKey();
browser.faults.write = true;
await assert.rejects(deleting.client.deleteJevKey());
assert.equal(deleting.client.hasJevSessionKey(), false);
assert.match(deleting.client.getJevConnectionStatus(), /저장본 삭제에 실패/);
assert.equal(db.records.has(scope), true);
browser.faults.write = false;
await deleting.client.deleteJevKey();
assert.equal(JSON.parse(browser.records.get(storageKey)).deleted, true);
assert.equal(JSON.parse(browser.records.get(storageKey)).key, undefined);
assert.equal(JSON.parse(browser.records.get(storageKey)).ciphertext, undefined);
assert.ok([...browser.records].some(([k,v]) => k.includes('other-user') && v.includes('other-synthetic-key')), 'Another account record survives');
const afterDelete = await fixture(); assert.equal(await afterDelete.client.restoreJevKey(), false);
// An overlapping save/delete is serialized; a late save cannot revive deletion.
const overlapping = await fixture();
const saving = overlapping.client.saveJevKey(key).catch(() => false);
const removing = overlapping.client.deleteJevKey();
await Promise.all([saving, removing]);
assert.equal(overlapping.client.hasJevSessionKey(), false);
assert.equal(JSON.parse(browser.records.get(storageKey)).deleted, true);
assert.ok(!JSON.stringify(overlapping.env.errors).includes(key));
console.log('Plaintext browser storage without Web Crypto, refresh, consent, account isolation, scoped storage, failed replacement/deletion, HTTP support and overlapping deletion passed. Browser/Android verification remains manual.');
