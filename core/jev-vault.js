// Encrypted browser-only Jev storage. This does not defend against malicious
// scripts on the same origin or someone who controls the browser/device.
import { accountsEnabled, getContext } from './sillytavern.js';
const DATABASE = 'storybooster-jev-vault';
const STORE = 'credentials';
let queue = Promise.resolve();
export function serializeJevVault(task) {
    const work = queue.then(task, task);
    queue = work.catch(() => {});
    return work;
}
export function supportsJevVault() {
    return Boolean(globalThis.crypto?.subtle && globalThis.indexedDB && globalThis.location?.origin);
}
function vaultError(message = 'Jev 키 저장소를 사용할 수 없습니다. 브라우저 설정을 확인해 주세요.', reason = 'storage') {
    return Object.assign(new Error(message), { code: 'STORYBOOSTER_JEV_STORAGE_ERROR', stage: 'jev_storage', vaultReason: reason });
}
export async function resolveJevVaultScope(signal) {
    const headers = getContext()?.getRequestHeaders?.();
    if (!headers || !globalThis.location?.origin) throw vaultError('현재 SillyTavern 계정을 확인하지 못했습니다.');
    const c = new AbortController();
    const abort = () => c.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 5000);
    try {
        const r = await fetch('/api/users/me', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers, signal: c.signal });
        if (!r.ok) throw vaultError();
        const account = await r.json();
        if (typeof account?.handle !== 'string' || !account.handle.trim() || !Number.isFinite(account.created)) throw vaultError();
        // ST creates this anonymous profile with Date.now() on each server start.
        // Real accounts, including a logged-in default-user, retain created in
        // their scope so deleting/recreating an account cannot inherit its key.
        const identity = accountsEnabled === false && account.handle === 'default-user'
            ? 'accounts-disabled-v1' : account.created;
        return JSON.stringify([globalThis.location.origin, account.handle, identity]);
    } catch { throw vaultError('현재 SillyTavern 계정을 확인하지 못했습니다.', 'account'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function openDatabase() {
    if (!supportsJevVault()) return Promise.reject(vaultError('이 브라우저에서는 키 암호화 저장을 사용할 수 없습니다. HTTPS 또는 localhost와 브라우저 저장소 설정을 확인해 주세요.'));
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, db) => {
            if (settled) { db?.close(); return; }
            settled = true; clearTimeout(timer); error ? reject(vaultError()) : resolve(db);
        };
        const timer = setTimeout(() => finish(true), 5000);
        let request;
        try { request = indexedDB.open(DATABASE, 1); }
        catch { finish(true); return; }
        request.onupgradeneeded = () => {
            try { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'scope' }); }
            catch { finish(true); }
        };
        request.onerror = request.onblocked = () => finish(true);
        request.onsuccess = () => finish(false, request.result);
    });
}
async function transaction(mode, operation, onRead = null) {
    const db = await openDatabase();
    try {
        return await new Promise((resolve, reject) => {
            let tx, output, finished = false;
            const done = error => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(vaultError()) : resolve(output); };
            const timer = setTimeout(() => { try { tx?.abort(); } catch {} done(true); }, 5000);
            try {
                tx = db.transaction(STORE, mode);
                tx.oncomplete = () => done(false);
                tx.onabort = tx.onerror = () => done(true);
                const store = tx.objectStore(STORE);
                const request = operation(store);
                request.onsuccess = () => {
                    try { output = onRead ? onRead(request.result, store) : request.result; }
                    catch { try { tx.abort(); } catch {} done(true); }
                };
                request.onerror = () => { try { tx.abort(); } catch {} done(true); };
            } catch { done(true); }
        });
    } finally { db.close(); }
}
function recordRevision(record) { return record?.revision || 'legacy'; }
function newRevision() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function encryptRecord(scope, value) {
    const bytes = new TextEncoder().encode(value);
    try {
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(scope) }, key, bytes);
        return { scope, format: 1, revision: newRevision(), key, iv, ciphertext };
    } finally { bytes.fill(0); }
}
function anonymousLegacyRecords(records, scope) {
    if (accountsEnabled !== false || scope !== JSON.stringify([globalThis.location?.origin, 'default-user', 'accounts-disabled-v1'])) return [];
    return records.filter(record => {
        try {
            const identity = JSON.parse(record.scope);
            return Array.isArray(identity) && identity.length === 3 && identity[0] === globalThis.location.origin &&
                identity[1] === 'default-user' && Number.isFinite(identity[2]) && identity[2] >= 0;
        } catch { return false; }
    }).sort((a, b) => JSON.parse(b.scope)[2] - JSON.parse(a.scope)[2]);
}
async function migrateAnonymousRecord(scope) {
    const records = await transaction('readonly', store => store.getAll());
    // The most recent server identity wins, including its deletion marker.
    // Never recover an older key after a newer one was explicitly deleted.
    const legacy = anonymousLegacyRecords(records, scope);
    if (!legacy.length) return;
    const latest = legacy[0];
    const value = latest.deleted ? '' : await readJevVaultRecord(latest.scope);
    if (!latest.deleted && !value) throw vaultError('저장 중 키가 변경되었습니다.', 'changed');
    const migrated = latest.deleted ? { scope, deleted: true, revision: newRevision() } : await encryptRecord(scope, value);
    await transaction('readwrite', store => store.getAll(), (current, store) => {
        // Compare all relevant records and the destination in ONE transaction.
        // Concurrent saves/deletions, including other tabs, invalidate migration.
        if (current.some(record => record.scope === scope)) return false;
        const now = anonymousLegacyRecords(current, scope);
        if (now.length !== legacy.length || now.some((record, index) => record.scope !== legacy[index].scope || recordRevision(record) !== recordRevision(legacy[index])))
            throw vaultError('저장 중 키가 변경되었습니다.', 'changed');
        store.put(migrated);
        // Retire the migrated source so an old-version tab cannot use a stale key.
        store.put({ scope: latest.scope, deleted: true, revision: newRevision() });
        return true;
    });
}
export async function saveJevVaultRecord(scope, value, { isCurrent = () => true } = {}) {
    if (!supportsJevVault()) throw vaultError('이 브라우저에서는 키 암호화 저장을 사용할 수 없습니다. HTTPS 또는 localhost와 브라우저 저장소 설정을 확인해 주세요.');
    try {
        const expectedRevision = recordRevision(await transaction('readonly', store => store.get(scope)));
        if (!isCurrent()) return false;
        const encrypted = await encryptRecord(scope, value);
        // Compare and write inside one IndexedDB transaction across ALL tabs.
        // A later deletion/replacement invalidates this encryption even when
        // BroadcastChannel is unavailable or its notification arrives late.
        return await transaction('readwrite', store => store.get(scope), (current, store) => {
            if (!isCurrent() || recordRevision(current) !== expectedRevision) return false;
            store.put(encrypted);
            return true;
        });
    } catch { throw vaultError('Jev 키를 저장하지 못했습니다. 기존 저장본은 유지됩니다.'); }
}
export async function readJevVaultRecord(scope) {
    let record = await transaction('readonly', store => store.get(scope));
    if (!record && accountsEnabled === false && scope === JSON.stringify([globalThis.location?.origin, 'default-user', 'accounts-disabled-v1'])) {
        await migrateAnonymousRecord(scope);
        record = await transaction('readonly', store => store.get(scope));
    }
    if (!record || record.deleted === true) return '';
    let bytes;
    try {
        if (record.format !== 1 || record.key?.extractable !== false || record.key?.algorithm?.name !== 'AES-GCM' || record.key.algorithm.length !== 256 || record.iv?.byteLength !== 12) throw vaultError();
        bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: new TextEncoder().encode(scope) }, record.key, record.ciphertext));
        const current = await transaction('readonly', store => store.get(scope));
        if (!current || current.deleted) return '';
        if (recordRevision(current) !== recordRevision(record)) throw vaultError('저장 중 키가 변경되었습니다.', 'changed');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) { throw vaultError('저장된 Jev 키를 읽지 못했습니다. 저장본은 유지됩니다.', error.vaultReason || 'decrypt'); }
    finally { bytes?.fill(0); }
}
export async function deleteJevVaultRecord(scope) {
    // Retain only a revision marker, never the key or ciphertext. Removing the
    // whole record would allow an older "first save" to resurrect deletion.
    await transaction('readwrite', store => store.put({ scope, deleted: true, revision: newRevision() }));
}
