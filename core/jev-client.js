// Jev transport: allowlisted provider destinations through SillyTavern's existing custom relay.
// The live key stays private to this module. User-approved plaintext browser
// storage is separate from extension settings, chat data and server secrets.
import { getContext } from './sillytavern.js';
import { recordCredentialEvent } from './audit-run-trace.js';
import { ensureModuleSettings } from './storage.js';
import { getJevProviderConfig, normalizeJevProvider } from './jev-providers.js';
import { supportsJevVault, serializeJevVault, resolveJevVaultScope, saveJevVaultRecord, readJevVaultRecord, deleteJevVaultRecord,
    jevStorageEventScope, jevStorageEventProvider, getJevStorageRevision, getJevStoredRecordState } from './jev-browser-store.js';

let activeProvider = 'typesafe';
const blockedProviders = new Set();
const STRIP = ['messages', 'prompt', 'stream', 'temperature', 'max_tokens',
    'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'top_p',
    'top_k', 'stop', 'logit_bias', 'seed', 'n', 'logprobs', 'top_logprobs',
    'tools', 'tool_choice', 'response_format', 'reasoning_effort', 'verbosity'];
let sessionKey = '';
let credentialScope = '';
let pendingCredentialScope = '';
let notificationScope = '';
const blockedRecordRevisions = new Map();
let keyChannel;
let storageListening = false;
let restoreTask = null;
let restoreBlocked = false;
let credentialState = 'unknown';
export const JEV_CONSENT_VERSION = 1;
let keyRevision = 0;
let status = '키 미입력 · 기존 진단 사용';
let connectionState = 'idle';
let requestSequence = 0;
const statusListeners = new Set();
const controllers = new Set();

export function getJevProviderId() { return normalizeJevProvider(ensureModuleSettings().jevProvider); }
function syncJevProvider() {
    const provider = getJevProviderId();
    if (provider !== activeProvider) {
        if (restoreBlocked) blockedProviders.add(activeProvider); else blockedProviders.delete(activeProvider);
        activeProvider = provider;
        // Queued old work still exits through its revision guard. Its finally
        // must not clear or restart a newer provider's restore task.
        restoreTask = null; pendingCredentialScope = ''; notificationScope = '';
        setJevSessionKey(''); restoreBlocked = blockedProviders.has(provider);
    }
    return provider;
}
export function setJevProvider(value) {
    getJevProviderConfig(value); // Reject unknown destinations before any mutation.
    ensureModuleSettings().jevProvider = value;
    syncJevProvider();
}

export function onJevConnectionChange(listener) {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
}
function updateStatus(text, state) {
    status = text; connectionState = state;
    for (const listener of statusListeners) { try { listener(); } catch { /* UI cannot fail an API request. */ } }
}
export function getJevCredentialState() { syncJevProvider(); return credentialState; }
export function getJevConnectionBadge(enabled) {
    syncJevProvider();
    if (!enabled) return { hidden: true, text: '', state: 'off' };
    if (credentialState === 'restoring') return { hidden: false, text: 'Jev 키 복원 중', state: 'setup' };
    if (!sessionKey) return { hidden: false, text: credentialState === 'error' ? 'Jev 키 복원 실패' : 'Jev 미연결', state: 'setup' };
    if (connectionState === 'error') return { hidden: false, text: 'Jev 연결 실패', state: 'setup' };
    if (connectionState === 'checking') return { hidden: false, text: 'Jev 확인 중', state: 'setup' };
    return { hidden: false, text: 'Jev 사용 준비됨', state: 'active' };
}

