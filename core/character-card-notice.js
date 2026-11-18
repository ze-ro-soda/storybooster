// Changes remain visible immediately; notifications are coalesced separately.
// Keep Window timer receivers intact when invoking the injected timer adapter.
export function createCharacterNoticeController({ status, records, save, notify, delay = 30000, timers = { set: (callback, ms) => globalThis.setTimeout(callback, ms), clear: id => globalThis.clearTimeout(id) } }) {
    const waiting = new Map();
    function clearTimer(key) { timers.clear(waiting.get(key)?.timer); waiting.delete(key); }
    function acknowledge(key, hash = '') {
        clearTimer(key);
        if (hash) records()[key] = { savedHash: hash, notified: false, resolved: true };
        else delete records()[key];
        save();
    }
    function observe() {
        const current = status(), key = current.identity?.key;
        for (const other of waiting.keys()) if (other !== key) clearTimer(other);
        if (!key) return current;
        const all = records(); let previous = all[key];
        if (!current.changed) {
            clearTimer(key);
            // Reverting the card closes this episode. Switching to a different
            // baseline version alone must not forget an unresolved notification.
            if (previous && !previous.resolved && current.currentHash === previous.savedHash) acknowledge(key, current.currentHash);
            return current;
        }
        if (previous?.resolved) {
            if (current.currentHash === previous.savedHash) return current;
            all[key] = { savedHash: previous.savedHash, notified: false }; previous = all[key]; save();
        }
        if (!previous) {
            all[key] = { savedHash: current.baseline.sourceHash, notified: Boolean(current.baseline.notifiedSourceHash) };
            save();
        }
        if (all[key].notified) { clearTimer(key); return current; }
        if (waiting.get(key)?.hash === current.currentHash) return current;
        clearTimer(key);
        const hash = current.currentHash;
        const timer = timers.set(() => {
            waiting.delete(key);
            const fresh = status(), record = records()[key];
            if (fresh.identity?.key !== key || !fresh.changed || fresh.currentHash !== hash || !record || record.notified) return;
            record.notified = true; save(); notify(fresh);
        }, delay);
        timer?.unref?.(); waiting.set(key, { timer, hash }); return current;
    }
    return { observe, acknowledge };
}
