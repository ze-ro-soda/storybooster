// Changes remain visible immediately; notifications are coalesced separately.
// Keep Window timer receivers intact when invoking the injected timer adapter.
export function createCharacterNoticeController({ status, records, save, notify, delay = 3000, timers = { set: (callback, ms) => globalThis.setTimeout(callback, ms), clear: id => globalThis.clearTimeout(id) } }) {
    const waiting = new Map();
    function clearTimer(key) { const job = waiting.get(key); if (job) timers.clear(job.timer); waiting.delete(key); }
    function acknowledge(key, hash = '') {
        clearTimer(key);
        if (hash) records()[key] = { savedHash: hash, notified: false, resolved: true };
        else delete records()[key];
        save();
    }
    function observe({ edited = false } = {}) {
        const current = status(), key = current.identity?.key;
        for (const other of waiting.keys()) if (other !== key) clearTimer(other);
        if (!key) return current;
        const all = records(); let previous = all[key], freshEpisode = false;
        if (!current.changed) {
            clearTimer(key);
            // Reverting the card closes this episode. Switching to a different
            // baseline version alone must not forget an unresolved notification.
            if (previous && !previous.resolved && current.currentHash === previous.savedHash) acknowledge(key, current.currentHash);
            return current;
        }
        if (previous?.resolved) {
            if (current.currentHash === previous.savedHash) return current;
            all[key] = { savedHash: previous.savedHash, notified: false, silent: !edited }; previous = all[key]; save();
            freshEpisode = true;
        }
        if (!previous) {
            all[key] = { savedHash: current.baseline.sourceHash, notified: Boolean(current.baseline.notifiedSourceHash), silent: !edited };
            freshEpisode = true;
            save();
        }
        if (all[key].notified || all[key].silent) { clearTimer(key); return current; }
        // Passive discovery on reopen/chat switch/reload must never schedule
        // a belated toast. An interrupted timer is not revived by a later edit.
        if (waiting.has(key)) return current;
        if (!edited || !freshEpisode) { all[key].silent = true; save(); return current; }
        const timer = timers.set(() => {
            waiting.delete(key);
            const fresh = status(), record = records()[key];
            if (fresh.identity?.key !== key || !record || record.notified || record.silent) return;
            if (fresh.currentHash === record.savedHash) { acknowledge(key, fresh.currentHash); return; }
            if (!fresh.changed) return;
            record.notified = true; save(); notify(fresh);
        }, delay);
        timer?.unref?.(); waiting.set(key, { timer }); return current;
    }
    return { observe, acknowledge };
}