function validatedKey(value) {
    const key = String(value || '').trim();
    if (key.length > 512 || /[\x00-\x1f\x7f]/.test(key)) throw failure('STORYBOOSTER_JEV_KEY_FORMAT', 'Jev 키 형식을 확인해 주세요.');
    return key;
}
export function isJevUsageAllowed() {
    const settings = ensureModuleSettings();
    return settings.jevEnabled === true && settings.jevConsentVersion === JEV_CONSENT_VERSION;
}
function listenForKeyChanges() {
    if (!storageListening && typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('storage', event => {
            const scope = jevStorageEventScope(event.key);
            const provider = syncJevProvider();
            if (event.key !== null && (jevStorageEventProvider(event.key) !== provider || !scope || ![credentialScope, pendingCredentialScope, notificationScope].includes(scope))) return;
            // Read from storage afresh; never propagate event.newValue/key text.
            if (!canRestoreAfterKeyChange(scope || notificationScope, provider)) return;
            setJevSessionKey(''); restoreBlocked = false;
            recordCredentialEvent('tab_changed');
            void restoreJevKey();
        });
        storageListening = true;
    }
    if (keyChannel || typeof globalThis.BroadcastChannel !== 'function') return;
    try {
        keyChannel = new BroadcastChannel('storybooster-jev-credentials');
        keyChannel.onmessage = event => {
            const value = event.data;
            const scope = value?.provider === 'nanogpt' && typeof value.scope === 'string' && value.scope.startsWith('nanogpt:')
                ? value.scope.slice('nanogpt:'.length) : value?.scope;
            const provider = syncJevProvider();
            if (normalizeJevProvider(value?.provider) !== provider || !scope || ![credentialScope, pendingCredentialScope, notificationScope].includes(scope) || !['changed', 'deleted', 'disabled'].includes(value.action)) return;
            if (value.action === 'changed' && !canRestoreAfterKeyChange(scope, provider)) return;
            if (value.action === 'deleted') rememberBlockedKey(scope, provider);
            setJevSessionKey('');
            if (value.action === 'disabled') {
                const settings = ensureModuleSettings(); settings.jevEnabled = false; settings.jevConsentVersion = 0;
                recordCredentialEvent('disabled');
                updateStatus('다른 탭에서 Jev 사용을 해제했습니다.', 'idle');
            } else if (value.action === 'deleted') {
                restoreBlocked = true; credentialState = 'missing';
                recordCredentialEvent('tab_deleted');
                updateStatus('다른 탭에서 키를 삭제했습니다. 기존 진단 사용', 'idle');
            } else {
                restoreBlocked = false;
                recordCredentialEvent('tab_changed');
                if (restoreTask) { credentialState = 'restoring'; updateStatus('변경된 Jev 키 다시 불러오는 중', 'idle'); }
                void restoreJevKey();
            }
        };
    } catch { /* Storage still works without cross-tab notification. */ }
}
function rememberBlockedKey(scope, provider) {
    if (!scope) return;
    try { blockedRecordRevisions.set(`${provider}:${scope}`, getJevStoredRecordState(scope, provider)?.revision || ''); }
    catch { blockedRecordRevisions.set(`${provider}:${scope}`, null); }
}
function canRestoreAfterKeyChange(scope, provider) {
    if (!restoreBlocked) return true;
    // A notification alone cannot revive a key after deletion failed. Require
    // a different, committed, non-deleted record for the same account/provider.
    try {
        const blocked = blockedRecordRevisions.get(`${provider}:${scope}`);
        const current = scope ? getJevStoredRecordState(scope, provider) : null;
        if (blocked == null || !current || current.deleted || current.revision === blocked) return false;
        blockedRecordRevisions.delete(`${provider}:${scope}`);
        blockedProviders.delete(provider);
        return true;
    } catch { return false; }
}
function publishKeyChange(action, scope, provider = activeProvider) {
    try { if (scope) keyChannel?.postMessage({ action, scope: provider === 'nanogpt' ? `nanogpt:${scope}` : scope, provider }); }
    catch { /* Notification cannot turn a committed save into a reported failure. */ }
}
export function setJevUsageConsent(enabled) {
    syncJevProvider();
    const settings = ensureModuleSettings();
    settings.jevEnabled = enabled === true;
    settings.jevConsentVersion = enabled === true ? JEV_CONSENT_VERSION : 0;
    if (!enabled) {
        recordCredentialEvent('disabled');
        keyRevision++; cancelJevRequests();
        publishKeyChange('disabled', credentialScope);
        updateStatus('Jev 사용 해제 · 기존 진단 사용', 'idle');
    } else if (sessionKey) updateStatus('키 준비됨 · Jev 사용 준비됨', 'idle');
}
export function setJevSessionKey(value) {
    const key = validatedKey(value);
    activeProvider = getJevProviderId();
    cancelJevRequests();
    sessionKey = key; credentialScope = '';
    credentialState = key ? 'ready' : 'unknown';
    if (key) restoreBlocked = false;
    keyRevision++;
    updateStatus(key ? '키 입력됨 · Jev 사용 준비됨' : '키 미입력 · 기존 진단 사용', 'idle');
}
export function restoreJevKey() {
    const provider = syncJevProvider();
    if (restoreTask) return restoreTask;
    if (!isJevUsageAllowed() || restoreBlocked) return Promise.resolve(false);
    if (!supportsJevVault()) {
        credentialState = 'error'; recordCredentialEvent('unsupported', 'unsupported');
        updateStatus('이 브라우저에서는 키 저장소를 사용할 수 없습니다. 사이트 저장소 설정을 확인해 주세요.', 'error');
        return Promise.resolve(false);
    }
    const revision = keyRevision;
    credentialState = 'restoring'; recordCredentialEvent('restore_started');
    updateStatus('저장된 Jev 키 불러오는 중', 'idle');
    const work = serializeJevVault(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (revision !== keyRevision || provider !== getJevProviderId() || !isJevUsageAllowed() || restoreBlocked) return false;
            try {
                const scope = await resolveJevVaultScope();
                if (revision !== keyRevision || provider !== getJevProviderId()) return false;
                pendingCredentialScope = scope; notificationScope = scope; listenForKeyChanges();
                let key;
                try { key = validatedKey(await readJevVaultRecord(scope, provider)); }
                finally { pendingCredentialScope = ''; }
                if (revision !== keyRevision || provider !== getJevProviderId() || !isJevUsageAllowed() || restoreBlocked) return false;
                sessionKey = key; credentialScope = key ? scope : ''; keyRevision++;
                credentialState = key ? 'ready' : 'missing';
                recordCredentialEvent(key ? 'restored' : 'missing');
                updateStatus(key ? '저장된 키 복원됨 · Jev 사용 준비됨' : '저장된 키 없음 · 기존 진단 사용', 'idle');
                return Boolean(key);
            } catch (error) {
                if (revision !== keyRevision || provider !== getJevProviderId() || !isJevUsageAllowed() || restoreBlocked) return false;
                if (!attempt && error.vaultReason !== 'decrypt') { recordCredentialEvent('restore_retry', error.vaultReason || 'unknown'); continue; }
                credentialState = 'error'; recordCredentialEvent('restore_failed', error.vaultReason || 'unknown');
                updateStatus('저장된 키 복원 실패 · 저장본은 유지됩니다. 연결 확인으로 다시 시도해 주세요.', 'error');
                return false;
            }
        }
        return false;
    });
    const tracked = work.finally(() => {
        if (restoreTask === tracked) {
            restoreTask = null;
            // A save or cross-tab replacement superseded this restore.
            // Wait for its queued work before resolving the latest saved key.
            if (credentialState === 'restoring' && isJevUsageAllowed() && !restoreBlocked) {
                credentialState = 'unknown';
                void restoreJevKey();
            }
        }
    });
    restoreTask = tracked;
    return tracked;
}
export async function ensureJevKeyReady() {
    syncJevProvider();
    if (!isJevUsageAllowed()) return false;
    if (restoreTask) await restoreTask;
    if (restoreTask) await restoreTask;
    if (sessionKey) return true;
    if (restoreBlocked) return false;
    return await restoreJevKey();
}
export async function saveJevKey(value) {
    const provider = syncJevProvider();
    let key;
    try { key = validatedKey(value); }
    catch (error) { updateStatus(error.message, 'error'); throw error; }
    if (!key) throw failure('STORYBOOSTER_JEV_KEY_MISSING', '저장할 Jev 키를 입력해 주세요.');
    if (!isJevUsageAllowed()) {
        updateStatus('안내에 동의하고 Jev 사용을 체크해 주세요.', 'idle');
        throw failure('STORYBOOSTER_JEV_CONSENT_REQUIRED', '안내에 동의하고 Jev 사용을 체크해 주세요.');
    }
    let storageRevision;
    try { storageRevision = getJevStorageRevision(provider); }
    catch (error) {
        recordCredentialEvent('save_failed', 'storage');
        updateStatus(error.message, 'error');
        throw error;
    }
    restoreBlocked = false; recordCredentialEvent('save_started');
    cancelJevRequests(); const revision = ++keyRevision;
    updateStatus('키 브라우저 저장 중', 'checking');
    try {
        return await serializeJevVault(async () => {
            const scope = await resolveJevVaultScope();
            if (revision !== keyRevision || provider !== getJevProviderId() || !isJevUsageAllowed()) throw failure('STORYBOOSTER_JEV_CANCELLED', 'Jev 키 저장이 취소되었습니다.');
            pendingCredentialScope = scope; notificationScope = scope; listenForKeyChanges();
            let committed;
            try { committed = await saveJevVaultRecord(scope, key, { provider, isCurrent: () => revision === keyRevision && provider === getJevProviderId() && isJevUsageAllowed() && getJevStorageRevision(provider) === storageRevision }); }
            finally { pendingCredentialScope = ''; }
            if (!committed) {
                if (revision === keyRevision && provider === getJevProviderId()) {
                    setJevSessionKey('');
                    updateStatus('저장 중 다른 탭에서 키가 변경되거나 삭제됐습니다. 키를 다시 확인해 주세요.', 'idle');
                }
                return false;
            }
            if (revision !== keyRevision || provider !== getJevProviderId() || !isJevUsageAllowed()) return false;
            const verified = validatedKey(await readJevVaultRecord(scope, provider));
            if (revision !== keyRevision || provider !== getJevProviderId() || !isJevUsageAllowed()) return false;
            if (verified !== key) {
                setJevSessionKey('');
                credentialState = verified ? 'unknown' : 'missing';
                updateStatus('저장 확인 중 키가 변경됐습니다. 연결 확인으로 다시 확인해 주세요.', 'error');
                recordCredentialEvent('save_failed', 'changed');
                return false;
            }
            sessionKey = key; credentialScope = scope; credentialState = 'ready';
            recordCredentialEvent('save_verified');
            listenForKeyChanges(); publishKeyChange('changed', scope, provider);
            updateStatus('키 브라우저 저장됨 · Jev 사용 준비됨', 'idle');
            return true;
        });
    } catch (error) {
        if (revision !== keyRevision || provider !== getJevProviderId() || error.code === 'STORYBOOSTER_JEV_CANCELLED') return false;
        recordCredentialEvent('save_failed', error.vaultReason || 'unknown');
        const message = error.code === 'STORYBOOSTER_JEV_STORAGE_ERROR' ? error.message : 'Jev 키를 저장하지 못했습니다. 기존 저장본은 유지됩니다.';
        if (revision === keyRevision && provider === getJevProviderId()) updateStatus(message, 'error');
        throw failure('STORYBOOSTER_JEV_STORAGE_ERROR', message);
    }
}
export async function deleteJevKey() {
    const provider = syncJevProvider();
    const oldScope = credentialScope || notificationScope;
    rememberBlockedKey(oldScope, provider);
    setJevSessionKey(''); restoreBlocked = true; credentialState = 'missing'; publishKeyChange('deleted', oldScope, provider);
    const revision = keyRevision;
    try {
        await serializeJevVault(async () => {
            const scope = await resolveJevVaultScope();
            rememberBlockedKey(scope, provider);
            if (provider === getJevProviderId()) notificationScope = scope;
            await deleteJevVaultRecord(scope, provider);
            listenForKeyChanges(); publishKeyChange('deleted', scope, provider);
        });
        recordCredentialEvent('deleted');
        if (revision === keyRevision && provider === getJevProviderId()) updateStatus('키 삭제됨 · 기존 진단 사용', 'idle');
    } catch {
        recordCredentialEvent('delete_failed', 'storage');
        const message = '현재 키 사용은 중단됐지만 저장본 삭제에 실패했습니다. 키 삭제를 다시 시도해 주세요.';
        if (revision === keyRevision && provider === getJevProviderId()) updateStatus(message, 'error');
        throw failure('STORYBOOSTER_JEV_STORAGE_ERROR', message);
    }
}
export function hasJevSessionKey() { syncJevProvider(); return Boolean(sessionKey); }
export function getJevKeyRevision() { syncJevProvider(); return keyRevision; }
export function getJevConnectionStatus() { syncJevProvider(); return status; }
export function cancelJevRequests() { for (const c of controllers) c.abort(); }

