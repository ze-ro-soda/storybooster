// A local visibility lock for development tools, not server authorization.
// Never persist the submitted password or mix it with API credentials.
const PASSWORD = 'sb-debug';
const listeners = new Set();
let unlocked = false;
function notify() { for (const callback of listeners) { try { callback(); } catch { /* Optional UI only. */ } } }
export function isDeveloperModeUnlocked() { return unlocked; }
export function unlockDeveloperMode(value) {
    if (typeof value !== 'string' || value.trim() !== PASSWORD) return false;
    unlocked = true; notify(); return true;
}
export function lockDeveloperMode() { unlocked = false; notify(); }
export function onDeveloperModeChange(callback) { listeners.add(callback); return () => listeners.delete(callback); }
