// User-approved plaintext localStorage persistence. The legacy encrypted vault
// is used only to migrate an existing key; normal saves need no Web Crypto/IDB.
import { supportsLegacyJevVault as supportsEncryptedVault, serializeJevVault, resolveJevVaultScope,
    readLegacyJevVaultRecord as readEncryptedRecord, deleteLegacyJevVaultRecord as deleteEncryptedRecord } from './jev-vault.js';
import { getJevProviderConfig } from './jev-providers.js';
export { serializeJevVault, resolveJevVaultScope };
const PREFIX = 'storybooster-jev-key-v2:';
const STAMP = 'storybooster-jev-write-v2';
const NANO_PREFIX = 'storybooster-jev-key-nanogpt-v1:';
function keyPrefix(provider = 'typesafe') { getJevProviderConfig(provider); return provider === 'nanogpt' ? NANO_PREFIX : PREFIX; }
function stampKey(provider = 'typesafe') { getJevProviderConfig(provider); return provider === 'nanogpt' ? STAMP + ':nanogpt' : STAMP; }
let sequence = 0;
function storageError(reason = 'storage') {
    return Object.assign(new Error('Jev 키를 브라우저에 저장하거나 읽지 못했습니다. 브라우저의 사이트 저장소 설정을 확인해 주세요.'),
        { code: 'STORYBOOSTER_JEV_STORAGE_ERROR', stage: 'jev_storage', vaultReason: reason });
}
function storage() {
    try { if (globalThis.localStorage && globalThis.location?.origin) return globalThis.localStorage; }
    catch { /* Do not expose browser exceptions or saved values. */ }
    throw storageError();
}
export function supportsJevVault() {
    try { storage(); return true; } catch { return false; }
}
export function jevStorageEventScope(key) {
    const prefix = keyPrefix(jevStorageEventProvider(key));
    return typeof key === 'string' && key.startsWith(prefix) ? key.slice(prefix.length) : '';
}
export function jevStorageEventProvider(key) {
    return typeof key === 'string' && key.startsWith(NANO_PREFIX) ? 'nanogpt' : 'typesafe';
}
export function getJevStorageRevision(provider = 'typesafe') {
    try { return storage().getItem(stampKey(provider)) || ''; } catch { throw storageError(); }
}
function validateKey(value) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw storageError();
    return value;
}
function readRaw(scope, provider) {
    try { return storage().getItem(keyPrefix(provider) + scope); } catch { throw storageError(); }
}
function parseRecord(raw) {
    if (raw === null) return null;
    try {
        if (typeof raw !== 'string' || raw.length > 4096) throw storageError();
        const record = JSON.parse(raw);
        if (record?.format !== 2 || typeof record.revision !== 'string' || !record.revision || typeof record.deleted !== 'boolean') throw storageError();
        if (record.deleted) { if (Object.hasOwn(record, 'key')) throw storageError(); }
        else validateKey(record.key);
        return record;
    } catch { throw storageError(); }
}
// Non-secret per-account write identity for deletion/re-save notifications.
export function getJevStoredRecordState(scope, provider = 'typesafe') {
    const record = parseRecord(readRaw(scope, provider));
    return record ? { revision: record.revision, deleted: record.deleted } : null;
}
function newRecord(key, provider) {
    // A revision identifies a write, not a cryptographic credential. No secure
    // context API is required, including in remote HTTP web apps.
    const savedSequence = Number(getJevStorageRevision(provider).split('-').at(-1));
    sequence = Math.max(sequence, Number.isSafeInteger(savedSequence) && savedSequence >= 0 ? savedSequence : 0) + 1;
    return { format: 2, revision: `${Date.now()}-${Math.random().toString(36).slice(2)}-${sequence}`,
        deleted: !key, ...(key ? { key: validateKey(key) } : {}) };
}
function commit(scope, provider, record, expected, isCurrent = () => true) {
    // Keep comparison/write/readback synchronous. This is a small localStorage
    // write, not an IndexedDB transaction or a cross-process storage lock.
    if (!isCurrent() || readRaw(scope, provider) !== expected) return false;
    const raw = JSON.stringify(record);
    try { storage().setItem(stampKey(provider), record.revision); storage().setItem(keyPrefix(provider) + scope, raw); }
    catch { throw storageError(); }
    if (readRaw(scope, provider) !== raw) throw storageError('changed');
    return true;
}
async function retireEncrypted(scope, provider) {
    if (provider === 'typesafe' && supportsEncryptedVault()) await deleteEncryptedRecord(scope);
}
export async function saveJevVaultRecord(scope, value, { isCurrent = () => true, provider = 'typesafe' } = {}) {
    const expected = readRaw(scope, provider);
    parseRecord(expected); // A corrupt existing record is never silently replaced.
    if (!commit(scope, provider, newRecord(value, provider), expected, isCurrent)) return false;
    // localStorage is authoritative after verification. A blocked legacy DB
    // cannot make new HTTP saves unusable; it remains dormant and is never read.
    try { await retireEncrypted(scope, provider); } catch { /* Retry cleanup on deletion. */ }
    return true;
}
export async function readJevVaultRecord(scope, provider = 'typesafe') {
    const expected = readRaw(scope, provider), current = parseRecord(expected);
    if (current) return current.deleted ? '' : current.key;
    if (provider !== 'typesafe' || !supportsEncryptedVault()) return '';
    // Decrypt only the current account's old record. Do not invent a key when
    // Web Crypto is unavailable: a first HTTP visit needs one manual entry.
    const key = await readEncryptedRecord(scope);
    const latest = parseRecord(readRaw(scope, provider));
    if (latest) return latest.deleted ? '' : latest.key;
    if (!key) return '';
    if (!commit(scope, provider, newRecord(key, provider), expected)) return readJevVaultRecord(scope, provider);
    try { await retireEncrypted(scope, provider); } catch { /* Verified local copy wins. */ }
    const verified = parseRecord(readRaw(scope, provider));
    return verified?.deleted ? '' : verified?.key || '';
}
export async function deleteJevVaultRecord(scope, provider = 'typesafe') {
    // A non-secret deletion marker prevents later migration from restoring an
    // old encrypted key. Unlike removing the item, this survives HTTP refresh.
    const expected = readRaw(scope, provider);
    if (!commit(scope, provider, newRecord('', provider), expected)) throw storageError('changed');
    await retireEncrypted(scope, provider);
}