function failure(code, message, httpStatus) {
    const error = new Error(message);
    error.code = code;
    error.stage = 'jev_connection';
    if (httpStatus) error.status = httpStatus;
    return error;
}

export function validateJevAnswers(result, questions) {
    if (!result || !result.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) {
        throw failure('STORYBOOSTER_JEV_INVALID_RESPONSE', 'Jev 응답에 판정 결과가 없습니다.');
    }
    for (const [id, q] of Object.entries(questions)) {
        const answer = result.answers[id];
        if (!answer || answer.type !== q.type) throw failure('STORYBOOSTER_JEV_INVALID_RESPONSE', 'Jev 응답의 판정 항목이 누락되거나 형식이 다릅니다.');
        if (q.type === 'choice') {
            const options = Object.keys(q.criteria);
            const p = answer.probabilities;
            if (!options.includes(answer.choice) || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 || !p ||
                options.some(k => !Number.isFinite(p[k]) || p[k] < 0 || p[k] > 1) ||
                Object.keys(p).some(k => !options.includes(k)) ||
                Math.abs(options.reduce((sum, k) => sum + p[k], 0) - 1) > 0.02 ||
                options.some(k => p[k] > p[answer.choice] + 0.001)) {
                throw failure('STORYBOOSTER_JEV_INVALID_RESPONSE', 'Jev 선택값이나 확률 분포가 올바르지 않습니다.');
            }
        } else if (q.type === 'noul' && (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)) {
            throw failure('STORYBOOSTER_JEV_INVALID_RESPONSE', 'Jev 판정값 범위가 올바르지 않습니다.');
        }
    }
    return result.answers;
}

