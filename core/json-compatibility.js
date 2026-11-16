import { hashStableText } from './text.js';
const known = new Map();
const MAX_AGE = 30 * 60 * 1000;
export function clearJsonCompatibility() { known.clear(); }
export function jsonCompatibilityKey(connection, task, schema) {
    // Main connections without a reliable model/configuration identity are not
    // cached. Never guess a provider from a display name.
    if (connection?.source !== 'profile' || !connection.model || !connection.apiType || !connection.compatibilityRevision || !schema) return '';
    return hashStableText(JSON.stringify([connection.source, connection.profileId, connection.model,
        connection.apiType, connection.compatibilityRevision, task, schema]));
}
export function prefersPlainJson(key) {
    const until = known.get(key);
    if (!key || !until || until <= Date.now()) { known.delete(key); return false; }
    return true;
}
export function rememberPlainJson(key) {
    if (!key) return;
    known.delete(key); known.set(key, Date.now() + MAX_AGE);
    if (known.size > 64) known.delete(known.keys().next().value);
}
