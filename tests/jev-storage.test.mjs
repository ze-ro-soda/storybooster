import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { environment, loadModules } from './vm-harness.mjs';
import { atomicIndexedDB } from './helpers/atomic-indexeddb.mjs';
const db = atomicIndexedDB();
let account = { handle: 'test-user', created: 1 };
const requests = [];
const key = 'synthetic-jev-key-not-real';
async function fixture({ consent = true, support = true } = {}) {
    const env = environment();
    env.settings['rp-genre-plot-booster'] = { settingsSchemaVersion: 25, jevEnabled: consent, jevConsentVersion: consent ? 1 : 0 };
    env.context.getRequestHeaders = () => ({ 'X-CSRF-Token': 'synthetic-csrf' });
    Object.assign(env.globals, { crypto: support ? webcrypto : undefined, indexedDB: db.indexedDB,
        location: { origin: 'http://localhost:8000' }, TextEncoder, TextDecoder });
    env.globals.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url === '/api/users/me') return { ok: true, json: async () => ({ ...account }) };
        assert.equal(url, '/api/backends/chat-completions/generate');
        return { ok: true, json: async () => ({ answers: { connection_test: { type: 'noul', noul: 1 } } }) };
    };
    const m = await loadModules(env);
    return { env, m, client: m.namespace('core/jev-client.js'), vault: m.namespace('core/jev-vault.js') };
}
const original = await fixture();
await original.client.saveJevKey(key);
assert.equal(requests.length, 1);
assert.equal(requests[0].url, '/api/users/me');
assert.equal(db.records.size, 1);
const [scope, encrypted] = [...db.records][0];
assert.equal(encrypted.key.extractable, false);
assert.equal(encrypted.key.algorithm.name, 'AES-GCM');
assert.equal(encrypted.key.algorithm.length, 256);
assert.equal(encrypted.iv.byteLength, 12);
assert.ok(!JSON.stringify(encrypted).includes(key));
assert.ok(!JSON.stringify(original.env.settings).includes(key));
assert.ok(!original.client.getJevConnectionStatus().includes(key));
await assert.rejects(webcrypto.subtle.exportKey('raw', encrypted.key));
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
db.faults.commit = true;
await assert.rejects(original.client.saveJevKey('replacement-synthetic-key'));
assert.equal(await original.vault.readJevVaultRecord(scope), key);
db.faults.commit = false;
// Copying the ciphertext into another scope fails authenticated decryption.
const tamperedScope = JSON.stringify(['http://localhost:8000', 'tampered', 99]);
db.records.set(tamperedScope, { ...encrypted, scope: tamperedScope });
await assert.rejects(original.vault.readJevVaultRecord(tamperedScope));
db.records.delete(tamperedScope);
// No crypto support means no plaintext fallback.
const unsupported = await fixture({ support: false });
await assert.rejects(unsupported.client.saveJevKey('unsupported-synthetic-key'));
assert.equal(db.records.size, 2);
// Failed deletion clears live usage but truthfully reports remaining storage.
const deleting = await fixture(); await deleting.client.restoreJevKey();
db.faults.commit = true;
await assert.rejects(deleting.client.deleteJevKey());
assert.equal(deleting.client.hasJevSessionKey(), false);
assert.match(deleting.client.getJevConnectionStatus(), /저장본 삭제에 실패/);
assert.equal(db.records.has(scope), true);
db.faults.commit = false;
await deleting.client.deleteJevKey();
assert.equal(db.records.get(scope).deleted, true);
assert.equal(db.records.get(scope).key, undefined);
assert.equal(db.records.get(scope).ciphertext, undefined);
assert.equal([...db.records.values()].filter(r => !r.deleted).length, 1, 'Another account record survives');
const afterDelete = await fixture(); assert.equal(await afterDelete.client.restoreJevKey(), false);
// An overlapping save/delete is serialized; a late save cannot revive deletion.
const overlapping = await fixture();
const saving = overlapping.client.saveJevKey(key).catch(() => false);
const removing = overlapping.client.deleteJevKey();
await Promise.all([saving, removing]);
assert.equal(overlapping.client.hasJevSessionKey(), false);
assert.equal(db.records.get(scope).deleted, true);
assert.ok(!JSON.stringify(overlapping.env.errors).includes(key));
console.log('Real AES-GCM, atomic storage, refresh, consent, account isolation, authenticated scopes, failed replacement/deletion, no plaintext fallback and overlapping deletion passed. Browser/Android verification remains manual.');
