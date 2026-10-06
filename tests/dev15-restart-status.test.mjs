import { sharedBrowserStorage } from './helpers/browser-storage.mjs';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { environment, loadModules } from './vm-harness.mjs';
import { atomicIndexedDB } from './helpers/atomic-indexeddb.mjs';
import { fixture as diagnosisFixture } from './helpers/diagnosis-fixture.mjs';

const origin = 'http://localhost:8000';
const key = 'synthetic-restart-key';
const stableScope = JSON.stringify([origin, 'default-user', 'accounts-disabled-v1']);
const oldScope = created => JSON.stringify([origin, 'default-user', created]);
async function fixture(db, options = {}) {
    const { created = 1, crypto = webcrypto, handle = 'default-user' } = options;
    const accountsEnabled = Object.hasOwn(options, 'accountsEnabled') ? options.accountsEnabled : false;
    const env = environment(), account = { handle, created }, bodies = [];
    env.st.accountsEnabled = accountsEnabled;
    env.settings['rp-genre-plot-booster'] = { settingsSchemaVersion: 25, jevEnabled: true, jevConsentVersion: 1 };
    env.context.getRequestHeaders = () => ({ 'X-CSRF-Token': 'synthetic' });
    Object.assign(env.globals, { crypto, indexedDB: db.indexedDB, localStorage: sharedBrowserStorage(db).storage, location: { origin }, TextEncoder, TextDecoder });
    env.globals.fetch = async (url, options) => {
        if (url === '/api/users/me') return { ok: true, json: async () => ({ ...account }) };
        assert.equal(url, '/api/backends/chat-completions/generate');
        bodies.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ answers: { connection_test: { type: 'noul', noul: 1 } } }) };
    };
    const m = await loadModules(env);
    return { env, m, account, bodies, client: m.namespace('core/jev-client.js'), vault: m.namespace('core/jev-vault.js') };
}

// Match ST's accounts-disabled profile: created changes on every server start.
// A fresh browser module graph restores without re-saving/testing the key.
{
    const db = atomicIndexedDB(), before = await fixture(db, { created: 100 });
    await before.client.saveJevKey(key);
    assert.ok(sharedBrowserStorage(db).records.has('storybooster-jev-key-v2:' + stableScope));
    before.account.created = 200;
    await before.client.testJevConnection(); // Also survives restart in an open tab.
    assert.equal(before.client.hasJevSessionKey(), true);
    const after = await fixture(db, { created: 300 });
    assert.equal(await after.client.ensureJevKeyReady(), true);
    assert.equal(after.bodies.length, 0, 'Restoration needs no Jev request');
    assert.equal(after.client.getJevConnectionBadge(true).text, 'Jev 사용 준비됨');
    await after.client.testJevConnection();
    assert.equal(JSON.parse(after.bodies[0].custom_include_headers).Authorization, `Bearer ${key}`);
    assert.equal(JSON.parse(sharedBrowserStorage(db).records.get('storybooster-jev-key-v2:' + stableScope)).key, key);
    assert.ok(!after.m.namespace('core/audit-run-trace.js').buildAuditRunReport().includes(key));
}

// Old default-user ciphertext must be decrypted with OLD AAD and re-encrypted,
// never relabeled. Only the same origin/default-user legacy records qualify.
{
    const db = atomicIndexedDB(), seed = await fixture(db);
    await seed.vault.saveJevVaultRecord(oldScope(100), 'older-synthetic-key');
    await seed.vault.saveJevVaultRecord(oldScope(200), key);
    const foreign = JSON.stringify(['http://localhost:8001', 'default-user', 999]);
    const other = JSON.stringify([origin, 'other-user', 999]);
    await seed.vault.saveJevVaultRecord(foreign, 'foreign-synthetic-key');
    await seed.vault.saveJevVaultRecord(other, 'other-synthetic-key');
    const before = db.records.get(oldScope(200));
    const migrated = await fixture(db, { created: 300 });
    assert.equal(await migrated.client.restoreJevKey(), true);
    assert.equal(await migrated.vault.readJevVaultRecord(stableScope), '', 'Encrypted source retired after verified plaintext migration');
    assert.ok(before.ciphertext); assert.equal(db.records.get(stableScope).deleted, true);
    assert.equal(db.records.get(oldScope(200)).deleted, true);
    assert.equal(await migrated.vault.readJevVaultRecord(foreign), 'foreign-synthetic-key');
    assert.equal(await migrated.vault.readJevVaultRecord(other), 'other-synthetic-key');
    await migrated.client.deleteJevKey();
    const again = await fixture(db, { created: 400 });
    assert.equal(await again.client.restoreJevKey(), false, 'Older surviving record cannot undo deletion');
    assert.equal(db.records.get(stableScope).deleted, true);
}

// Preserve account isolation when accounts are enabled or the mode is unknown,
// including a real default-user account deleted and recreated under that name.
for (const accountsEnabled of [true, undefined]) {
    const db = atomicIndexedDB(), first = await fixture(db, { accountsEnabled });
    await first.client.saveJevKey(key);
    const recreated = await fixture(db, { accountsEnabled, created: 2 });
    assert.equal(await recreated.client.restoreJevKey(), false);
    assert.equal(db.records.has(stableScope), false);
    const unchanged = await fixture(db, { accountsEnabled });
    assert.equal(await unchanged.client.restoreJevKey(), true);
}
{
    const db = atomicIndexedDB(), other = await fixture(db, { handle: 'other-user' });
    assert.equal(await other.vault.resolveJevVaultScope(), JSON.stringify([origin, 'other-user', 1]));
}