export async function requestJev(state, questions, { timeoutMs = 25000, signal } = {}) {
    const provider = syncJevProvider();
    const config = getJevProviderConfig(provider);
    if (!isJevUsageAllowed()) {
        updateStatus('안내에 동의하고 Jev 사용을 체크해 주세요.', 'idle');
        throw failure('STORYBOOSTER_JEV_CONSENT_REQUIRED', '안내에 동의하고 Jev 사용을 체크해 주세요.');
    }
    if (!sessionKey) throw failure('STORYBOOSTER_JEV_KEY_MISSING', 'Jev 키가 입력되지 않았습니다.');
    const requestHeaders = getContext()?.getRequestHeaders?.();
    if (!requestHeaders) throw failure('STORYBOOSTER_JEV_RELAY_UNAVAILABLE', 'SillyTavern 기본 중계 요청 헤더를 사용할 수 없습니다.');
    const revision = keyRevision;
    const sequence = ++requestSequence;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
        if (credentialScope) {
            const scope = await resolveJevVaultScope(controller.signal);
            if (scope !== credentialScope) {
                setJevSessionKey('');
                updateStatus('현재 계정에 저장된 Jev 키를 다시 확인해 주세요.', 'idle');
                throw failure('STORYBOOSTER_JEV_CANCELLED', 'SillyTavern 계정이 변경되었습니다.');
            }
            // Check persistent deletion/replacement even when this browser
            // cannot deliver cross-tab notifications. Never send a stale key.
            const storedKey = await readJevVaultRecord(scope, provider);
            if (revision !== keyRevision || provider !== getJevProviderId() || controller.signal.aborted) throw failure('STORYBOOSTER_JEV_CANCELLED', 'Jev 요청이 취소되었습니다.');
            if (!storedKey || storedKey !== sessionKey) {
                setJevSessionKey('');
                updateStatus('저장된 Jev 키가 변경되거나 삭제됐습니다. 키를 다시 확인해 주세요.', 'idle');
                throw failure('STORYBOOSTER_JEV_CANCELLED', '저장된 Jev 키가 변경되었습니다.');
            }
        }
        if (revision !== keyRevision || provider !== getJevProviderId() || !isJevUsageAllowed() || controller.signal.aborted) throw failure('STORYBOOSTER_JEV_CANCELLED', 'Jev 요청이 취소되었습니다.');
        updateStatus('Jev 요청 중', 'checking');
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST', credentials: 'same-origin',
            headers: { ...requestHeaders, 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                chat_completion_source: 'custom',
                // ST appends /chat/completions; absorb that suffix in a query.
                custom_url: `${config.endpoint}?via=`, model: config.model,
                messages: [{ role: 'user', content: '.' }], stream: false,
                custom_include_body: JSON.stringify({ state, questions }),
                custom_exclude_body: JSON.stringify(STRIP),
                custom_include_headers: JSON.stringify({ Authorization: `Bearer ${sessionKey}` }),
            }),
        });
        let result;
        try { result = await response.json(); } catch {
            if (response.ok) throw failure('STORYBOOSTER_JEV_INVALID_RESPONSE', 'Jev 중계 응답을 읽지 못했습니다.');
        }
        // Recognize only fixed codes. Upstream messages/values can contain
        // private request data and are never put in status or exported logs.
        if (['context_length_exceeded', 'too_many_questions', 'request_body_too_large'].includes(result?.error?.code)) {
            throw failure('STORYBOOSTER_JEV_INPUT_LIMIT', 'Jev 제공자의 입력 한도를 초과했습니다.', response.status);
        }
        if (!response.ok) throw failure('STORYBOOSTER_JEV_HTTP_ERROR', `Jev 중계 요청에 실패했습니다 (HTTP ${response.status}).`, response.status);
        if (result?.error) throw failure('STORYBOOSTER_JEV_UPSTREAM_ERROR', 'Jev가 요청을 처리하지 못했습니다. 키·요청 한도·연결 상태를 확인해 주세요.');
        if (revision !== keyRevision || provider !== getJevProviderId() || controller.signal.aborted) throw failure('STORYBOOSTER_JEV_CANCELLED', 'Jev 요청이 취소되었습니다.');
        validateJevAnswers(result, questions);
        if (sequence === requestSequence) updateStatus(`Jev 연결 정상 · ${config.label}`, 'connected');
        return result;
    } catch (error) {
        const safeError = timedOut ? failure('STORYBOOSTER_JEV_TIMEOUT', 'Jev 응답 시간이 초과되었습니다.')
            : controller.signal.aborted ? failure('STORYBOOSTER_JEV_CANCELLED', 'Jev 요청이 취소되었습니다.')
            : String(error?.code || '').startsWith('STORYBOOSTER_JEV_') ? error
            : failure('STORYBOOSTER_JEV_NETWORK_ERROR', 'Jev 중계 연결에 실패했습니다.');
        if (revision === keyRevision && provider === getJevProviderId() && sequence === requestSequence) updateStatus(`${safeError.message} · 기존 진단 사용`, 'error');
        throw safeError;
    } finally {
        clearTimeout(timer); controllers.delete(controller);
        signal?.removeEventListener('abort', abort);
    }
}

export async function testJevConnection() {
    await ensureJevKeyReady();
    const result = await requestJev({ purpose: 'connection_test', text: 'A blue circle.' }, {
        connection_test: { type: 'noul', instructions: 'Does the text describe a circle?' },
    });
    return result.answers.connection_test.noul;
}