// A legacy deletion marker wins over older keys; corrupt newest ciphertext
// fails visibly instead of silently falling back to an older credential.
for (const deleted of [true, false]) {
    const db = atomicIndexedDB(), seed = await fixture(db);
    await seed.vault.saveJevVaultRecord(oldScope(1), 'older-synthetic-key');
    await seed.vault.saveJevVaultRecord(oldScope(2), key);
    if (deleted) await seed.vault.deleteJevVaultRecord(oldScope(2));
    else db.records.get(oldScope(2)).ciphertext = new Uint8Array([1]).buffer;
    const after = await fixture(db, { created: 3 });
    assert.equal(await after.client.restoreJevKey(), false);
    assert.equal(after.client.getJevCredentialState(), deleted ? 'missing' : 'error');
    assert.equal(db.records.has(stableScope), deleted);
}

// Failed migration commits keep the complete old record; retry can recover it.
{
    const db = atomicIndexedDB(), seed = await fixture(db);
    await seed.vault.saveJevVaultRecord(oldScope(1), key);
    db.faults.commit = true;
    await assert.rejects(seed.vault.readJevVaultRecord(stableScope));
    assert.ok(db.records.get(oldScope(1)).ciphertext); assert.equal(db.records.has(stableScope), false);
    db.faults.commit = false;
    assert.equal(await seed.vault.readJevVaultRecord(stableScope), key);
}

// A deletion or replacement while migration is encrypting cannot be undone.
// Deliberately cross module instances to model independent browser tabs.
for (const change of ['legacy_deleted', 'target_deleted', 'target_replaced']) {
    const db = atomicIndexedDB(), seed = await fixture(db);
    await seed.vault.saveJevVaultRecord(oldScope(1), key);
    let started, release;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const crypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), subtle: {
        generateKey: webcrypto.subtle.generateKey.bind(webcrypto.subtle),
        decrypt: webcrypto.subtle.decrypt.bind(webcrypto.subtle),
        encrypt: async (...args) => { started(); await gate; return webcrypto.subtle.encrypt(...args); },
    } };
    const after = await fixture(db, { created: 2, crypto });
    const migrating = after.vault.readJevVaultRecord(stableScope);
    await entered;
    if (change === 'legacy_deleted') await seed.vault.deleteJevVaultRecord(oldScope(1));
    if (change === 'target_deleted') await seed.vault.deleteJevVaultRecord(stableScope);
    if (change === 'target_replaced') await seed.vault.saveJevVaultRecord(stableScope, 'synthetic-replacement-key');
    release();
    if (change === 'legacy_deleted') {
        await assert.rejects(migrating);
        assert.equal(db.records.has(stableScope), false);
        assert.equal(await seed.vault.readJevVaultRecord(stableScope), '');
    } else {
        assert.equal(await migrating, change === 'target_deleted' ? '' : 'synthetic-replacement-key');
        assert.equal(db.records.get(stableScope).deleted === true, change === 'target_deleted');
    }
}

// Old persisted wording is not evidence of a current hold. Normalization
// removes it without changing the enabled setting or independent plot policy.
{
    const f = await diagnosisFixture(), auto = f.m.namespace('features/automatic-plot.js');
    f.state.automaticPlot = { enabled: true, status: 'deferred', lastAppliedCount: 7,
        lastDecision: '장르·캐릭터 진단에 판단 보류 항목이 있어 사건 삽입을 기다립니다.' };
    auto.ensureAutomaticPlotSettings(f.state);
    assert.equal(f.state.automaticPlot.enabled, true); assert.equal(f.state.automaticPlot.lastAppliedCount, 7);
    assert.equal(auto.getAutomaticPlotStatusText(), '이번에는 자동 랜덤박스를 준비하지 않았습니다.');
    const status = f.m.namespace('features/plot-status.js');
    assert.match(status.plotAuditHoldReason({ correctionCodes: ['continuity'] }), /캐릭터 보정을 우선/);
    assert.ok(!status.plotAuditHoldReason({ uncertain: ['repetition'] }).includes('판단 보류 항목이 있어'));
    const blocked = { quiet_progress: 'yes' };
    assert.match(status.plotDecisionReason(blocked), /준비하지 않습니다/);
    assert.match(status.plotDecisionReason(blocked, { prepared: true }), /적용하지 않습니다/);
}

// Ordinary execution, with developer mode locked, explains the cancellation
// and keeps the actual guard in private traces. No administrator hint appears.
{
    const f = await diagnosisFixture(), trace = f.m.namespace('core/audit-run-trace.js');
    let started, release;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    f.env.context.generateRawData = async () => { started(); await gate; return JSON.stringify(f.feedback()); };
    const running = f.audit.runGenreDriftAudit('chat_A', f.selection(), { manual: false, scope: 'combined' });
    await entered;
    f.env.context.chat.at(-1).mes += ' Synthetic edit.'; release();
    const result = await running;
    assert.equal(result.reason, 'messages_changed'); assert.equal(result.metrics.resultSaved, false);
    const notice = f.env.notices.find(n => String(n[1]).includes('적용이 취소'));
    assert.ok(notice); assert.match(notice[1], /대화 내용이나 메시지 수가 바뀌/);
    assert.ok(!/개발자|관리자|디버그/.test(notice[1]));
    assert.equal(trace.readAuditRuns()[0].reason, 'messages_changed');
    assert.match(trace.auditCancellationMessage('plot_epoch_changed', 'generation_stopped'), /응답 생성이 중단/);
    assert.ok(!trace.auditCancellationMessage('arbitrary-secret').includes('arbitrary-secret'));
}
console.log('dev.15: server restart restoration, anonymous legacy migration/AAD, account and origin isolation, tombstones, corrupt/failed/racing migration, obsolete status copy and ordinary cancellation reasons passed. Android verification remains manual.');
